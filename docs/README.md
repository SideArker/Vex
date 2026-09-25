# Vex & Jev Agent Documentation

Welcome to the **Vex & Jev** documentation hub. This directory contains detailed guides, architectural specifications, and integration manuals designed for AI coding agents and human engineers.

---

## 1. Documentation Index

| Guide | Description | Target Audience |
|---|---|---|
| [**Architecture**](./architecture.md) | Deep dive into core engine, type systems (`choice`, `score`, `noul`), abstention mechanics, threshold equations, and MCP transport. | Agents, System Architects |
| [**Agent Integration**](./agent-integration.md) | Complete integration handbook for autonomous agents (Codex, Antigravity, Claude, Cursor): patterns, rules, abstention handling, and code snippets. | Autonomous Agents, Framework Authors |
| [**CLI Reference**](./cli-reference.md) | Technical manual of all `jev` and `vex` commands, arguments, JSON contracts, piping, and exit code specifications. | Agents, Script Authors, Operators |
| [**Development Guide**](./development.md) | Repository organization, developer workflow, Vitest testing, TypeScript compilation, and commit policies. | Contributors, Builder Agents |

---

## 2. Core Agent Guardrails

When developing or integrating with Vex & Jev, agents must adhere to the following rules:

1. **Advisory Invariant**:
   Jev returns typed judgments and probability-backed choices; it never executes tools or applies mutations. The executing agent retains sole responsibility for safety and verification.
2. **Deterministic Bounded Choices (2–12 Options)**:
   Never present open-ended choices. Provide 2 to 12 distinct, mutually exclusive options with clear descriptions.
3. **Respect Abstention Signals**:
   If Jev returns `choice: null` (`abstained: true`), confidence is below $0.70$ or probability lead is below $0.15$. The agent must **not** force an action or guess.
4. **Context Sanitization**:
   Never transmit API keys, secrets, or unbounded files. Provide concise summaries of relevant facts and constraints.
5. **Small Atomic Commits**:
   Per repository policy, maintain atomic git commits affecting **2 to 4 files** at a time.
