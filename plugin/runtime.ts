/**
 * Persistent, polyglot script interpreter runtime.
 *
 * One long-lived child process per (session, language). Code is sent as a
 * length-prefixed frame over stdin; the interpreter harness evaluates it in a
 * persistent scope and writes a marker line back on stdout.
 *
 *   plugin -> process:  "<byteLength>\n" + <code bytes>
 *   process -> plugin:  <user stdout/stderr> ... "\0@@EVAL:<nonce>:<status>\n"
 *
 * status is "ok", "error" or "exit". The process stays alive between frames, so
 * variables, imports and side effects persist across calls. The protocol is
 * language-agnostic: a backend only has to ship a ~20-line harness.
 *
 * Zero dependencies beyond the Node/Bun standard library.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"

export type EvalStatus = "ok" | "error" | "exit" | "timeout" | "cancelled"

export interface EvalResult {
  status: EvalStatus
  stdout: string
  stderr: string
  durationMs: number
  exitCode?: number | null
  exitSignal?: string | null
}

export interface Backend {
  /** Executable to spawn. */
  command: string
  /** Arguments; the harness is embedded here. */
  args: string[]
  /** Human label, defaults to the language key. */
  label?: string
  /** Code executed once when the interpreter starts (imports, helpers). */
  prelude?: string
  /** Extra environment variables for the interpreter. */
  env?: Record<string, string>
  /** Marker prefix; must match the harness. Defaults to NUL-prefixed. */
  markerPrefix?: string
}

export interface InterpreterOptions {
  /** Per-cell timeout in ms. Default 60s. */
  timeoutMs?: number
  /** Grace period used to drain stderr after the marker arrives. Default 25ms. */
  drainMs?: number
  /** Working directory for the interpreter. */
  cwd?: string
  /** Extra environment variables. */
  env?: Record<string, string>
}

const DEFAULT_MARKER_PREFIX = "\u0000@@EVAL:"

/* ------------------------------------------------------------------ *
 * Harnesses. Each reads length-prefixed frames from stdin, evaluates
 * them in a persistent scope, and writes the marker to stdout.
 * ------------------------------------------------------------------ */

const PY_HARNESS = String.raw`
import os, sys, traceback
_n = os.environ.get("EVAL_NONCE", "0")
_m = ("\x00@@EVAL:" + _n + ":").encode()
_in = sys.stdin.buffer
_out = sys.stdout.buffer
_G = {"__name__": "__main__"}
while True:
    _l = _in.readline()
    if not _l:
        break
    try:
        _k = int(_l)
    except ValueError:
        continue
    _src = _in.read(_k).decode("utf-8", "replace")
    try:
        exec(compile(_src, "<eval>", "exec"), _G)
        _s = "ok"
    except SystemExit:
        _s = "exit"
    except BaseException:
        traceback.print_exc()
        _s = "error"
    try:
        sys.stdout.flush()
    except Exception:
        pass
    _out.write(_m + _s.encode() + b"\n")
    _out.flush()
`.trim()

const JS_HARNESS = String.raw`
const vm = require("node:vm");
const nonce = process.env.EVAL_NONCE || "0";
const MARK = "\u0000@@EVAL:" + nonce + ":";
const g = globalThis;
const sandbox = {
  console, process, Buffer, require,
  module: { exports: {} }, exports: {},
  setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  fetch, Response, Request, Headers, FormData, AbortController, AbortSignal, Blob,
  structuredClone, atob, btoa, performance,
  crypto: g.crypto, __dirname: process.cwd(), __filename: "<eval>",
};
const ctx = vm.createContext(sandbox);
let buf = Buffer.alloc(0);
let need = -1;
let chain = Promise.resolve();
async function run(src) {
  let st = "ok";
  try {
    let wrap = false;
    try {
      new vm.Script(src, { filename: "<eval>" });
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/await is only|Cannot use import statement|Unexpected token 'export'/.test(m)) wrap = true;
      else throw e;
    }
    if (wrap) await vm.runInContext("(async () => {\n" + src + "\n})()", ctx, { filename: "<eval>" });
    else vm.runInContext(src, ctx, { filename: "<eval>" });
  } catch (e) {
    process.stderr.write((e && e.stack ? e.stack : String(e)) + "\n");
    st = "error";
  }
  process.stdout.write(MARK + st + "\n");
}
function pump() {
  for (;;) {
    if (need < 0) {
      const i = buf.indexOf(10);
      if (i < 0) return;
      need = parseInt(buf.subarray(0, i).toString("utf8"), 10);
      buf = buf.subarray(i + 1);
      if (!Number.isFinite(need) || need < 0) { need = -1; continue; }
    }
    if (buf.length < need) return;
    const src = buf.subarray(0, need).toString("utf8");
    buf = buf.subarray(need);
    need = -1;
    chain = chain.then(() => run(src));
  }
}
process.stdin.on("data", (c) => { buf = Buffer.concat([buf, c]); pump(); });
`.trim()

const RUBY_HARNESS = String.raw`
nonce = ENV["EVAL_NONCE"] || "0"
marker = "\u0000@@EVAL:#{nonce}:"
$stdout.sync = true
while (line = STDIN.gets)
  n = line.to_i
  src = STDIN.read(n) || ""
  st = "ok"
  begin
    eval(src, TOPLEVEL_BINDING, "<eval>")
  rescue SystemExit
    st = "exit"
  rescue Exception => e
    $stderr.puts "#{e.class}: #{e.message}"
    $stderr.puts e.backtrace if e.backtrace
    st = "error"
  end
  $stdout.print marker + st + "\n"
  $stdout.flush
end
`.trim()

const LUA_HARNESS = String.raw`
local nonce = os.getenv("EVAL_NONCE") or "0"
local marker = "\0@@EVAL:" .. nonce .. ":"
io.stdout:setvbuf("no")
local function readn(k)
  local parts, got = {}, 0
  while got < k do
    local d = io.stdin:read(k - got)
    if not d then break end
    parts[#parts + 1] = d
    got = got + #d
  end
  return table.concat(parts)
end
while true do
  local line = io.stdin:read("*l")
  if not line then break end
  local n = tonumber(line)
  if n then
    local src = readn(n)
    local fn, ferr = load(src, "<eval>")
    local st = "ok"
    if not fn then
      io.stderr:write(tostring(ferr) .. "\n")
      st = "error"
    else
      local ok, rerr = pcall(fn)
      if not ok then
        io.stderr:write(tostring(rerr) .. "\n")
        st = "error"
      end
    end
    io.stdout:write(marker .. st .. "\n")
    io.stdout:flush()
  end
end
`.trim()

// R strings cannot contain NUL, so the R backend uses a 0x01 prefix.
const R_MARKER_PREFIX = "\u0001@@EVAL:"
const R_HARNESS = String.raw`
nonce <- Sys.getenv("EVAL_NONCE", unset = "0")
marker <- paste0("\001@@EVAL:", nonce, ":")
con <- file("stdin", "rb")
repeat {
  line <- readLines(con, n = 1L, warn = FALSE)
  if (length(line) == 0L) break
  n <- suppressWarnings(as.integer(line))
  if (is.na(n)) next
  raw <- readBin(con, "raw", n = n)
  src <- rawToChar(raw)
  st <- "ok"
  tryCatch(
    eval(parse(text = src), envir = globalenv()),
    error = function(e) {
      cat(conditionMessage(e), "\n", file = stderr(), sep = "")
      st <<- "error"
    }
  )
  cat(marker, st, "\n", sep = "")
  flush(stdout())
}
`.trim()

/* ------------------------------------------------------------------ *
 * Backends
 * ------------------------------------------------------------------ */

export const BACKENDS: Record<string, Backend> = {
  python: { command: "python3", args: ["-u", "-c", PY_HARNESS], label: "python" },
  node: { command: "node", args: ["--no-warnings", "-e", JS_HARNESS], label: "node" },
  bun: { command: "bun", args: ["-e", JS_HARNESS], label: "bun" },
  ruby: { command: "ruby", args: ["-e", RUBY_HARNESS], label: "ruby" },
  lua: { command: "lua", args: ["-e", LUA_HARNESS], label: "lua" },
  r: { command: "Rscript", args: ["--vanilla", "-e", R_HARNESS], label: "R", markerPrefix: R_MARKER_PREFIX },
}

export const LANGUAGE_ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  python: "python",
  js: "node",
  javascript: "node",
  nodejs: "node",
  node: "node",
  ts: "bun",
  typescript: "bun",
  bun: "bun",
  rb: "ruby",
  ruby: "ruby",
  lua: "lua",
  r: "r",
  rlang: "r",
}

/* ------------------------------------------------------------------ *
 * Interpreter
 * ------------------------------------------------------------------ */

interface Pending {
  resolve: (r: EvalResult) => void
  startedAt: number
  settled: boolean
  timer: NodeJS.Timeout | undefined
}

export class Interpreter {
  private proc?: ChildProcessWithoutNullStreams
  private readonly nonce = randomBytes(8).toString("hex")
  private readonly marker: Buffer
  private outBuf = Buffer.alloc(0)
  private errChunks: Buffer[] = []
  private pending?: Pending
  private chain: Promise<unknown> = Promise.resolve()
  private stopped = false
  private readonly timeoutMs: number
  private readonly drainMs: number

  constructor(
    readonly language: string,
    private readonly backend: Backend,
    private readonly options: InterpreterOptions = {},
  ) {
    const prefix = backend.markerPrefix ?? DEFAULT_MARKER_PREFIX
    this.marker = Buffer.from(`${prefix}${this.nonce}:`, "utf8")
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.drainMs = options.drainMs ?? 25
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.stopped
  }

  /** Start the interpreter if it is not already running. */
  async start(): Promise<void> {
    if (this.running) return
    if (this.stopped) throw new Error("interpreter has been disposed")

    const env = { ...process.env, ...this.backend.env, ...this.options.env, EVAL_NONCE: this.nonce }
    const proc = spawn(this.backend.command, this.backend.args, {
      cwd: this.options.cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.proc = proc
    this.outBuf = Buffer.alloc(0)
    this.errChunks = []
    proc.stdout.on("data", (d: Buffer) => this.onStdout(d))
    proc.stderr.on("data", (d: Buffer) => this.errChunks.push(d))
    proc.on("exit", (code, signal) => this.onExit(proc, code, signal))
    proc.on("error", (err) => {
      if (this.proc !== proc) return
      this.proc = undefined
      const p = this.pending
      if (p && !p.settled) this.settle(p, { status: "exit", stderr: `interpreter error: ${err.message}` })
    })

    await new Promise<void>((resolve, reject) => {
      proc.once("spawn", () => resolve())
      proc.once("error", (err) => reject(new Error(`failed to spawn "${this.backend.command}": ${err.message}`)))
    })

    if (this.backend.prelude) {
      const r = await this.run(this.backend.prelude)
      if (r.status !== "ok") {
        const detail = r.stderr || r.stdout || "prelude failed"
        this.dispose()
        throw new Error(`prelude failed for ${this.language}: ${detail.trim()}`)
      }
    }
  }

  /** Run one cell. Calls are serialised per interpreter. */
  run(code: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<EvalResult> {
    const next = this.chain.then(() => this.exec(code, opts))
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** Kill the interpreter; the next run starts a fresh one. */
  reset(): void {
    this.kill()
  }

  /** Kill the interpreter and refuse further runs. */
  dispose(): void {
    this.stopped = true
    this.kill()
  }

  private async exec(code: string, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<EvalResult> {
    await this.start()
    const proc = this.proc
    if (!proc) throw new Error(`${this.language} interpreter is not running`)

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs
    const payload = Buffer.from(code, "utf8")
    const startedAt = Date.now()

    return new Promise<EvalResult>((resolve) => {
      const p: Pending = { resolve, startedAt, settled: false, timer: undefined }

      const stop = (status: EvalStatus) => {
        // Settle first: it marks the promise handled synchronously, so the
        // kill below (and the resulting exit event) cannot double-resolve it.
        this.settle(p, { status, stdout: this.takeOut() })
        this.kill()
      }

      p.timer = setTimeout(() => stop("timeout"), timeoutMs)
      if (opts.signal) {
        if (opts.signal.aborted) return stop("cancelled")
        opts.signal.addEventListener("abort", () => stop("cancelled"), { once: true })
      }

      this.pending = p
      this.errChunks = []
      try {
        proc.stdin.write(`${payload.length}\n`)
        proc.stdin.write(payload)
      } catch (err) {
        this.settle(p, { status: "exit", stderr: `failed to write to interpreter: ${(err as Error).message}` })
      }
    })
  }

  private onStdout(chunk: Buffer): void {
    this.outBuf = Buffer.concat([this.outBuf, chunk])
    for (;;) {
      const at = this.outBuf.indexOf(this.marker)
      if (at < 0) break
      const end = this.outBuf.indexOf(10, at + this.marker.length)
      if (end < 0) break
      const stdout = this.outBuf.subarray(0, at).toString("utf8")
      const status = this.outBuf.subarray(at + this.marker.length, end).toString("utf8").trim() as EvalStatus
      this.outBuf = this.outBuf.subarray(end + 1)
      const p = this.pending
      if (p && !p.settled) this.settle(p, { status, stdout })
    }
  }

  private onExit(proc: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    // Ignore the exit of an interpreter we already discarded: otherwise a
    // stale exit event would settle the next run's promise.
    if (this.proc !== proc) return
    this.proc = undefined
    const p = this.pending
    if (p && !p.settled) this.settle(p, { status: "exit", exitCode: code, exitSignal: signal })
  }

  private settle(p: Pending, base: Partial<EvalResult> & { status: EvalStatus }): void {
    if (p.settled) return
    p.settled = true
    if (p.timer) clearTimeout(p.timer)
    if (this.pending === p) this.pending = undefined
    setTimeout(() => {
      const stderr = Buffer.concat(this.errChunks).toString("utf8")
      this.errChunks = []
      const extra = base.stderr ? [stderr, base.stderr].filter((s) => s && s.length > 0).join("\n") : stderr
      p.resolve({
        status: base.status,
        stdout: base.stdout ?? "",
        stderr: extra,
        durationMs: Date.now() - p.startedAt,
        exitCode: base.exitCode,
        exitSignal: base.exitSignal,
      })
    }, this.drainMs)
  }

  private takeOut(): string {
    const s = this.outBuf.toString("utf8")
    this.outBuf = Buffer.alloc(0)
    return s
  }

  private kill(): void {
    const p = this.pending
    if (p && !p.settled) this.settle(p, { status: "cancelled", stdout: this.takeOut() })
    const proc = this.proc
    this.proc = undefined
    this.outBuf = Buffer.alloc(0)
    if (!proc || proc.exitCode !== null) return
    try {
      proc.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      proc.kill("SIGKILL")
    } catch {
      /* ignore */
    }
  }
}
