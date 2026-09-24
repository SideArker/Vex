import type { JevAdapter, JevDecisionResult } from "../jev/adapter.js";

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
