/**
 * eval — a persistent, polyglot script interpreter for OpenCode v2.
 *
 * Registers one `eval` tool that runs code in a long-lived interpreter, so
 * variables, imports and side effects persist across calls and there is no
 * per-call startup cost. This is the "compose and run a script" workbench that
 * the plain `shell` tool does not provide.
 *
 * Loaded automatically from `.opencode/plugins/eval/`, or register the
 * directory in `opencode.json` under `plugins` to pass options.
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
   * Nudge the agent toward `eval`: inject one constant system reminder that
   * cross-references it from the shell workflow. Off by default. The text is
   * fixed, so the cached prompt prefix stays byte-identical (see README,
   * "Prompt caching").
   */
  steer?: boolean
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

    // Optional steering toward `eval`, mirroring omp. omp also rewrites the
    // shell tool's description, but in v2.0.18 a transform can change a
    // built-in tool's registry entry yet not its provider-facing schema (only
    // plugin-registered tools update on the wire). So the redirect lives in one
    // constant system reminder instead — measured byte-stable across requests.
    if (steer) {
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: EVAL_STEER_REMINDER })
      })
    }

    return () => {
      for (const interp of interpreters.values()) interp.dispose()
      interpreters.clear()
    }
  },
})
