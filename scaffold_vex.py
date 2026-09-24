#!/usr/bin/env python3
"""Create a minimal Vex (Jev-to-Codex MCP integration) repository.

Usage:
    python scaffold_vex.py vex
    python scaffold_vex.py .

Existing files are never overwritten. This scaffolds an integration project;
it does not pretend to implement Jev's undocumented CLI contract.
"""

from pathlib import Path
import argparse
import textwrap

GITIGNORE = r"""# Dependencies
node_modules/

# Compiled output and caches
dist/
build/
*.tsbuildinfo
.cache/

# Python scaffold artifacts
__pycache__/
*.pyc
.venv/

# Test coverage
coverage/
.nyc_output/

# Environment variables / secrets
.env
.env.*
!.env.example
*.pem
*.key

# Logs and runtime data
logs/
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.vex/

# Temporary files
.tmp/
tmp/
*.tmp

# Local editor settings
.vscode/*
!.vscode/extensions.json
.idea/
*.swp
*.swo
*~

# OS artifacts
.DS_Store
Thumbs.db
Desktop.ini
"""

FILES = {
    ".gitignore": GITIGNORE,
    "package.json": r'''{
      "name": "vex-mcp",
      "version": "0.1.0",
      "private": true,
      "type": "module",
      "description": "Vex: Jev decision-tool integration for coding agents",
      "scripts": {
        "dev": "tsx src/index.ts",
        "build": "tsc --project tsconfig.json",
        "test": "vitest run",
        "check": "tsc --noEmit"
      },
      "dependencies": {
        "@modelcontextprotocol/sdk": "^1.0.0",
        "zod": "^3.0.0"
      },
      "devDependencies": {
        "@types/node": "^22.0.0",
        "tsx": "^4.0.0",
        "typescript": "^5.0.0",
        "vitest": "^3.0.0"
      },
      "engines": {"node": ">=20"}
    }''',
    "tsconfig.json": r'''{
      "compilerOptions": {
        "target": "ES2022",
        "lib": ["ES2022"],
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "rootDir": "src",
        "outDir": "dist",
        "strict": true,
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true,
        "declaration": true
      },
      "include": ["src/**/*.ts"],
      "exclude": ["node_modules", "dist", "tests"]
    }''',
    ".env.example": r'''# Optional override to locate your existing Jev executable.
# Do not put passwords or access tokens in this file.
JEV_EXECUTABLE=jev
# JEV_TIMEOUT_MS=10000
''',
    "README.md": r'''# Vex

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
''',
    "ROADMAP.md": r'''# Vex roadmap

## v0.1: Skill decisions
- Inspect existing Jev CLI and settle a stable machine-readable contract.
- Implement stdio MCP server and `choose_skill` (allowed choices only).
- Handle timeouts, malformed Jev output and `none` fallback.
- Offline tests and one real local smoke test.

## v0.2: Next-action decisions
- Add `choose_next_action` for limited choices proposed by Codex.
- Include evidence and uncertainty, without acting as a coding agent.
- Document when Codex should skip Jev.

## v0.3: Codex integration
- Installable AGENTS.md guidance and verified Codex CLI/IDE configuration.
- Optional prompt hook only when supported and measured beneficial.
- Avoid duplicate Jev calls when another orchestrator already routed the task.

## v0.4: Evaluation
- Benchmark with/without Jev: total tokens, latency, success and corrections.
- Add opt-in local diagnostics without logging sensitive prompt content.
''',
    "src/index.ts": r'''// Entry point: the MCP stdio server will be wired here after verifying
// the Jev CLI contract. Do NOT write banners/logs to stdout in an MCP server.
process.stderr.write(
  "Vex scaffold ready. Implement the Jev adapter and MCP stdio server before use.\\n",
);
''',
    "src/jev/adapter.ts": r'''/**
 * Jev adapter boundary. Inspect the actual `jev --help` output and add only
 * documented arguments/formats. Never interpolate user input into shell text.
 */
export interface JevDecisionRequest {
  decision: "choose_skill" | "choose_next_action";
  objective: string;
  options: Array<{ id: string; description: string }>;
  context?: string;
}

export interface JevDecisionResult {
  choice: string | null;
  reason?: string;
}

export interface JevAdapter {
  decide(request: JevDecisionRequest): Promise<JevDecisionResult>;
}
''',
    "src/tools/choose_skill.ts": r'''import type { JevAdapter, JevDecisionResult } from "../jev/adapter.js";

/** Reject any option invented by Jev; null means defer to Codex. */
export async function chooseSkill(
  jev: JevAdapter,
  task: string,
  skills: Array<{ id: string; description: string }>,
): Promise<JevDecisionResult> {
  if (skills.length === 0) return { choice: null, reason: "No skills offered" };
  const result = await jev.decide({
    decision: "choose_skill",
    objective: task,
    options: skills,
  });
  if (result.choice === null) return result;
  if (!skills.some((skill) => skill.id === result.choice)) {
    return { choice: null, reason: "Jev returned an unavailable skill" };
  }
  return result;
}
''',
    "src/tools/choose_next_action.ts": r'''import type { JevAdapter, JevDecisionResult } from "../jev/adapter.js";

/** Suggestions only; Codex remains responsible for actions and verification. */
export async function chooseNextAction(
  jev: JevAdapter,
  objective: string,
  options: Array<{ id: string; description: string }>,
  context?: string,
): Promise<JevDecisionResult> {
  if (options.length === 0) return { choice: null, reason: "No actions offered" };
  const result = await jev.decide({
    decision: "choose_next_action",
    objective,
    options,
    context,
  });
  if (result.choice === null) return result;
  if (!options.some((option) => option.id === result.choice)) {
    return { choice: null, reason: "Jev returned an unavailable action" };
  }
  return result;
}
''',
    "src/mcp/server.ts": r'''// TODO: Verify the installed @modelcontextprotocol/sdk version, then
// expose choose_skill and choose_next_action using documented stdio APIs.
// Do not write anything except MCP protocol messages to stdout.
export {};
''',
    "integrations/codex/README.md": r'''# Codex integration (planned)

Once the MCP server is functional, register it using the currently documented
Codex MCP configuration. These files are templates, not automatically installed.

Add AGENTS.md guidance for **when** to invoke Jev. Treat Jev's response as a
recommendation; explicit user instructions and tool permissions take priority.

Don't distribute an unverified hook configuration or claim it forces all agent
calls through Jev.
''',
    "integrations/codex/AGENTS.example.md": r'''# Optional Jev guidance for Codex

Use the configured Vex tool only when choosing among plausible skills or when
multiple reasonable next actions remain after inspecting relevant evidence.
Supply concise task context and bounded choices; skip for obvious actions.
Treat the result as advice, not proof of correctness. Never delegate coding
or security and permission decisions to Jev.
''',
    "tests/choose_skill.test.ts": r'''import { describe, expect, it } from "vitest";
import { chooseSkill } from "../src/tools/choose_skill.js";
import type { JevAdapter } from "../src/jev/adapter.js";

const skills = [
  { id: "slides", description: "Create presentations" },
  { id: "pdf", description: "Create PDFs" },
];

describe("chooseSkill", () => {
  it("accepts a selected available skill", async () => {
    const jev: JevAdapter = { decide: async () => ({ choice: "slides" }) };
    expect((await chooseSkill(jev, "Make slides", skills)).choice).toBe("slides");
  });
  it("rejects a hallucinated skill", async () => {
    const jev: JevAdapter = { decide: async () => ({ choice: "unknown" }) };
    expect((await chooseSkill(jev, "Make slides", skills)).choice).toBeNull();
  });
  it("does not call Jev without options", async () => {
    const jev: JevAdapter = { decide: async () => { throw Error("must not call"); } };
    expect((await chooseSkill(jev, "anything", [])).choice).toBeNull();
  });
});
''',
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", nargs="?", default="vex", help="Directory to create (default: vex)")
    args = parser.parse_args()
    root = Path(args.destination).expanduser()
    created = []
    skipped = []
    for relative, body in FILES.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open("x", encoding="utf-8", newline="\n") as handle:
                handle.write(textwrap.dedent(body).lstrip("\n"))
            created.append(relative)
        except FileExistsError:
            skipped.append(relative)
    print(f"Vex scaffold: {root.resolve()}")
    print(f"Created {len(created)} files, skipped {len(skipped)} existing files.")
    for file in created:
        print(f"  + {file}")
    for file in skipped:
        print(f"  = {file} (preserved)")
    print("Next: cd into the directory, run npm install, npm run check, and npm test.")


if __name__ == "__main__":
    main()
