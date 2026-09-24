# Vex

Vex is a **thin Jev decision-tool adapter** for coding agents. It is a separate
integration project; Jev remains the decision engine, and Codex remains the
coding agent. This repository is an intentionally minimal **scaffold**, not a
working MCP server yet.

## Get started

```sh
npm install
npm run check
npm test
```

`npm run dev` prints an implementation reminder until the actual Jev command
contract and MCP server are implemented.

## Intended structure

- `src/jev/`: inspect and safely adapt the **actual installed** `jev` CLI.
- `src/tools/`: tools for `choose_skill` and `choose_next_action`.
- `src/mcp/`: MCP stdio transport; reserve stdout **exclusively** for protocol messages.
- `integrations/codex/`: optional Codex instructions and hook templates, once verified.
- `tests/`: offline tests using a fake Jev executable (never require credentials).

## Before implementing

1. Run `jev --help` and inspect its actual supported commands and output.
2. Keep Jev choices bounded to supplied options; include a `none`/`need_more_info` fallback.
3. Use a safe child process (`shell: false`), timeouts and validated structured outputs.
4. Give Jev only necessary task text and skill descriptions—not secrets or entire repos.
5. Consult current Codex and MCP docs before writing config/hook files. Do not
   assume every Codex tool or event supports a hook.
6. Measure total usage and task quality before claiming token savings.

For the initial version, implement one working skill-choice MCP tool first.
