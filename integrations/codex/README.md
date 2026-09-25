# Codex integration

Build this package, then register the MCP stdio server with the path to `dist/index.js` or the installed `vex` npm bin. For a local checkout, the server command is `node` with arguments: the absolute path to `dist/index.js`, `mcp`, and `serve`. Keep `OPENROUTER_API_KEY` in the MCP server process environment or use an existing `~/.openrouter_key` file.

The single `vex_choose` tool accepts a question, optional context and constraints, and two to twelve described options. It returns a versioned decision and abstains when confidence is low or the returned ID is unavailable. Supply concise, sanitized context. Explicit user instructions and tool permissions take precedence over Jev advice.

If an older global `jev` command exists, inspect command resolution before replacing anything. The independent `node dist/cli/jev.js` command works without changing the global installation. To roll back, restore the previous MCP command and shell path.
