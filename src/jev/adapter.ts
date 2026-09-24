/**
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
