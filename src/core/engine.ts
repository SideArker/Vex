import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DECISIONS_URL,
  DEFAULT_MODEL,
  boundedDecisionSchema,
  requestSchema,
  responseSchema,
  type BoundedDecisionRequest,
  type BoundedDecisionResult,
  type DecisionRequest,
  type DecisionResponse,
} from "./schemas.js";
import { recordStat } from "./stats.js";

export interface EngineOptions {
  apiKey?: string;
  keyProvider?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  recordStats?: boolean;
  statsFilePath?: string;
  operation?: string;
  source?: "vex" | "jev" | string;
}

export async function resolveApiKey(): Promise<string | null> {
  const environment = process.env.OPENROUTER_API_KEY?.trim();
  if (environment) return environment;
  try {
    return (
      (await readFile(join(homedir(), ".openrouter_key"), "utf8")).trim() ||
      null
    );
  } catch {
    return null;
  }
}

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 0,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

/** One strict, bounded async request path shared by the CLI and MCP server. */
async function callDecisions(
  input: DecisionRequest,
  options: EngineOptions = {},
): Promise<DecisionResponse> {
  const request = requestSchema.parse(input);
  const apiKey =
    options.apiKey?.trim() || (await (options.keyProvider ?? resolveApiKey)());
  if (!apiKey)
    throw new DecisionError(
      "Missing OpenRouter API key. Set OPENROUTER_API_KEY or provide an existing ~/.openrouter_key file.",
    );
  const start = performance.now();
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/typesafe-ai/jev",
        "X-Title": "Jev",
      },
      body: JSON.stringify({
        ...request,
        model: request.model ?? DEFAULT_MODEL,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });
  } catch (cause) {
    throw new DecisionError(
      cause instanceof Error ? cause.message : "Network request failed",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DecisionError(
      "OpenRouter returned invalid JSON",
      response.status,
    );
  }
  if (!response.ok)
    throw new DecisionError(
      `OpenRouter request failed (HTTP ${response.status})`,
      response.status,
      body,
    );
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success)
    throw new DecisionError(
      "OpenRouter returned an invalid decision response",
      response.status,
      parsed.error.flatten(),
    );
  const elapsed = (performance.now() - start) / 1000;
  if (options.recordStats !== false) {
    const operation = options.operation ?? "custom";
    const source =
      options.source ?? (operation.startsWith("vex_") ? "vex" : "jev");
    await recordStat(
      {
        operation,
        source,
        elapsedSeconds: elapsed,
        usage: parsed.data.usage,
      },
      options.statsFilePath,
    ).catch(() => {});
  }
  return {
    ...parsed.data,
    _elapsed_seconds: elapsed,
  };
}

/** Raw typed requests also enforce their own question contract before returning data. */
export async function decideTyped(
  input: DecisionRequest,
  options: EngineOptions = {},
): Promise<DecisionResponse> {
  const request = requestSchema.parse(input);
  const response = await callDecisions(request, {
    operation: options.operation ?? "run",
    ...options,
  });
  if (
    Object.keys(response.answers).length !==
    Object.keys(request.questions).length
  )
    throw new DecisionError("OpenRouter returned missing or extra answers");
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id];
    if (!answer || answer.type !== question.type)
      throw new DecisionError(`Invalid answer type for ${id}`);
    if (question.type === "choice" && answer.type === "choice") {
      if (!Object.hasOwn(question.criteria, answer.choice))
        throw new DecisionError(`Unavailable choice for ${id}`);
      if (
        answer.probabilities &&
        Object.keys(answer.probabilities).some(
          (key) => !Object.hasOwn(question.criteria, key),
        )
      )
        throw new DecisionError(`Invalid probability keys for ${id}`);
    }
    if (
      question.type === "score" &&
      answer.type === "score" &&
      (answer.score < 0 || answer.score > question.criteria.length - 1)
    )
      throw new DecisionError(`Score out of range for ${id}`);
  }
  return response;
}

/** Public bounded decision contract. Every answer is checked against caller options. */
export async function decide(
  input: BoundedDecisionRequest,
  options: EngineOptions = {},
): Promise<BoundedDecisionResult> {
  const request = boundedDecisionSchema.parse(input);
  const abstainId = "__jev_abstain__";
  const criteria = {
    ...Object.fromEntries(
      request.options.map(({ id, description }) => [id, description]),
    ),
    [abstainId]: "Insufficient information to justify any supplied option",
  };
  const state = {
    question: request.question,
    ...(request.context === undefined ? {} : { context: request.context }),
    ...(request.constraints === undefined
      ? {}
      : { constraints: request.constraints }),
  };
  const response = await callDecisions(
    {
      state,
      questions: {
        decision: {
          type: "choice",
          instructions: request.decisionType === "routing"
            ? `Rank every supplied option by probability of meeting the request. Select the highest ranked supplied option even when the lead is small. Exact ties use supplied option order. Do not abstain.`
            : `Choose the best supported option. Choose ${abstainId} when the information is insufficient to justify any caller option.`,
          criteria,
        },
      },
    },
    { operation: options.operation ?? "decide", ...options },
  );
  const answer = response.answers.decision;
  const abstain = (
    reason: string,
    confidence = 0,
    probabilities?: Record<string, number>,
  ): BoundedDecisionResult => ({
    contractVersion: "1",
    choice: null,
    abstained: true,
    confidence,
    ...(probabilities ? { probabilities } : {}),
    reason,
  });
  if (!answer || answer.type !== "choice") {
    if (request.decisionType === "routing") throw new DecisionError("Missing routing answer");
    return abstain("Missing or invalid choice answer");
  }
  const confidence = answer.confidence ?? 0;
  const probabilities = answer.probabilities;
  if (request.decisionType === "routing") {
    if (!probabilities || Object.keys(probabilities).length !== request.options.length + 1 ||
      request.options.some(({ id }) => probabilities[id] === undefined) ||
      probabilities[abstainId] === undefined ||
      Object.keys(probabilities).some((id) => !Object.hasOwn(criteria, id)))
      throw new DecisionError("Invalid routing probabilities");
    const highest = request.options.reduce((best, option) =>
      probabilities[option.id]! > probabilities[best.id]! ? option : best);
    return {
      contractVersion: "1",
      choice: highest.id,
      abstained: false,
      confidence,
      probabilities: Object.fromEntries(request.options.map(({ id }) => [id, probabilities[id]!])),
    };
  }
  if (answer.choice === abstainId)
    return abstain("Insufficient information", confidence);
  if (!Object.hasOwn(criteria, answer.choice))
    return abstain("Choice is not a supplied option", confidence);
  if (
    !probabilities ||
    Object.keys(probabilities).some((id) => !Object.hasOwn(criteria, id))
  )
    return abstain("Invalid probability keys", confidence);
  if (
    Object.keys(probabilities).length !== request.options.length + 1 ||
    probabilities[answer.choice] === undefined
  )
    return abstain("Incomplete probabilities", confidence);
  const other = Math.max(
    ...Object.entries(probabilities)
      .filter(([id]) => id !== answer.choice)
      .map(([, value]) => value),
  );
  const publicProbabilities = Object.fromEntries(
    Object.entries(probabilities).filter(([id]) => id !== abstainId),
  );
  if (confidence < 0.7 || probabilities[answer.choice] - other < 0.15)
    return abstain(
      "Insufficient confidence or probability lead",
      confidence,
      publicProbabilities,
    );
  return {
    contractVersion: "1",
    choice: answer.choice,
    abstained: false,
    confidence,
    probabilities: publicProbabilities,
  };
}

export function errorResult(error: unknown): {
  error: true;
  http_status: number;
  error_detail: unknown;
  _elapsed_seconds: number;
} {
  if (error instanceof DecisionError)
    return {
      error: true,
      http_status: error.httpStatus,
      error_detail: error.detail ?? error.message,
      _elapsed_seconds: 0,
    };
  return {
    error: true,
    http_status: 0,
    error_detail: error instanceof Error ? error.message : String(error),
    _elapsed_seconds: 0,
  };
}
