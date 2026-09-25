# Vex and Jev

This package contains a standalone TypeScript Jev client and a Vex MCP stdio server. Both call the [OpenRouter Decisions endpoint](https://openrouter.ai/blog/insights/what-is-jev/) through `src/core/engine.ts`. Jev supplies typed `choice`, `score`, and `noul` judgments; the caller remains responsible for its actions and verification.

## Build and run

Requires Node.js 20 or newer. In this repository:

```sh
npm ci
npm run build
node dist/cli/jev.js --help
node dist/cli/jev.js doctor
node dist/index.js --help
node dist/index.js mcp serve
```

The package exposes two cross-platform npm bins: `jev` for the CLI and `vex` for the Vex command. A local install or `npm exec -- jev --help` can run the CLI without a global install. `vex mcp serve` is a stdio MCP server: it stays running and waits for a connected client, so an idle terminal can appear blank. After startup it prints a readiness hint to stderr; protocol messages go only to stdout. Errors also go to stderr. `vex --help`, `vex --version`, and `vex doctor` work without starting the server.

Before changing any installation, check command resolution with `command -v jev` on Unix or `Get-Command jev -All` in PowerShell. Back up any existing Jev configuration, key file, and local stats that matter to you. From this repository, `npm install --prefix ./local-install .` creates an isolated local installation without replacing a global bin; then run `./local-install/node_modules/.bin/jev --help` (or the `.cmd` shim on Windows). Check command resolution again before adding that bin directory to `PATH`. A local checkout can always use `node dist/cli/jev.js` and `node dist/index.js` directly. Roll back by removing the new PATH entry or MCP command and restoring the previous one.

Set `OPENROUTER_API_KEY` in the process environment, or use an existing `~/.openrouter_key` file from the older Jev client. This package does not write or replace that file. `doctor` checks availability without making a paid API request. Never pass a key as a command argument.

## Bounded decision contract

`jev decide request.json` prints a human-readable choice. For a quick decision, run `jev decide "What next?" --option "review=Review docs" --option "none=Gather evidence" --context "Tests passed" --constraint "No network"`. Repeat `--option` for each choice and `--constraint` for each constraint. `jev decide --json` reads one request JSON from stdin and prints exactly one versioned result JSON to stdout. The reusable `decide(request)` function and MCP `vex_choose` tool use the same validator and decision path. A request has `question`, optional `context`, two to twelve unique `options`, optional `decisionType: "choice"`, and optional `constraints`:

```json
{
  "question": "Which action advances this task?",
  "context": "Tests pass; docs need review",
  "options": [
    { "id": "review", "description": "Review documentation" },
    { "id": "none", "description": "Gather more evidence" }
  ]
}
```

A successful result is `{ "contractVersion": "1", "choice": "review", "abstained": false, "confidence": 0.9, "probabilities": { ... } }`. When Jev returns an unlisted choice, malformed probabilities, confidence below `0.70`, or a probability lead below `0.15`, the result has `choice: null` and `abstained: true`. An internal abstention option lets Jev decline even with high confidence; it is omitted from public probabilities. `--json` prints one structured result or error object.

Exit codes for `jev decide`: `0` for a choice or abstention, `1` for missing key, network, or upstream failure, and `2` for malformed input or usage. `jev doctor` and `vex doctor` return `0` when a key is available and `1` when it is missing. Help and version commands return `0`.

## Typed Jev commands

`jev run request.json --raw` accepts a JSON object with `state`, `questions`, optional `model`, and optional `session_id`. Unknown top-level and question fields are rejected. `state` is nonempty text or an object. Each question has `type`, `instructions`, and `criteria`:

```json
{
  "state": "Choose a tool for this task",
  "questions": {
    "tool": {
      "type": "choice",
      "instructions": "Which tool is appropriate?",
      "criteria": { "read": "Inspect files", "none": "More facts are needed" }
    }
  }
}
```

`choice` uses two or more described IDs; `score` uses an ordered array of two or more labels; `noul` uses descriptions for `true` and `false`. `--raw` returns the validated OpenRouter response plus `_elapsed_seconds`. `--out path` saves the same JSON, even when the display is a summary. API and network failures return a nonzero exit status. `eval` accepts separate state and questions files. `route` accepts a state file and described routes file and applies the conservative choice threshold.

`jev workflow context.json --raw` constructs narrow questions from `runtime`, `task`, optional `tools`, `agents`, `models`, `evidence`, and `proposed_action`. The JSON output contains `response` and `workflow`. A workflow choice is accepted only when its ID is supplied, confidence is at least `0.70`, and its probability leads other options by at least `0.15`. Otherwise it abstains. Model routing is limited to Codex. Human review signals are advisory; they never grant permission.

The CLI also supports `triage`, `gate`, `verify-diff`, and `suggest-skill` (`suggest` alias). Skill selection takes an explicit catalog with `-c catalog.json`, which avoids silently reading and sending local skill descriptions. Use `--help` for arguments. These commands produce the same typed raw response contract; their prose summaries are intentionally compact.

## MCP

Configure an MCP stdio client to launch `node /absolute/path/to/Vex/dist/index.js mcp serve` or `vex mcp serve`. The server exposes `vex_choose` using the bounded decision contract above, plus `vex_workflow` using the CLI workflow context and thresholded summary. Include `none` or another abstention option if it is a valid outcome. A tool result is advice, not permission to act.

For clients that accept a JSON stdio server entry, the equivalent command is:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/Vex/dist/index.js", "mcp", "serve"]
}
```

The client registers that process as an MCP server and calls `vex_choose` with the bounded request fields above, or `vex_workflow` with `runtime`, `task`, and described `tools`, `agents`, or `models` candidates. The workflow tool returns `{ response, workflow }` in MCP `structuredContent`. Only IDs in `workflow.selections` passed the choice threshold; an absent ID means abstain. Pace should represent a complete model, effort, and agent route as one `models` candidate to avoid incompatible independent selections. See the [Codex integration example](integrations/codex/README.md). Configuration wrappers vary by client.

Pace can instead use Jev as a subprocess with one JSON request on stdin and one JSON result on stdout. For example, from a Node.js worker:

```js
import { spawn } from "node:child_process";
import { once } from "node:events";

// Resolve the installed Jev bin on PATH; Windows uses its npm .cmd shim.
const child = spawn(process.platform === "win32" ? "jev.cmd" : "jev", ["decide", "--json"], {
  stdio: ["pipe", "pipe", "inherit"],
  shell: process.platform === "win32"
});
child.stdin.end(JSON.stringify({
  question: "Which route handles this request?",
  options: [
    { id: "build", description: "Implement a change" },
    { id: "none", description: "Gather more information" }
  ]
}));
let output = "";
for await (const chunk of child.stdout) output += chunk;
const [exitCode] = await once(child, "close");
if (exitCode !== 0) throw new Error(`Jev failed with exit code ${exitCode}: ${output}`);
const result = JSON.parse(output);
```

Jev never executes the selected route.

For Codex, see [integration guidance](integrations/codex/README.md). Do not send secrets, full repositories, or sensitive diffs to OpenRouter. The request body contains the supplied state and questions.

## Migration from `data/jev`

The older Python and JavaScript clients remain in `data/jev` as preserved reference data. The forward path is: back up existing key and stats files if they matter, install this package locally, run `jev doctor`, compare a sanitized `run --raw` request using the old and new clients, then update the desired shell or MCP configuration. Check which `jev` executable appears first on `PATH` before changing global links. The rollback path is to point your shell or MCP configuration back to the previous executable; this package does not remove the older clients or rewrite their stats.

The TypeScript client keeps the Decisions endpoint, default `typesafe/jev-1.13` model, request/response JSON shape, and workflow thresholds. It does not migrate the old local usage statistics file or query account credits. Use OpenRouter account tools for billing records.

## Verify

```sh
npm run check
npm test
npm run build
npm pack --dry-run
```

The tests mock network responses and require no API key. A paid live decision request is optional and should use sanitized input.
