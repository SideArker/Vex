#!/usr/bin/env node
import { resolveApiKey } from "./core/engine.js";
import { startServer } from "./mcp/server.js";

const VERSION = "0.1.0";
const HELP = `Usage: vex <command>

Commands:
  mcp serve    Start the Vex MCP stdio server
  doctor       Check runtime and key availability
  --help       Show this help
  --version    Show package version`;

async function main(args: string[]): Promise<number> {
  if (
    !args.length ||
    args[0] === "--help" ||
    args[0] === "-h" ||
    args[0] === "help"
  ) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args[0] === "doctor" && args.length === 1) {
    const key = await resolveApiKey();
    process.stdout.write(
      `Vex ${VERSION}\nNode ${process.version}\nOpenRouter key: ${key ? "available" : "missing"}\n`,
    );
    return key ? 0 : 1;
  }
  if (args[0] === "mcp" && args[1] === "serve" && args.length === 2) {
    await startServer();
    process.stderr.write(
      "Vex MCP stdio server is ready; waiting for client requests.\n",
    );
    return 0;
  }
  process.stderr.write(`Unknown command. Run 'vex --help' for usage.\n`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `[ERROR] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
