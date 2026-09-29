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

**Local development.** OpenCode auto-loads `.opencode/plugins/`, so clone and
install the one dependency:

```sh
git clone git@github.com:tanc/opencode-eval.git
cd opencode-eval
bun install   # or: npm install
```

A *local* plugin must resolve `@opencode/plugin` from its own `node_modules`,
which is why the install step is required; cache-installed plugins get it
automatically.

To load it from an arbitrary directory with options, register it in
`opencode.json`:

```jsonc
{
  "plugins": [
    {
      "package": "./path/to/opencode-eval/.opencode/plugins/eval",
      "options": {
        "language": "python",
        "timeout": 60000,
        "languages": { "python": { "command": "python3.12" } }
      }
    }
  ]
}
```

| option      | default    | meaning                                    |
| ----------- | ---------- | ------------------------------------------ |
| `language`  | `python`   | backend used when the model omits one      |
| `timeout`   | `60000`    | default per-cell timeout in ms             |
| `languages` | built-ins  | add or override backends                   |

Environment overrides (useful when auto-discovered, since discovery passes no
options): `EVAL_DEFAULT_LANGUAGE`, `EVAL_TIMEOUT_MS`.

## Verified

Smoke-tested against **opencode v2.0.18** (the build OpenChamber ships) with
`@opencode/plugin` 2.0.19, driving a real model:

- the plugin loads from `.opencode/plugins/eval/`;
- `eval` is callable **directly** and returns `[python] ok (53ms)\n42`;
- state persists across separate tool calls — `x = 41`, then a later
  `print(x + 1)` returns `42` (and latency drops once the interpreter is warm);
- a direct call is rejected if `codemode: false` is removed, confirming plugin
  tools are Code Mode–deferred by default;
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
