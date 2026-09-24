// Entry point: the MCP stdio server will be wired here after verifying
// the Jev CLI contract. Do NOT write banners/logs to stdout in an MCP server.
process.stderr.write(
  "Vex scaffold ready. Implement the Jev adapter and MCP stdio server before use.\\n",
);
