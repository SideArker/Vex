import type { JevAdapter, JevDecisionResult } from "../jev/adapter.js";

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
