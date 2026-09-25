# Codex integration

Build this package, then register the MCP stdio server with the path to `dist/index.js` or the installed `vex` npm bin. For a local checkout, the server command is `node` with arguments: the absolute path to `dist/index.js`, `mcp`, and `serve`. Keep `OPENROUTER_API_KEY` in the MCP server process environment or use an existing `~/.openrouter_key` file.

`vex_choose` accepts a question, optional context and constraints, and two to twelve described options. It returns a versioned decision and abstains when confidence is low or the returned ID is unavailable.

For Pace, call `vex_workflow` with `runtime: "codex"`, a concise `task`, and two to twelve described `models` candidates. Put the complete executable route (model and effort, plus agent when relevant) in each candidate ID and description. Do not request model, effort, and agent as separate choices if Pace needs one compatible route. Example:

```json
{
  "runtime": "codex",
  "task": "Fix a small TypeScript regression with a focused test",
  "models": {
    "luna-low-builder": "gpt-6-luna, low reasoning, builder agent for routine narrow edits",
    "sol-medium-builder": "gpt-6-sol, medium reasoning, builder agent for less certain coding work"
  }
}
```

Read `structuredContent.workflow.selections.model` as the route ID. If it is absent, abstain and use Pace's own fallback or gather more evidence. `response` contains the typed Jev answer and usage details; `workflow` contains thresholded selections and next-step signals. Optional `tools`, `agents`, `evidence`, `acceptance`, and `proposed_action` support broader workflow checks. Supply concise, sanitized context. Explicit user instructions and tool permissions take precedence over Jev advice.

If an older global `jev` command exists, inspect command resolution before replacing anything. The independent `node dist/cli/jev.js` command works without changing the global installation. To roll back, restore the previous MCP command and shell path.
