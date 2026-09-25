# CLI Command Reference

This document provides a complete technical manual for the `jev` and `vex` command-line interfaces, including syntax, flags, JSON contracts, and exit codes.

---

## 1. Overview & Binary Resolution

The package provides two executables:
- `jev`: High-level and low-level decision CLI.
- `vex`: MCP stdio server launcher and health diagnostics.

### Resolution & Execution
```sh
# Local repository
node dist/cli/jev.js --help
node dist/index.js --help

# When installed globally or via npm link
jev --help
vex --help

# Execution without installation
npm exec -- jev --help
npm exec -- vex --help
```

---

## 2. Command Index

### 2.1 `jev decide`
Make a single bounded choice decision between 2 and 12 options.

#### Human CLI Flags Syntax
```sh
jev decide "Which database driver to adopt?" \
  --option "pg=node-postgres with connection pooling" \
  --option "prisma=Prisma ORM with schema management" \
  --option "kysely=Kysely type-safe SQL query builder" \
  --context "High-throughput microservice, low overhead critical" \
  --constraint "Avoid heavy query generators"
```

#### JSON Stdin / File Syntax
```sh
# Via JSON file
jev decide request.json

# Via stdin pipe with JSON output
cat request.json | jev decide --json
```

#### JSON Request Schema (`request.json`)
```json
{
  "question": "Which task to execute next?",
  "context": "All unit tests pass; documentation is outdated.",
  "options": [
    { "id": "docs", "description": "Update documentation files" },
    { "id": "refactor", "description": "Refactor database module" },
    { "id": "none", "description": "Wait for user confirmation" }
  ],
  "constraints": ["Do not modify runtime code"]
}
```

#### Output Formats
- **Standard (Human readable)**:
  ```text
  Choice: docs (confidence: 0.92)
  # Or on abstention:
  Abstain (confidence: 0.54) — Insufficient confidence or probability lead
  ```
- **Machine (`--json`)**:
  ```json
  {
    "contractVersion": "1",
    "choice": "docs",
    "abstained": false,
    "confidence": 0.92,
    "probabilities": {
      "docs": 0.78,
      "refactor": 0.12,
      "none": 0.10
    }
  }
  ```

---

### 2.2 `jev workflow`
Evaluates multi-dimensional agent workflow context: tool choice, specialist agent choice, model route, evidence sufficiency, verification need, and human review recommendation.

```sh
jev workflow context.json
jev workflow context.json --raw
jev workflow context.json --out output.json
```

#### Workflow Context Schema (`context.json`)
```json
{
  "runtime": "codex",
  "task": "Migrate auth token to JWT format",
  "tools": {
    "view_file": "Read current auth token logic",
    "run_tests": "Run auth test suite",
    "none": "Gather more context"
  },
  "agents": {
    "self": "Continue investigation directly",
    "security_specialist": "Delegate to security expert"
  },
  "models": {
    "luna-low-builder": "gpt-6-luna, low reasoning, quick edits",
    "sol-medium-builder": "gpt-6-sol, medium reasoning, standard edits"
  },
  "evidence": "Legacy token uses plain SHA256; requirements mandate RS256 JWT.",
  "acceptance": "Tokens signed with RS256, verified with public key.",
  "proposed_action": "Introduce jsonwebtoken dependency"
}
```

---

### 2.3 `jev triage`
Classify an engineering task into task type, estimated scope, database migration requirement, risk level, and human architect confirmation requirement.

```sh
# Positional string
jev triage "Fix race condition in background invoice generation"

# From file
jev triage --file task_description.txt --raw
```

#### Evaluated Questions:
- `task_type`: `bug_fix`, `feature`, `refactor`, `code_review`, `investigation`, `question_docs`.
- `scope_size`: `Narrow`, `Medium`, `Broad`.
- `touches_db`: Boolean (`true` / `false`).
- `risk_level`: `Low`, `Medium`, `High`.
- `needs_architect_confirmation`: Boolean (`true` / `false`).

---

### 2.4 `jev gate`
Evaluate whether a proposed action is destructive or requires escalation to a human architect.

```sh
jev gate "Drop legacy column user_legacy_hash in production migration"
```

#### Evaluated Questions:
- `is_destructive`: `true` (Data loss or irreversible) vs `false` (Safe or reversible).
- `escalate_to_human_architect`: `true` (Material ambiguity/consequence) vs `false` (Authorized standard action).

---

### 2.5 `jev verify-diff`
Audit a git diff (up to 15,000 characters) for obvious syntax/contract breaks, unrelated code alterations, and overall quality score.

```sh
git diff HEAD~1 | jev verify-diff -
jev verify-diff diff.patch --raw
```

#### Evaluated Questions:
- `introduces_syntax_or_contract_break`: Boolean (`true` / `false`).
- `alters_unrelated_code`: Boolean (`true` / `false`).
- `quality_score`: `Poor`, `Acceptable`, `High`.

---

### 2.6 `jev suggest-skill` / `jev suggest`
Match an engineering task to the most appropriate skill from a provided skill catalog.

```sh
jev suggest-skill "Diagnose why WebSocket connections drop randomly" -c skills_catalog.json
```

#### Catalog Schema (`skills_catalog.json`)
```json
{
  "investigate-first": "Diagnose ambiguous failures before editing code",
  "surgical-patch": "Fix bugs at narrowest responsible layer",
  "safe-refactor": "Restructure code while preserving behavior",
  "migration": "Implement reversible compatibility-safe transitions"
}
```

---

### 2.7 `jev run` & `jev eval`
Low-level execution of custom typed Decisions requests (`choice`, `score`, `noul`).

```sh
# Single unified request file
jev run custom_request.json --raw

# Separated state and questions files
jev eval -s state.txt -q questions.json --raw
```

---

### 2.8 `jev route`
Choose from a set of described routes based on input state, applying the $0.70$ confidence threshold.

```sh
jev route input_state.txt -r routes.json
```

---

### 2.9 `jev doctor` & `vex doctor`
Verify runtime environment and OpenRouter API key accessibility without sending a paid API call.

```sh
jev doctor
# Output:
# Jev 0.1.0
# Node v22.18.0
# OpenRouter key: available
# Model: typesafe/jev-1.13

vex doctor
# Output:
# Vex 0.1.0
# Node v22.18.0
# OpenRouter key: available
```

---

### 2.10 `vex mcp serve`
Launch the Vex Model Context Protocol (MCP) server over standard I/O (stdio).

```sh
vex mcp serve
# Server stays running listening on stdin/stdout for MCP client JSON-RPC frames.
# Diagnostics and readiness hint are sent to stderr.
```

---

## 3. Exit Codes

All CLI commands follow strict exit code conventions:

| Exit Code | Meaning | Examples |
|:---:|---|---|
| `0` | Success | Valid choice made, model abstained safely, doctor verified key, help/version displayed |
| `1` | API / Network Failure | Missing OpenRouter API key, network timeout, HTTP 4xx/5xx from OpenRouter |
| `2` | Bad Usage / Invalid Input | Zod schema validation error, invalid command flags, malformed JSON |
