# Agent Integration Guide

This guide describes how autonomous coding agents (Codex, Antigravity, Claude Desktop, Cursor Agent, custom agent loops) should integrate and interact with Vex and Jev.

---

## 1. Core Principles for Agents

When calling Vex or Jev:

1. **Jev is Advisory, Not an Executor**:
   Jev provides typed judgments and decisions. It **never** executes tools, edits files, or runs commands. The calling agent remains solely responsible for tool execution, verification, and safety.
2. **Deterministic Bounded Options (2 to 12 Options)**:
   Every choice decision must present 2 to 12 explicit, mutually exclusive options with clear descriptions. Never pass an open-ended question without options.
3. **Include Fallback or Abstention Options**:
   If doing nothing or gathering more information is a valid path, include an option such as `none` or `gather_facts` in your options list.
4. **Respect Abstention Signals**:
   When Jev returns `abstained: true` (or `choice: null`), the evidence is insufficient or confidence is below threshold ($< 0.70$). **Never force an action when Jev abstains**. Fall back to gathering more evidence, diagnosing the state, or prompting the user.
5. **Sanitize Context**:
   Never transmit raw passwords, API keys, entire repositories, or huge terminal logs to Jev. Provide concise, sanitized summaries of relevant facts and constraints.

---

## 2. Decision Thresholds & The Abstention Contract

When an agent calls `vex_choose` or `jev decide`:

```json
{
  "question": "Which action should be taken next?",
  "context": "Build passed; unit tests failed with AssertionError on auth check.",
  "options": [
    { "id": "inspect_test", "description": "Inspect the failing auth test" },
    { "id": "check_diff", "description": "Review the recent git diff for auth changes" },
    { "id": "gather_logs", "description": "Gather raw execution logs" }
  ],
  "constraints": "Do not edit production code yet"
}
```

### Result Schema
```json
{
  "contractVersion": "1",
  "choice": "inspect_test",
  "abstained": false,
  "confidence": 0.88,
  "probabilities": {
    "inspect_test": 0.65,
    "check_diff": 0.25,
    "gather_logs": 0.10
  }
}
```

### How the Agent Must Handle Results:
- **`choice !== null` and `abstained === false`**: Proceed with the chosen option. Verify the outcome after acting.
- **`abstained === true`**:
  - Check `reason`:
    - `"Insufficient information"`: The agent omitted key context needed to make a choice.
    - `"Insufficient confidence or probability lead"`: The options are too ambiguous or close in probability ($< 15\%$ lead).
  - Agent Action: Do not guess. Default to an exploratory/read-only step or ask the user for clarification.

---

## 3. Workflow Evaluation (`vex_workflow`)

For complex agent loops, `vex_workflow` provides simultaneous evaluation of tools, specialist agents, models (Codex only), evidence completeness, verification need, and human review signals.

### Agent Workflow Input
```json
{
  "runtime": "codex",
  "task": "Fix race condition in database connection pool",
  "tools": {
    "view_file": "Inspect connection pool implementation",
    "run_tests": "Run existing pool tests",
    "none": "Gather more context first"
  },
  "agents": {
    "self": "Continue investigation directly",
    "database_specialist": "Delegate to specialized DB investigator"
  },
  "models": {
    "gpt-6-medium-builder": "Medium reasoning for standard fix",
    "gpt-6-high-architect": "Deep reasoning for complex concurrency bugs"
  },
  "evidence": "Observed intermittent timeout under 50 concurrent connections; logs indicate deadlock in acquisition queue.",
  "acceptance": "50 concurrent connections complete without deadlock",
  "proposed_action": "Modify lock ordering in connection acquisition"
}
```

### Interpreting Workflow Output
The response includes `structuredContent.workflow`:
- `selections`: Only contains candidate IDs that met the $\ge 0.70$ confidence and $\ge 0.15$ probability lead criteria.
  - If `selections.tool` is missing $\rightarrow$ Tool choice abstained.
  - If `selections.agent` is missing $\rightarrow$ Agent choice abstained.
  - If `selections.model` is missing $\rightarrow$ Model choice abstained; use agent's default.
- `human_review_recommended`: If `true`, the proposed action carries material risk or ambiguity. The agent should solicit user confirmation before proceeding.
- `next_steps`: Actionable guidance array (e.g., `["Gather more information"]`, `["Verify result"]`).

---

## 4. Agent Integration Patterns

### Pattern A: Task Triage & Specialist Selection
Use Jev before diving into a user prompt to classify the task and choose the best persona or skill:

```sh
jev triage "Investigate why checkout latency spiked after v2.4 deployment"
```
Or via MCP:
```json
{
  "name": "vex_choose",
  "arguments": {
    "question": "Which workflow should handle this issue?",
    "context": "User reports checkout latency regression from 200ms to 2.5s post-deploy.",
    "options": [
      { "id": "investigate_first", "description": "Formulate hypotheses and trace logs before editing" },
      { "id": "surgical_patch", "description": "Directly fix known culprit" },
      { "id": "none", "description": "Need more reproduction steps from user" }
    ]
  }
}
```

### Pattern B: Pre-Action Safety Gate
Before running high-risk actions (dropping tables, running migrations, deleting files, large refactors):

```sh
jev gate "git reset --hard origin/main to discard uncommitted changes"
```
If `escalate_to_human_architect` or `is_destructive` evaluates with high probability, pause and ask the user for confirmation.

### Pattern C: Post-Edit Verification Gate
Before claiming task completion or closing an issue:

```json
{
  "name": "vex_workflow",
  "arguments": {
    "runtime": "antigravity",
    "task": "Add validation for user email domain",
    "evidence": "Added regex check in validator.ts; test suite passes with 4 new test cases.",
    "acceptance": "Invalid domains rejected with 400; valid domains accepted with 200.",
    "proposed_action": "Complete task and commit"
  }
}
```
If `next_steps` contains `"Task completion unproven"` or `"Verify result"`, run further verification before concluding.

---

## 5. Integration Code Snippets

### Node.js Subprocess Integration
```typescript
import { spawn } from "node:child_process";
import { once } from "node:events";

export async function askJev(question: string, options: Array<{ id: string; description: string }>, context?: string) {
  const isWin = process.platform === "win32";
  const child = spawn(isWin ? "jev.cmd" : "jev", ["decide", "--json"], {
    stdio: ["pipe", "pipe", "inherit"],
    shell: isWin,
  });

  child.stdin.end(JSON.stringify({ question, options, context }));

  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk;
  }

  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`Jev failed with code ${code}: ${output}`);
  }

  return JSON.parse(output);
}
```

### Python Subprocess Integration
```python
import json
import subprocess
import shutil

def ask_jev(question: str, options: list[dict[str, str]], context: str = None) -> dict:
    cmd = shutil.which("jev") or ("jev.cmd" if shutil.which("jev.cmd") else "jev")
    payload = json.dumps({"question": question, "options": options, "context": context})
    
    proc = subprocess.run(
        [cmd, "decide", "--json"],
        input=payload,
        text=True,
        capture_output=True,
        check=True
    )
    return json.loads(proc.stdout)
```

---

## 6. Antigravity & Codex Specific Directives

### For Codex (with Pace):
- **Universal Decision Tool**: Use `vex_choose` directly for subagent and worker model routing.
- Pass complete model, effort, and agent in a candidate option ID and description (e.g. `{ "id": "luna-low-builder", "description": "gpt-6-luna, low reasoning, builder agent" }`).
- Read `result.choice` to dispatch the subagent.

### For Antigravity:
- **Universal Decision Tool**: Use `vex_choose` as the primary decision engine for tool selection, skill selection, subagent delegation (`self` vs `research`), and architectural choices.
- **Rule**: Antigravity does not support dynamic model routing; never attempt model routing in Antigravity.
- **Rule**: Do not use Jev to override authorization, security sandboxes, or user permissions.
- **Use**: Use `vex_choose` for bounded specialist selection, tool disambiguation when multiple valid tools remain, evidence sufficiency checks, and pre-action safety gating.
