#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { stdin, stdout, stderr } from "node:process";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import {
  decide,
  decideTyped,
  errorResult,
  resolveApiKey,
  type EngineOptions,
} from "../core/engine.js";
import { formatSummary, routeIntent } from "../core/decisions.js";
import {
  buildWorkflowRequest,
  summarizeWorkflow,
  workflowContextSchema,
} from "./workflow.js";
import {
  DEFAULT_MODEL,
  boundedDecisionSchema,
  requestSchema,
  type DecisionRequest,
} from "../core/schemas.js";
import {
  fetchAccountStats,
  formatStatsReport,
  readLocalStats,
  resetLocalStats,
} from "../core/stats.js";

const VERSION = "0.1.0";
const HELP = `Usage: jev <command> [options]

Commands:
  decide [file|-]              Choose from supplied options (stdin by default)
  decide "question" --option "id=Description" --option "other=Description"
  run [file|-]                 Execute a typed Decisions JSON request
  workflow <file>              Evaluate workflow choices and review signals
  eval -s <file> -q <file>      Evaluate state and questions files
  route <file> -r <file>       Choose from described routes
  suggest-skill [task]         Choose from supplied skill catalog (-c file)
  triage [task]                Classify an engineering task
  gate [action]                Assess a proposed action
  verify-diff [file|-]         Review a diff
  stats [--raw] [--reset]      Display Vex & Jev usage statistics and credit details
  doctor                       Check installation and key availability
  --version, --help            Show version or this help

Use 'jev decide --json' for one versioned JSON result on stdout.
Common legacy options: --raw, --out <file>. Input file '-' means stdin.
Examples:
  jev decide request.json
  jev decide "What next?" --option "review=Review docs" --option "none=Gather evidence" --context "Tests passed"
  cat request.json | jev decide --json
  jev workflow workflow.json --raw
Inputs are sent to OpenRouter; sanitize sensitive text before use.`;

async function readInput(path: string): Promise<string> {
  if (path !== "-") return readFile(path, "utf8");
  let value = "";
  for await (const chunk of stdin) value += chunk.toString();
  return value;
}

function options(
  args: string[],
  allowed: string[],
): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--raw" || arg === "--json" || arg === "--reset") {
      if (!allowed.includes(arg)) throw new Error(`Unsupported option: ${arg}`);
      flags[arg === "--raw" ? "raw" : arg] = true;
      continue;
    }
    const key =
      (
        {
          "-o": "--out",
          "-s": "--state-file",
          "-q": "--questions-file",
          "-r": "--routes-file",
          "-f": "--file",
          "-c": "--catalog",
        } as Record<string, string>
      )[arg] ?? arg;
    if (key.startsWith("-")) {
      if (!allowed.includes(key)) throw new Error(`Unsupported option: ${arg}`);
      if (flags[key] !== undefined) throw new Error(`Duplicate option: ${arg}`);
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      flags[key] = args[++i];
    } else positional.push(arg);
  }
  return { positional, flags };
}

const outputFlags = ["--raw", "--out"];
function single(positional: string[], fallback?: string): string {
  if (positional.length > 1 || (!positional.length && fallback === undefined))
    throw new Error("Expected one input argument");
  return positional[0] ?? fallback!;
}
function option(flags: Record<string, string | boolean>, key: string): string {
  const value = flags[key];
  if (typeof value !== "string") throw new Error(`Required option: ${key}`);
  return value;
}
function asJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
function nonempty(text: string): string {
  if (!text.trim()) throw new Error("Input must be nonempty");
  return text.trim();
}
async function taskText(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<string> {
  return nonempty(
    flags["--file"]
      ? await readInput(String(flags["--file"]))
      : positional.length
        ? single(positional)
        : await readInput("-"),
  );
}

function humanDecisionArgs(args: string[]): {
  request: unknown;
  json: boolean;
} {
  const positional: string[] = [];
  const offered: Array<{ id: string; description: string }> = [];
  const constraints: string[] = [];
  let context: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      if (json) throw new Error("Duplicate option: --json");
      json = true;
      continue;
    }
    if (arg === "--option" || arg === "--context" || arg === "--constraint") {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      if (arg === "--option") {
        const separator = value.indexOf("=");
        if (separator < 1 || separator === value.length - 1)
          throw new Error("Each --option must be id=Description");
        offered.push({
          id: value.slice(0, separator),
          description: value.slice(separator + 1),
        });
      } else if (arg === "--context") {
        if (context !== undefined)
          throw new Error("Duplicate option: --context");
        context = value;
      } else constraints.push(value);
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unsupported option: ${arg}`);
    positional.push(arg);
  }
  return {
    request: {
      question: single(positional),
      options: offered,
      ...(context === undefined ? {} : { context }),
      ...(constraints.length ? { constraints } : {}),
    },
    json,
  };
}

async function execute(
  request: DecisionRequest,
  flags: Record<string, string | boolean>,
  workflow = false,
  engine: EngineOptions = {},
): Promise<number> {
  const response = await decideTyped(request, engine);
  const result = workflow
    ? { response, workflow: summarizeWorkflow(response, request) }
    : response;
  const serialized = JSON.stringify(result, null, 2);
  if (flags["--out"])
    await writeFile(String(flags["--out"]), `${serialized}\n`, "utf8");
  stdout.write(
    flags.raw
      ? `${serialized}\n`
      : `${formatSummary(response)}${workflow ? `\nWorkflow: ${JSON.stringify(summarizeWorkflow(response, request))}` : ""}\n`,
  );
  return 0;
}

export async function runCli(
  argv: string[],
  engine: EngineOptions = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "doctor") {
    if (rest.length) throw new Error("doctor takes no options");
    const key = await resolveApiKey();
    stdout.write(
      `Jev ${VERSION}\nNode ${process.version}\nOpenRouter key: ${key ? "available" : "missing"}\nModel: ${DEFAULT_MODEL}\n`,
    );
    return key ? 0 : 1;
  }
  if (command === "decide") {
    const human = rest.includes("--option") ? humanDecisionArgs(rest) : null;
    const { positional, flags } = human
      ? { positional: [], flags: { "--json": human.json } }
      : options(rest, ["--json"]);
    const request = boundedDecisionSchema.parse(
      human ? human.request : asJson(await readInput(single(positional, "-"))),
    );
    const result = await decide(request, {
      operation: "decide",
      source: "jev",
      ...engine,
    });
    stdout.write(
      flags["--json"]
        ? `${JSON.stringify(result)}\n`
        : `${result.abstained ? "Abstain" : `Choice: ${result.choice}`} (confidence: ${result.confidence.toFixed(2)})${result.reason ? ` — ${result.reason}` : ""}\n`,
    );
    return 0;
  }
  if (command === "run") {
    const { positional, flags } = options(rest, outputFlags);
    return execute(
      requestSchema.parse(asJson(await readInput(single(positional, "-")))),
      flags,
      false,
      { operation: "run", source: "jev", ...engine },
    );
  }
  if (command === "workflow") {
    const { positional, flags } = options(rest, outputFlags);
    return execute(
      buildWorkflowRequest(
        workflowContextSchema.parse(
          asJson(await readInput(single(positional))),
        ),
      ),
      flags,
      true,
      { operation: "workflow", source: "jev", ...engine },
    );
  }
  if (command === "eval") {
    const { positional, flags } = options(rest, [
      ...outputFlags,
      "--state-file",
      "--questions-file",
    ]);
    if (positional.length)
      throw new Error("eval does not accept positional arguments");
    return execute(
      requestSchema.parse({
        state: await readInput(option(flags, "--state-file")),
        questions: asJson(await readInput(option(flags, "--questions-file"))),
      }),
      flags,
      false,
      { operation: "eval", source: "jev", ...engine },
    );
  }
  if (command === "route") {
    const { positional, flags } = options(rest, [
      ...outputFlags,
      "--state-file",
      "--routes-file",
    ]);
    const state = await readInput(
      flags["--state-file"]
        ? String(flags["--state-file"])
        : single(positional),
    );
    const routes = asJson(await readInput(option(flags, "--routes-file")));
    if (!routes || typeof routes !== "object" || Array.isArray(routes))
      throw new Error("Routes must be a described object");
    const result = await routeIntent(
      state,
      routes as Record<string, string>,
      { operation: "route", source: "jev", ...engine },
    );
    if (flags["--out"])
      await writeFile(
        String(flags["--out"]),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    stdout.write(
      flags.raw
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Route: ${result.route ?? "abstain"} (confidence: ${result.confidence.toFixed(2)})\nPassed threshold (0.70): ${result.passed_threshold ? "YES" : "NO"}\n`,
    );
    return 0;
  }
  if (command === "suggest" || command === "suggest-skill") {
    const { positional, flags } = options(rest, [
      "--raw",
      "--file",
      "--catalog",
    ]);
    const task = await taskText(positional, flags);
    const catalog = asJson(await readInput(option(flags, "--catalog")));
    return execute(
      requestSchema.parse({
        state: `Task: ${task}`,
        questions: {
          which_skill: {
            type: "choice",
            instructions: "Which available skill best matches this task?",
            criteria: catalog,
          },
          needs_skill: {
            type: "noul",
            instructions: "Does this task need a specialized skill?",
            criteria: {
              true: "Specialized workflow is useful",
              false: "Direct response is sufficient",
            },
          },
        },
      }),
      flags,
      false,
      { operation: "suggest", source: "jev", ...engine },
    );
  }
  if (command === "triage") {
    const { positional, flags } = options(rest, ["--raw", "--file"]);
    const task = await taskText(positional, flags);
    return execute(
      {
        state: `Task: ${task}`,
        questions: {
          task_type: {
            type: "choice",
            instructions: "What primary engineering activity is this?",
            criteria: {
              bug_fix: "Fixing broken behavior",
              feature: "Adding new capability",
              refactor: "Restructuring while preserving behavior",
              code_review: "Auditing code",
              investigation: "Diagnosing uncertain behavior",
              question_docs: "Explanation or docs",
            },
          },
          scope_size: {
            type: "score",
            instructions: "Estimated scope",
            criteria: ["Narrow", "Medium", "Broad"],
          },
          touches_db: {
            type: "noul",
            instructions: "Does this task require database migration?",
            criteria: { true: "Schema changes", false: "No schema changes" },
          },
          risk_level: {
            type: "score",
            instructions: "Risk level",
            criteria: ["Low", "Medium", "High"],
          },
          needs_architect_confirmation: {
            type: "noul",
            instructions: "Would human confirmation materially help?",
            criteria: {
              true: "Material ambiguity or risk",
              false: "Authorized standard work",
            },
          },
        },
      },
      flags,
      false,
      { operation: "triage", source: "jev", ...engine },
    );
  }
  if (command === "gate") {
    const { positional, flags } = options(rest, ["--raw", "--file"]);
    const action = await taskText(positional, flags);
    return execute(
      {
        state: `Proposed action: ${action}`,
        questions: {
          is_destructive: {
            type: "noul",
            instructions: "Is this action destructive?",
            criteria: {
              true: "Data loss or irreversible change",
              false: "Safe or reversible",
            },
          },
          escalate_to_human_architect: {
            type: "noul",
            instructions: "Does this action need human confirmation?",
            criteria: {
              true: "Material ambiguity or consequence",
              false: "Authorized standard action",
            },
          },
        },
      },
      flags,
      false,
      { operation: "gate", source: "jev", ...engine },
    );
  }
  if (command === "verify-diff") {
    const { positional, flags } = options(rest, ["--raw"]);
    const diff = nonempty(await readInput(single(positional, "-"))).slice(
      0,
      15000,
    );
    return execute(
      {
        state: diff,
        questions: {
          introduces_syntax_or_contract_break: {
            type: "noul",
            instructions:
              "Does the diff introduce an obvious syntax or contract break?",
            criteria: { true: "Breakage", false: "No obvious breakage" },
          },
          alters_unrelated_code: {
            type: "noul",
            instructions: "Does the diff alter unrelated code?",
            criteria: { true: "Unrelated edits", false: "Focused edits" },
          },
          quality_score: {
            type: "score",
            instructions: "Overall quality and safety",
            criteria: ["Poor", "Acceptable", "High"],
          },
        },
      },
      flags,
      false,
      { operation: "verify-diff", source: "jev", ...engine },
    );
  }
  if (command === "stats") {
    const { positional, flags } = options(rest, ["--raw", "--reset"]);
    if (positional.length)
      throw new Error("stats does not accept positional arguments");
    if (flags["--reset"]) {
      await resetLocalStats(engine.statsFilePath);
      stdout.write("[INFO] Local usage statistics reset.\n");
      return 0;
    }
    const apiKey =
      engine.apiKey?.trim() || (await (engine.keyProvider ?? resolveApiKey)());
    const local = await readLocalStats(engine.statsFilePath);
    const remote = await fetchAccountStats(apiKey, engine.fetchImpl);
    if (flags.raw) {
      const output = {
        local,
        local_jev: local,
        openrouter_account: remote,
      };
      stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${formatStatsReport(local, remote)}\n`);
    return 0;
  }
  throw new Error(`Unknown command: ${command}. Run 'jev --help' for usage.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const result = errorResult(error);
      if (process.argv.includes("--json") && process.argv[2] === "decide")
        stdout.write(
          `${JSON.stringify({ contractVersion: "1", error: true, detail: result.error_detail })}\n`,
        );
      stderr.write(
        `[ERROR] ${typeof result.error_detail === "string" ? result.error_detail : JSON.stringify(result.error_detail)}\n`,
      );
      process.exitCode =
        error instanceof SyntaxError ||
        error instanceof ZodError ||
        (error instanceof Error &&
          /option|input|argument|requires|invalid|expected|unknown command/i.test(
            error.message,
          ))
          ? 2
          : 1;
    });
