# Vex roadmap

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
