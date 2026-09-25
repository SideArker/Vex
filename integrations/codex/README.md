# Codex integration

Build this package, then register the MCP stdio server with the path to `dist/index.js` or the installed `vex` npm bin. For a local checkout, the server command is `node` with arguments: the absolute path to `dist/index.js`, `mcp`, and `serve`. Keep `OPENROUTER_API_KEY` in the MCP server process environment or use an existing `~/.openrouter_key` file.

`vex_choose` accepts a question, optional context and constraints, and two to twelve described options. It returns a versioned decision and abstains when confidence is low or the returned ID is unavailable.

For Pace model routing, call `vex_choose` directly. Pass the candidate worker routes in `options`. Put the complete executable route (model and effort, plus agent when relevant) in each option ID and description:

```json
{
  "question": "Which worker model route should handle this task?",
  "context": "Fix a small TypeScript regression with a focused test",
  "options": [
    {
      "id": "luna-low-builder",
      "description": "gpt-6-luna, low reasoning, builder agent for routine narrow edits"
    },
    {
      "id": "sol-medium-builder",
      "description": "gpt-6-sol, medium reasoning, builder agent for less certain coding work"
    },
    {
      "id": "self",
      "description": "Handle directly in the main session"
    }
  ]
}
```

Read `result.choice` (or `structuredContent.choice`) directly as the route ID. If `abstained: true` or `choice: null`, use Pace's fallback or gather more evidence. Supply concise, sanitized context. Explicit user instructions and tool permissions take precedence over Jev advice.

If an older global `jev` command exists, inspect command resolution before replacing anything. The independent `node dist/cli/jev.js` command works without changing the global installation. To roll back, restore the previous MCP command and shell path.
