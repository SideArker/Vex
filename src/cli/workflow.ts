import { z } from "zod";
import { selectChoice } from "../core/decisions.js";
import {
  DEFAULT_MODEL,
  type DecisionRequest,
  type DecisionResponse,
} from "../core/schemas.js";

const candidates = z
  .record(z.string().min(1), z.string().min(1))
  .refine(
    (value) =>
      Object.keys(value).length >= 2 && Object.keys(value).length <= 12,
    "Expected 2-12 candidates",
  );
export const workflowContextSchema = z
  .object({
    runtime: z.enum(["codex", "antigravity"]),
    task: z.string().min(1),
    tools: candidates.optional(),
    agents: candidates.optional(),
    models: candidates.optional(),
    evidence: z.string().min(1).optional(),
    acceptance: z.string().min(1).optional(),
    proposed_action: z.string().min(1).optional(),
  })
  .strict();
export type WorkflowContext = z.infer<typeof workflowContextSchema>;

/** Legacy CLI workflow helper. Runtime-specific policy stays outside the Jev core. */
export function buildWorkflowRequest(input: WorkflowContext): DecisionRequest {
  const context = workflowContextSchema.parse(input);
  if (context.runtime === "antigravity" && context.models)
    throw new Error("Model routing is available only for Codex");
  const questions: DecisionRequest["questions"] = {};
  const choices: Array<["tools" | "agents" | "models", string, string]> = [
    [
      "tools",
      "tool",
      "Which available tool best advances the task at this step? Choose none if more facts are needed first.",
    ],
    [
      "agents",
      "agent",
      "Which available specialist should handle the next bounded task? Choose self for a short dependent step.",
    ],
    [
      "models",
      "model",
      "Which available Codex model is appropriate for the next agent or session, given task difficulty and cost?",
    ],
  ];
  for (const [field, id, instructions] of choices)
    if (context[field])
      questions[id] = {
        type: "choice",
        instructions,
        criteria: context[field]!,
      };
  if (context.evidence)
    Object.assign(questions, {
      enough_information: {
        type: "noul",
        instructions:
          "Is the observed evidence sufficient to choose and perform the next step without guessing?",
        criteria: {
          true: "Key facts and constraints for the next step are known",
          false: "A material fact is missing",
        },
      },
      needs_verification: {
        type: "noul",
        instructions:
          "Does the reported result still need task-relevant verification before claiming completion?",
        criteria: {
          true: "A material acceptance condition has not been checked",
          false: "Relevant checks already support the result",
        },
      },
      task_complete: {
        type: "noul",
        instructions:
          "Do the observed results satisfy all stated acceptance conditions?",
        criteria: {
          true: "Every condition has supporting evidence",
          false: "Work or verification remains",
        },
      },
    });
  if (context.proposed_action)
    questions.human_review = {
      type: "noul",
      instructions:
        "Would a human decision materially improve this proposed action because intent, requirements, or consequences are uncertain?",
      criteria: {
        true: "Material ambiguity requires a human choice",
        false: "Authorized scope and evidence support autonomous action",
      },
    };
  if (Object.keys(questions).length === 0)
    throw new Error(
      "Workflow requires candidates, evidence, or proposed_action",
    );
  const { tools, agents, models, ...state } = context;
  return { model: DEFAULT_MODEL, state, questions };
}

export interface WorkflowSummary {
  human_review_recommended: boolean;
  next_steps: string[];
  selections: Record<string, string>;
}
export function summarizeWorkflow(
  response: DecisionResponse,
  request: DecisionRequest,
): WorkflowSummary {
  const summary: WorkflowSummary = {
    human_review_recommended: false,
    next_steps: [],
    selections: {},
  };
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = response.answers[name];
    if (!answer || answer.type !== question.type) {
      summary.human_review_recommended = true;
      summary.next_steps.push(`Missing or invalid ${name} answer`);
      continue;
    }
    if (question.type === "choice") {
      const selected = selectChoice(response, name, question.criteria);
      if (selected.choice) summary.selections[name] = selected.choice;
      else {
        summary.human_review_recommended = true;
        summary.next_steps.push(`Uncertain ${name} choice`);
      }
    } else if (question.type === "noul" && answer.type === "noul") {
      const value = answer.noul;
      if (name === "human_review" && value >= 0.4) {
        summary.human_review_recommended = true;
        summary.next_steps.push(
          value >= 0.6
            ? "Jev recommends human review"
            : "Human review decision is uncertain",
        );
      }
      if (name === "enough_information" && value < 0.7)
        summary.next_steps.push("Gather more information");
      if (name === "needs_verification" && value >= 0.5)
        summary.next_steps.push("Verify result");
      if (name === "task_complete" && value < 0.8)
        summary.next_steps.push("Task completion unproven");
    }
  }
  return summary;
}
