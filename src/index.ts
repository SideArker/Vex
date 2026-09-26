#!/usr/bin/env node
import {
  resolveApiKey,
  resolveOpenRouterApiKey,
  resolveProviderConfig,
  resolveTypeSafeApiKey,
} from "./core/engine.js";
import { DEFAULT_TYPESAFE_MODEL } from "./core/schemas.js";
import { startServer } from "./mcp/server.js";
import {
  fetchAccountStats,
  formatStatsReport,
  readLocalStats,
  resetLocalStats,
} from "./core/stats.js";

export {
  decide,
  decideTyped,
  resolveApiKey,
  resolveTypeSafeApiKey,
  resolveOpenRouterApiKey,
  resolveProviderConfig,
  DecisionError,
  type EngineOptions,
  type ProviderConfig,
} from "./core/engine.js";
export {
  selectChoice,
  chooseOption,
  routeIntent,
  formatSummary,
  type Selection,
} from "./core/decisions.js";
export { createServer, startServer } from "./mcp/server.js";
export * from "./core/schemas.js";
export {
  readLocalStats,
  resetLocalStats,
  fetchAccountStats,
  formatStatsReport,
  type LocalStats,
  type CombinedStatsReport,
} from "./core/stats.js";

const VERSION = "0.1.0";
const HELP = `Usage: vex <command>

Commands:
  mcp serve    Start the Vex MCP stdio server
  stats        Display Vex & Jev combined usage statistics and credit details
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
    const typeSafeKey = await resolveTypeSafeApiKey();
    const openRouterKey = await resolveOpenRouterApiKey();
    let activeProvider = "none";
    let activeModel = DEFAULT_TYPESAFE_MODEL;
    try {
      const config = await resolveProviderConfig();
      activeProvider = config.provider;
      activeModel = config.model;
    } catch {
      // No active provider
    }
    process.stdout.write(
      `Vex ${VERSION}\nNode ${process.version}\nActive provider: ${activeProvider}\nTypeSafe key: ${typeSafeKey ? "available" : "missing"}\nOpenRouter key: ${openRouterKey ? "available" : "missing"}\nModel: ${activeModel}\n`,
    );
    return typeSafeKey || openRouterKey ? 0 : 1;
  }
  if (args[0] === "stats") {
    const rest = args.slice(1);
    const isReset = rest.includes("--reset");
    const isRaw = rest.includes("--raw");
    const unknown = rest.filter((a) => a !== "--reset" && a !== "--raw");
    if (unknown.length > 0) {
      process.stderr.write(`Unsupported option for stats: ${unknown[0]}\n`);
      return 2;
    }
    if (isReset) {
      await resetLocalStats();
      process.stdout.write("[INFO] Local usage statistics reset.\n");
      return 0;
    }
    const openRouterKey = await resolveOpenRouterApiKey();
    const local = await readLocalStats();
    const remote = await fetchAccountStats(openRouterKey);
    if (isRaw) {
      const output = {
        local,
        local_jev: local,
        openrouter_account: remote,
      };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`${formatStatsReport(local, remote)}\n`);
    return 0;
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
