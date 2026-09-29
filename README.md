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

One direct tool named `eval`:

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

## Loading it

Auto-discovered: OpenCode loads everything under `.opencode/plugins/`, so
cloning this repo as a project is enough — `.opencode/plugins/eval/` is picked
up with no configuration.

To load it from elsewhere, register the directory in `opencode.json` and pass
options:

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
