# Developer & Contributor Guide

This document outlines the development workflow, project architecture, test practices, and contributor conventions for the Vex and Jev repository.

---

## 1. Prerequisites & Environment

- **Node.js**: `v20.0.0` or newer.
- **npm**: `v9.0.0` or newer.
- **API Key (Optional for development)**:
  - Unit tests use mocked engines and require no API key or network access.
  - Live tests require an OpenRouter API key set via `OPENROUTER_API_KEY` or `~/.openrouter_key`.

---

## 2. Repository Layout

```text
.
├── src/
│   ├── index.ts              # Entry point for 'vex' CLI and MCP stdio launcher
│   ├── cli/
│   │   ├── jev.ts            # 'jev' CLI commands, argument parsing, and handlers
│   │   └── workflow.ts       # Agent workflow context schema and summarizer
│   ├── core/
│   │   ├── engine.ts         # OpenRouter Decisions HTTP client & key resolution
│   │   ├── schemas.ts        # Zod request, response, and decision schemas
│   │   └── decisions.ts      # Bounded choice, abstention, and lead threshold math
│   └── mcp/
│       └── server.ts         # Model Context Protocol stdio server setup
├── tests/
│   ├── cli_process.test.ts   # Subprocess integration tests for jev and vex bins
│   ├── core.test.ts          # Core engine, schema, and threshold unit tests
│   ├── public_contract.test.ts # Public API contract and abstention tests
│   └── tsconfig.json         # Vitest TypeScript configuration
├── integrations/
│   └── codex/                # Reference integration guides for Codex and Pace
├── docs/                     # Detailed architectural, agent, and CLI documentation
├── package.json              # Package definition, scripts, and dependencies
└── tsconfig.json             # Root TypeScript compilation configuration
```

---

## 3. Development Commands

| Command | Action |
|---|---|
| `npm ci` | Install exact package dependencies |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm run check` | Run TypeScript type-checker on `src/` and `tests/` without emitting |
| `npm test` | Run build and execute Vitest test suite |
| `npm run dev` | Execute `src/index.ts` directly with `tsx` |
| `npm pack --dry-run` | Validate npm packaging without publishing |

---

## 4. Testing Conventions

- **Zero-Network Invariant**:
  All automated tests in `tests/` must run hermetically without requiring an external internet connection or live API key.
- **Mocking Strategy**:
  Unit tests pass a custom `fetchImpl` or mock `keyProvider` via `EngineOptions` to `decide()`, `decideTyped()`, or `createServer()`.
- **Subprocess Testing**:
  `tests/cli_process.test.ts` spawns built artifacts in `dist/` to verify process exit codes, stdout framing, and stderr diagnostics. Ensure `npm run build` has run before testing.

---

## 5. Coding & Contribution Rules

1. **Strict TypeScript & ESM**:
   All source code is ES Modules (`"type": "module"`). Use explicit `.js` extensions in imports (e.g. `import { decide } from "./engine.js"`).
2. **Deterministic Error Handling**:
   Use `DecisionError` for domain-specific errors. Preserve HTTP status and structured error details for debugging.
3. **Stdout Protocol Hygiene**:
   For the MCP server (`src/mcp/server.ts`), `stdout` is reserved exclusively for JSON-RPC messages. Never log debugging statements to `stdout`; use `stderr` instead.
4. **Atomic Git Commits**:
   Follow repository rule: commit frequently with **2 to 4 files** changed per commit. Use descriptive Conventional Commit messages (e.g., `feat(mcp): ...`, `fix(cli): ...`, `docs: ...`).
