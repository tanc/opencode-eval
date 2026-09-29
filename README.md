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
| `steer`     | `false`    | inject a constant reminder preferring `eval` |

Environment overrides (useful when auto-discovered, since discovery passes no
options): `EVAL_DEFAULT_LANGUAGE`, `EVAL_TIMEOUT_MS`, `EVAL_STEER`.

## Steering the agent (`steer: true`)

By default the agent learns about `eval` only from the tool description. With
`steer` enabled the plugin also injects one system reminder, mirroring what
oh-my-pi does — `eval` persists state, and scripts/heredocs/complex pipelines
should prefer it over `shell`.

One deliberate difference from omp: omp also *rewrites its `bash` tool
description* to redirect scripts to `eval`. In opencode v2.0.18 a plugin
transform can change a built-in tool's registry entry but **not** its
provider-facing schema — `editor.update("shell", …)` shows up in
`ctx.tool.list()` yet not in the request. (Updating a *plugin-registered* tool
*does* reach the wire.) So the redirect is carried by the system reminder
instead of the shell description.

## Prompt caching

Provider prompt caching is prefix-based: the previously sent prefix must be
byte-identical for a hit, so anything that varies per request — in the system
prompt or the tool schemas — invalidates the cache from that point on.

`steer` is built around that:

- the reminder is a fixed string — no timestamps, ids, counters or state;
- it is appended in the same position on every agent-loop request;
- it is registered only for the agent loop (`context`), never `title`,
  `generate` or `compaction`;
- the plugin does not touch any tool schema.

Measured against v2.0.18 by hashing the fully assembled request (system blocks +
every tool description) in a `context` hook over consecutive requests of one
session with `EVAL_STEER=1`:

| request | messages | system blocks | system hash        | system+tools hash  |
| ------- | -------- | ------------- | ------------------ | ------------------ |
| 1       | 1        | 5             | `e1b5630e51f17dd0` | `50181cb19b502d28` |
| 2       | 4        | 5             | `e1b5630e51f17dd0` | `50181cb19b502d28` |
| 3       | 6        | 5             | `e1b5630e51f17dd0` | `50181cb19b502d28` |

Identical hashes → the cacheable prefix never changes; only the message list
grows, which is append-only and cache-friendly. Enabling `steer` costs a
one-time prefix shift and nothing after that.

## Verified

Smoke-tested against **opencode v2.0.18** (the build OpenChamber ships) with
`@opencode/plugin` 2.0.19, driving a real model:

- the plugin loads from a `plugins` config entry (an earlier build auto-loaded
  it from `.opencode/plugins/`, which double-loads when combined with an entry);
- `eval` is callable **directly** and returns `[python] ok (53ms)\n42`;
- state persists across separate tool calls — `x = 41`, then a later
  `print(x + 1)` returns `42` (and latency drops once the interpreter is warm);
- a direct call is rejected if `codemode: false` is removed, confirming plugin
  tools are Code Mode–deferred by default;
- with `EVAL_STEER=1` the reminder reaches the assembled request and the
  system+tools hash is byte-identical across consecutive requests (cache-safe);
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
