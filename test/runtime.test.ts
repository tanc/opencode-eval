import { afterAll, describe, expect, test } from "bun:test"
import { BACKENDS, Interpreter } from "../plugin/runtime.ts"

const live: Interpreter[] = []
function mk(language: string, options: Record<string, unknown> = {}): Interpreter {
  const interp = new Interpreter(language, BACKENDS[language], { timeoutMs: 5000, drainMs: 10, ...options })
  live.push(interp)
  return interp
}

afterAll(() => {
  for (const interp of live) interp.dispose()
})

describe("python backend", () => {
  test("persists state across calls", async () => {
    const py = mk("python")
    expect((await py.run("x = 41")).status).toBe("ok")
    const r = await py.run("x += 1\nprint(x)")
    expect(r.status).toBe("ok")
    expect(r.stdout.trim()).toBe("42")
  })

  test("imports persist", async () => {
    const py = mk("python")
    await py.run("import json")
    const r = await py.run('print(json.dumps({"a": 1}))')
    expect(r.stdout.trim()).toBe('{"a": 1}')
  })

  test("errors carry status and traceback", async () => {
    const py = mk("python")
    const r = await py.run("raise ValueError('boom')")
    expect(r.status).toBe("error")
    expect(r.stderr).toContain("ValueError: boom")
  })

  test("multi-line cells are atomic", async () => {
    const py = mk("python")
    const r = await py.run("def f(n):\n    return n * 2\nprint(f(21))")
    expect(r.stdout.trim()).toBe("42")
  })

  test("unicode round-trips (byte-length framing)", async () => {
    const py = mk("python")
    const r = await py.run("print('héllo — 世界 🎉')")
    expect(r.stdout).toContain("héllo — 世界 🎉")
  })

  test("sys.exit reports exit and keeps prior stdout", async () => {
    const py = mk("python")
    const r = await py.run("print('bye')\nimport sys\nsys.exit(3)")
    expect(r.status).toBe("exit")
    expect(r.stdout.trim()).toBe("bye")
  })
})

describe("node backend", () => {
  test("persists let/const across calls", async () => {
    const js = mk("node")
    await js.run("const base = 40; let n = base;")
    const r = await js.run("n += 2; console.log(n)")
    expect(r.stdout.trim()).toBe("42")
  })

  test("top-level await works", async () => {
    const js = mk("node")
    const r = await js.run("const v = await Promise.resolve(7); console.log(v)")
    expect(r.stdout.trim()).toBe("7")
  })

  test("require is available", async () => {
    const js = mk("node")
    const r = await js.run('const os = require("node:os"); console.log(typeof os.platform())')
    expect(r.stdout.trim()).toBe("string")
  })

  test("errors report status", async () => {
    const js = mk("node")
    const r = await js.run("throw new Error('boom')")
    expect(r.status).toBe("error")
    expect(r.stderr).toContain("boom")
  })
})

describe("bun backend", () => {
  test("persists state", async () => {
    const b = mk("bun")
    await b.run("let n = 20;")
    const r = await b.run("n *= 2; console.log(n)")
    expect(r.stdout.trim()).toBe("40")
  })
})

describe("lifecycle", () => {
  test("timeout kills the interpreter and the next call recovers", async () => {
    const py = mk("python", { timeoutMs: 150 })
    const r = await py.run("import time\ntime.sleep(5)\nprint('late')")
    expect(r.status).toBe("timeout")
    expect(py.running).toBe(false)
    const r2 = await py.run("print('recovered')")
    expect(r2.status).toBe("ok")
    expect(r2.stdout.trim()).toBe("recovered")
  })

  test("reset discards state", async () => {
    const py = mk("python")
    await py.run("x = 1")
    py.reset()
    const r = await py.run("print('x' in globals())")
    expect(r.stdout.trim()).toBe("False")
  })

  test("cancellation via AbortSignal", async () => {
    const py = mk("python")
    const controller = new AbortController()
    const pending = py.run("import time\ntime.sleep(5)", { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const r = await pending
    expect(r.status).toBe("cancelled")
  })

  test("concurrent calls are serialised per interpreter", async () => {
    const py = mk("python")
    await py.run("n = 0")
    const [a, b] = await Promise.all([
      py.run("n += 1\nimport time\ntime.sleep(0.05)\nprint('a', n)"),
      py.run("n += 1\nprint('b', n)"),
    ])
    expect(a.stdout.trim()).toBe("a 1")
    expect(b.stdout.trim()).toBe("b 2")
  })

  test("a missing runtime surfaces an error", async () => {
    const rb = mk("ruby")
    await expect(rb.run("puts 1")).rejects.toThrow()
  })
})
