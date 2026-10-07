/**
 * eval — a persistent, polyglot script interpreter for OpenCode v2.
 *
 * Registers one `eval` tool that runs code in a long-lived interpreter, so
 * variables, imports and side effects persist across calls and there is no
 * per-call startup cost. This is the "compose and run a script" workbench that
 * the plain `shell` tool does not provide.
 *
 * Loaded by registering this directory (`plugin/`) in `opencode.json` under
 * `plugins`, e.g. `{ "package": "/abs/path/to/opencode-eval/plugin" }`. It is
 * deliberately *not* under `.opencode/plugins/`: OpenCode loads that directory
 * automatically and does not dedupe, so combining the two loads it twice.
 */
import { Plugin } from "@opencode/plugin"
import { BACKENDS, Interpreter, LANGUAGE_ALIASES, type Backend, type EvalResult } from "./runtime.ts"

interface EvalOptions {
  /** Backend used when the model omits `language`. Default "python". */
  language?: string
  /** Default per-cell timeout in ms. Default 60000. */
  timeout?: number
  /** Override or add backends by language key. */
  languages?: Record<string, Partial<Backend>>
  /**
   * Nudge the agent toward `eval`, mirroring oh-my-pi: prefix a constant
   * redirect to the `shell`/`bash` tool descriptions and inject one constant
   * system reminder. Off by default. Both strings are fixed, so the cached
   * prompt prefix stays byte-identical (see README, "Prompt caching").
   */
  steer?: boolean
  /** Tool descriptions to redirect when `steer` is on. Default ["shell","bash"]. */
  steerTools?: string[]
}

const DEFAULT_TIMEOUT = 60_000

// Constant by design: appended to every agent-loop system prompt, so any
// per-request variation here would invalidate the provider's prompt cache.
const EVAL_STEER_REMINDER =
  "<system-reminder>\n" +
  "`eval` runs code in a persistent interpreter: one cell per call, and top-level state " +
  "(variables, imports, processes) persists across calls. Prefer `eval` over shell for scripts, " +
  "heredocs, complex pipelines and multi-step computation. A timed-out, aborted or cancelled " +
  "cell loses its state; re-run needed setup after a reset.\n" +
  "</system-reminder>"

// Prefixed to these tools' descriptions on every agent-loop request when `steer`
// is on. `shell` is the built-in; `bash` is the AFT plugin's. Editing the tool
// the model is about to reach for is the lever omp uses (it rewrites its own
// bash description); verified to reach the outgoing request in v2.0.22.
const DEFAULT_STEER_TOOLS = ["shell", "bash"]

// Constant, like the reminder: a per-request value here would break caching.
const SHELL_REDIRECT =
  "Scripts, heredocs, `$(...)`, complex pipelines or multi-step computation → prefer `eval` (persistent interpreter).\n"

function resolveLanguage(input: unknown, fallback: string): string {
  const raw = typeof input === "string" && input.trim() ? input.trim().toLowerCase() : fallback
  return LANGUAGE_ALIASES[raw] ?? raw
}

function format(result: EvalResult, language: string, code: string): string {
  const header = `[${language}] ${result.status} (${result.durationMs}ms)`
  const sections: string[] = [header]
  const stdout = result.stdout.replace(/\n+$/, "")
  const stderr = result.stderr.replace(/\n+$/, "")
  if (stdout) sections.push(stdout)
  if (stderr) sections.push(`stderr:\n${stderr}`)
  if (!stdout && !stderr) {
    sections.push(
      result.status === "ok" ? "(no output)" : `(no output; ${result.status}${result.exitCode != null ? ` exit=${result.exitCode}` : ""})`,
    )
  }
  return sections.join("\n")
}

export default Plugin.define({
  id: "eval",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as EvalOptions
    const defaultLanguage = resolveLanguage(options.language ?? process.env.EVAL_DEFAULT_LANGUAGE, "python")
    const defaultTimeout = options.timeout ?? Number(process.env.EVAL_TIMEOUT_MS ?? DEFAULT_TIMEOUT)
    const steer = options.steer ?? /^(1|true|yes|on)$/i.test(process.env.EVAL_STEER ?? "")

    // Backends are resolved once, from built-ins plus any option overrides.
    const backends: Record<string, Backend> = { ...BACKENDS }
    for (const [key, override] of Object.entries(options.languages ?? {})) {
      backends[key] = { ...(backends[key] ?? { command: key, args: [] }), ...override }
    }

    // One interpreter per (session, language). Keyed by session so two sessions
    // never share state; the plugin lives for the server process lifetime.
    const interpreters = new Map<string, Interpreter>()
    const keyFor = (sessionID: string, language: string) => `${sessionID}\u0000${language}`

    const getInterpreter = (sessionID: string, language: string): Interpreter => {
      const key = keyFor(sessionID, language)
      let interp = interpreters.get(key)
      if (!interp) {
        interp = new Interpreter(language, backends[language], {
          timeoutMs: defaultTimeout,
          cwd: ctx.location.directory,
        })
        interpreters.set(key, interp)
      }
      return interp
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "eval",
        description:
          "Run code in a persistent interpreter that keeps its state between calls. " +
          "Prefer this over shell for scripts, data processing and multi-step computation: " +
          "variables, imports and running processes stay alive, so you can build on previous calls " +
          "without re-running setup. Supports python (default), node, bun, ruby, lua and R. " +
          "Returns the code's stdout/stderr and a status. Use reset to start a clean interpreter.",
        // Plugin tools default to Code Mode (deferred). `codemode: false` makes
        // `eval` a normal direct tool the agent can call without `execute`.
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            code: { type: "string", description: "Code to run in the interpreter." },
            language: {
              type: "string",
              description: "Interpreter to use. Defaults to the configured language.",
              enum: Object.keys(backends),
            },
            timeoutMs: {
              type: "integer",
              description: "Timeout for this cell in milliseconds. Defaults to the configured timeout.",
              minimum: 1,
            },
            reset: {
              type: "boolean",
              description: "Kill the current interpreter before running this cell, discarding all state.",
            },
          },
          required: ["code"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const { code, language, timeoutMs, reset } = input as {
            code: string
            language?: string
            timeoutMs?: number
            reset?: boolean
          }
          const lang = resolveLanguage(language, defaultLanguage)
          const backend = backends[lang]
          if (!backend) {
            return {
              content: `unknown language "${lang}". available: ${Object.keys(backends).join(", ")}`,
            }
          }

          const interp = getInterpreter(context.sessionID, lang)
          if (reset) interp.reset()
          await context.progress({ status: `${lang} eval (${backend.command})` })

          try {
            const result = await interp.run(code, { timeoutMs, signal: context.signal })
            return {
              content: format(result, lang, code),
              metadata: {
                language: lang,
                status: result.status,
                durationMs: result.durationMs,
                exitCode: result.exitCode ?? null,
              },
            }
          } catch (err) {
            // A failed spawn (missing runtime) or prelude must not poison the cache.
            interpreters.delete(keyFor(context.sessionID, lang))
            return {
              content: `[${lang}] failed: ${(err as Error).message}`,
              metadata: { language: lang, status: "error" },
            }
          }
        },
      })
    })

    // Optional steering toward `eval`, mirroring omp. omp *rewrites its bash
    // tool description* to redirect scripts to eval; the equivalent here is a
    // constant per-request edit of the `shell`/`bash` descriptions plus one
    // system reminder. v2.0.22 applies both `event.system` pushes and
    // `event.tools[...]` description edits to the outgoing request (verified
    // with an `http.request` hook). Both strings are constant, so the cached
    // prompt prefix stays byte-identical across requests.
    if (steer) {
      const steerTools = options.steerTools ?? DEFAULT_STEER_TOOLS
      try {
        await ctx.session.hook("context", (event) => {
          const tools = (event.tools ?? {}) as Record<string, { description?: string } | undefined>
          for (const name of steerTools) {
            const tool = tools[name]
            if (tool && !(tool.description ?? "").includes(SHELL_REDIRECT.trim())) {
              tool.description = SHELL_REDIRECT + (tool.description ?? "")
            }
          }
          event.system.push({ type: "text", text: EVAL_STEER_REMINDER })
        })
      } catch (err) {
        // Steering is a nudge, not the feature: if the hook cannot register
        // (e.g. a future API change), `eval` must still load and work.
        console.error("[eval] steer hook registration failed: " + (err as Error).message)
      }
    }

    return () => {
      for (const interp of interpreters.values()) interp.dispose()
      interpreters.clear()
    }
  },
})
