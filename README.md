# opencode-eval

A persistent, polyglot **`eval`** tool for OpenCode v2. It runs code in a
long-lived interpreter that keeps its state between calls — variables, imports
and running processes survive — so the agent can compose and run scripts the
way you would in a REPL, without paying interpreter startup on every call and
without re-running setup.

This is the "compose and run a script" workbench that `shell` (stateless
process per call) and Code Mode (`execute`, tool orchestration only) do not
provide.

## What it registers

One **direct** tool named `eval` (registered with `codemode: false` — plugin
tools default to Code Mode and would otherwise be reachable only as
`tools.eval(...)` from `execute`):

| input       | type      | meaning                                                        |
| ----------- | --------- | -------------------------------------------------------------- |
| `code`      | string    | code to run (required)                                         |
| `language`  | string    | `python` (default), `node`, `bun`, `ruby`, `lua`, `r`          |
| `timeoutMs` | integer   | per-cell timeout, defaults to the configured timeout           |
| `reset`     | boolean   | kill the current interpreter first, discarding all state       |

The result is the cell's stdout/stderr plus a status line:
`[python] ok (12ms)`.

## How it works

Each `(session, language)` pair owns one child process running a ~20-line
harness. Code is framed over stdin as `<byteLength>\n<code>`, evaluated in a
persistent scope, and the harness writes a nonce-tagged marker line back on
stdout when the cell is done:

```
plugin -> interpreter   "<len>\n" + <code bytes>
interpreter -> plugin   <stdout/stderr> ...  "\0@@EVAL:<nonce>:<status>\n"
```

Because the process is never restarted between cells, state persists. A cell
that times out or aborts kills the interpreter (its state is unknowable
mid-execution) and the next call transparently starts a fresh one. Calls to the
same interpreter are serialised.

- **Python** — `python3 -u -c <harness>`, `exec` in a persistent globals dict.
- **Node / Bun** — `node|bun -e <harness>`, `vm.runInContext` in one context
  (top-level `let`/`const`/`var` and functions persist). A cell that needs
  top-level `await` is wrapped in an async IIFE automatically.
- **Ruby / Lua / R** — same protocol via `-e` harnesses. These backends are
  implemented but not exercised in the smoke tests (their runtimes were not
  installed); treat them as experimental.

## Install

**Any project (recommended).** Install straight from this repo; OpenCode
fetches it into its cache and adds it to your global configuration:

```sh
opencode plugin add github:tanc/opencode-eval
# manage it with:
opencode plugin list
opencode plugin update github:tanc/opencode-eval
opencode plugin remove github:tanc/opencode-eval
```

**Local development / local path.** Clone, install the one dependency, and
register the local `plugin/` directory in your (global or project)
`opencode.json`:

```sh
git clone git@github.com:tanc/opencode-eval.git
cd opencode-eval
bun install   # or: npm install
```

```jsonc
{
  "plugins": [
    {
      "package": "/abs/path/to/opencode-eval/plugin",
      "options": { "language": "python", "steer": true }
    }
  ]
}
```

A local plugin must resolve `@opencode/plugin` from its own `node_modules`,
which is why the install step is required; cache-installed packages get it
automatically.

> **Register it in exactly one place.** OpenCode does not dedupe: a plugin that
> is both listed in `plugins` and auto-discovered from `.opencode/plugins/`
> loads **twice**. This repo keeps its source in `plugin/` (not
> `.opencode/plugins/`) precisely so it is never auto-discovered — you register
> it explicitly. That explicit entry is also what makes OpenChamber show an
> editable options card for it.

| option      | default    | meaning                                    |
| ----------- | ---------- | ------------------------------------------ |
| `language`  | `python`   | backend used when the model omits one      |
| `timeout`   | `60000`    | default per-cell timeout in ms             |
| `languages` | built-ins  | add or override backends                   |
| `steer`     | `false`    | redirect shell/bash descriptions + reminder to prefer `eval` |
| `steerTools`| `[shell, bash]` | which tool descriptions `steer` edits     |

Environment overrides (useful when auto-discovered, since discovery passes no
options): `EVAL_DEFAULT_LANGUAGE`, `EVAL_TIMEOUT_MS`, `EVAL_STEER`.

## Steering the agent (`steer: true`)

By default the agent learns about `eval` only from its own tool description —
and in practice models then reach for `shell`/`bash` almost every time. With
`steer` enabled the plugin nudges them, mirroring oh-my-pi:

- it prefixes a constant redirect to the **`shell` and `bash` tool
descriptions** ("Scripts, heredocs, `$(...)`, complex pipelines or multi-step
computation → prefer `eval`"). omp does exactly this to its own `bash` tool, and
it lands at the moment the model is choosing that tool;
- it appends one constant `<system-reminder>` about persistent state.

Both edits happen in the agent-loop `context` hook. Verified on **v2.0.22** (via
an `http.request` hook reading the real outgoing payload) that both the
`event.system` push *and* the `event.tools[...]` description edits reach the
request. Note this is a different mechanism from `ctx.tool.transform`, where an
`editor.update("shell", …)` changes `ctx.tool.list()` but not the wire.

Why the redirect and not just the reminder: an audit of 15 real coding sessions
(Oct 2–6) running a reminder-only build found **0 `eval` calls against 274
`shell`/`bash` calls** — a single system reminder did not change tool choice. An
A/B on a script task then chose `bash` with `steer: false` and `eval` with
`steer: true`. Set `steerTools` to change which descriptions are edited.

## Prompt caching

Provider prompt caching is prefix-based: the previously sent prefix must be
byte-identical for a hit, so anything that varies per request — system prompt or
tool schemas — invalidates the cache from that point on.

`steer` is built around that:

- both edits are fixed strings — no timestamps, ids, counters or state;
- they are applied at the same position on every agent-loop request;
- they are registered only for the agent loop (`context`), never `title`,
  `generate` or `compaction`;
- the redirect is guarded (`if (!description.includes(REDIRECT))`) so a
  description that already carries it is never re-prefixed.

Measured on v2.0.22 by reading the real outgoing payload with an `http.request`
hook over consecutive requests: the redirect appears exactly **twice** (once on
`shell`, once on `bash`) and that count is **stable** across requests — it does
not stack — while the reminder is present on every primary request. Enabling
`steer` costs a one-time prefix shift and nothing after that.

(An earlier v2.0.18 hash-based run showed the same byte-stable outcome; the
`http.request` payload check supersedes it because it reads what is actually
sent rather than a hook's view.)

## Verified

Smoke-tested against **opencode v2.0.22** (the build OpenChamber ships) with
`@opencode/plugin` 2.0.19, driving real models:

- the plugin loads from a `plugins` config entry (an earlier build auto-loaded
  it from `.opencode/plugins/`, which double-loads when combined with an entry);
- `eval` is callable **directly** and returns `[python] ok (53ms)\n42`;
- state persists across separate tool calls — `x = 41`, then a later
  `print(x + 1)` returns `42` (and latency drops once the interpreter is warm);
- a direct call is rejected if `codemode: false` is removed, confirming plugin
  tools are Code Mode–deferred by default;
- with `steer: true` the redirect and the reminder both reach the real
  outgoing request (checked via the `http.request` hook) and the redirect is
  byte-stable and non-stacking across consecutive requests (cache-safe);
- the plugin also loads for ordinary project directories (not just this repo),
  so `eval` is available in normal sessions;
- the same flow works after `opencode plugin add github:tanc/opencode-eval`,
  run from a directory with no local plugin (installed from the cache).

## Limitations

- Interpreter state lives in the OpenCode server process. A server restart, or
  a timed-out/aborted cell, resets it. State is not shared between sessions.
- Only one cell runs at a time per `(session, language)`; concurrent calls queue.
- A cell that reads stdin competes with the framing protocol — don't.
- Node/Bun cells using top-level `await` are wrapped in an async IIFE, so
  lexical declarations in *that* cell do not persist (use `globalThis`/`var`).

## Development

```sh
bun install   # optional: types for @opencode/plugin
bun test      # 16 runtime tests (python/node/bun lifecycle)
```
