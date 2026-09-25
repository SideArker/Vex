import { decideTyped, type EngineOptions } from "./engine.js";
import {
  DEFAULT_MODEL,
  type DecisionRequest,
  type DecisionResponse,
} from "./schemas.js";

export interface Selection {
  choice: string | null;
  reason?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

/** Only supplied, sufficiently supported choices may leave this boundary. */
export function selectChoice(
  response: DecisionResponse,
  question: string,
  candidates: Record<string, string>,
  threshold = 0.7,
  lead = 0.15,
): Selection {
  const answer = response.answers[question];
  if (
    !answer ||
    answer.type !== "choice" ||
    !Object.hasOwn(candidates, answer.choice)
  )
    return { choice: null, reason: "Missing or unavailable choice" };
  const probabilities = answer.probabilities ?? {};
  const selected = probabilities[answer.choice];
  const others = Object.entries(probabilities)
    .filter(([id]) => id !== answer.choice)
    .map(([, p]) => p);
  if (
    answer.confidence === undefined ||
    answer.confidence < threshold ||
    selected === undefined ||
    (others.length && selected - Math.max(...others) < lead)
  ) {
    return {
      choice: null,
      reason: "Choice did not meet confidence and probability thresholds",
      confidence: answer.confidence,
      probabilities,
    };
  }
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities,
  };
}

export async function chooseOption(
  objective: string,
  options: Record<string, string>,
  question = "choice",
  engine: EngineOptions = {},
): Promise<Selection> {
  if (!objective.trim() || Object.keys(options).length < 2)
    return {
      choice: null,
      reason: "A task and at least two options are required",
    };
  const request: DecisionRequest = {
    state: objective,
    questions: {
      [question]: {
        type: "choice",
        instructions:
          "Choose the best available option. Use an abstention option when available and evidence is insufficient.",
        criteria: options,
      },
    },
  };
  return selectChoice(await decideTyped(request, engine), question, options);
}

export async function routeIntent(
  state: string,
  routes: Record<string, string>,
  options: EngineOptions & { threshold?: number; instructions?: string } = {},
) {
  const response = await decideTyped(
    {
      state,
      questions: {
        intent: {
          type: "choice",
          instructions:
            options.instructions ?? "Which route best handles this input?",
          criteria: routes,
        },
      },
    },
    options,
  );
  const selection = selectChoice(
    response,
    "intent",
    routes,
    options.threshold ?? 0.7,
  );
  return {
    route: selection.choice,
    confidence: selection.confidence ?? 0,
    passed_threshold: selection.choice !== null,
    probabilities: selection.probabilities ?? {},
    usage: response.usage,
    _elapsed_seconds: response._elapsed_seconds,
  };
}

export function formatSummary(response: DecisionResponse): string {
  const usage = response.usage;
  const lines = [
    `Model: ${response.model ?? DEFAULT_MODEL}`,
    `Time: ${(response._elapsed_seconds * 1000).toFixed(1)}ms | Cost: $${(usage?.cost ?? 0).toFixed(6)} | Tokens: ${usage?.input_tokens ?? 0} in / ${usage?.output_tokens ?? 0} out`,
    "Decisions:",
  ];
  for (const [name, answer] of Object.entries(response.answers)) {
    const value =
      answer.type === "choice"
        ? answer.choice
        : answer.type === "score"
          ? answer.score
          : answer.noul;
    lines.push(
      `  - ${name} [${answer.type}]: ${value}${answer.confidence === undefined ? "" : ` (confidence: ${answer.confidence.toFixed(2)})`}`,
    );
  }
  return lines.join("\n");
}
