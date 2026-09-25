import { describe, expect, it, vi } from "vitest";
import { decide, decideTyped, DecisionError } from "../src/core/engine.js";
import { selectChoice } from "../src/core/decisions.js";
import {
  buildWorkflowRequest,
  summarizeWorkflow,
} from "../src/cli/workflow.js";
import {
  requestSchema,
  type DecisionRequest,
  type DecisionResponse,
} from "../src/core/schemas.js";

const request = {
  state: "Route a task",
  questions: {
    route: {
      type: "choice" as const,
      instructions: "Pick a route",
      criteria: { a: "First", b: "Second" },
    },
  },
};
const response = (
  choice: string,
  confidence = 0.9,
  probabilities = { a: 0.8, b: 0.2 },
): DecisionResponse => ({
  answers: { route: { type: "choice", choice, confidence, probabilities } },
  _elapsed_seconds: 0.1,
});

describe("shared decision engine", () => {
  it("posts the validated request and preserves typed answer and usage", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          ...request,
          model: "typesafe/jev-1.13",
        });
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer test-key",
        );
        return new Response(
          JSON.stringify({
            answers: {
              route: {
                type: "choice",
                choice: "a",
                confidence: 0.9,
                probabilities: { a: 0.8, b: 0.2 },
              },
            },
            usage: { cost: 0.001 },
          }),
          { status: 200 },
        );
      },
    );
    const result = await decideTyped(request, {
      apiKey: "test-key",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.answers.route.type).toBe("choice");
    expect(result.usage?.cost).toBe(0.001);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid requests before any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(
      decideTyped({ ...request, extra: 1 } as never, {
        apiKey: "test-key",
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports HTTP errors without swallowing status", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "denied" }), { status: 401 }),
    );
    await expect(
      decideTyped(request, {
        apiKey: "test-key",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("rejects malformed typed responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              route: { type: "choice", choice: "a", confidence: "high" },
            },
          }),
          { status: 200 },
        ),
    );
    await expect(
      decideTyped(request, {
        apiKey: "test-key",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DecisionError);
  });

  it("rejects invented, missing, and out-of-range typed answers", async () => {
    const cases: Array<{ request: DecisionRequest; body: unknown }> = [
      {
        request,
        body: { answers: { route: { type: "choice", choice: "invented" } } },
      },
      { request, body: { answers: {} } },
      {
        request: {
          state: "Score",
          questions: {
            quality: {
              type: "score" as const,
              instructions: "Rate",
              criteria: ["low", "high"],
            },
          },
        },
        body: { answers: { quality: { type: "score", score: 2 } } },
      },
      {
        request: {
          state: "Check",
          questions: {
            needed: {
              type: "noul" as const,
              instructions: "Needed?",
              criteria: { true: "yes", false: "no" },
            },
          },
        },
        body: { answers: { needed: { type: "choice", choice: "yes" } } },
      },
    ];
    for (const item of cases)
      await expect(
        decideTyped(item.request, {
          apiKey: "test-key",
          fetchImpl: async () =>
            new Response(JSON.stringify(item.body), { status: 200 }),
        }),
      ).rejects.toBeInstanceOf(DecisionError);
  });

  it("accepts a complete Choice, Score, and Noul response", async () => {
    const typed = {
      state: "Review the task",
      questions: {
        route: {
          type: "choice" as const,
          instructions: "Route",
          criteria: { a: "First", b: "Second" },
        },
        quality: {
          type: "score" as const,
          instructions: "Rate",
          criteria: ["low", "medium", "high"],
        },
        verify: {
          type: "noul" as const,
          instructions: "Verify?",
          criteria: { true: "Needed", false: "Done" },
        },
      },
    };
    const body = {
      answers: {
        route: {
          type: "choice",
          choice: "a",
          confidence: 0.9,
          probabilities: { a: 0.8, b: 0.2 },
        },
        quality: { type: "score", score: 1.5 },
        verify: { type: "noul", noul: 0.7 },
      },
    };
    const result = await decideTyped(typed, {
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(JSON.stringify(body), { status: 200 }),
    });
    expect(Object.keys(result.answers)).toEqual(["route", "quality", "verify"]);
  });
});

describe("bounded decisions", () => {
  const candidates = { a: "First", b: "Second" };
  it("accepts only a supported supplied choice", () => {
    expect(selectChoice(response("a"), "route", candidates).choice).toBe("a");
    expect(
      selectChoice(response("invented"), "route", candidates).choice,
    ).toBeNull();
    expect(
      selectChoice(response("a", 0.69), "route", candidates).choice,
    ).toBeNull();
    expect(
      selectChoice(
        response("a", 0.9, { a: 0.55, b: 0.45 }),
        "route",
        candidates,
      ).choice,
    ).toBeNull();
  });

  it("keeps workflow thresholds and typed signals", () => {
    const built = buildWorkflowRequest({
      runtime: "codex",
      task: "Review patch",
      tools: { read: "Inspect", none: "Ask for input" },
      evidence: "Patch shown",
      proposed_action: "Review",
    });
    expect(Object.keys(built.questions)).toEqual([
      "tool",
      "enough_information",
      "needs_verification",
      "task_complete",
      "human_review",
    ]);
    const result: DecisionResponse = {
      answers: {
        tool: {
          type: "choice",
          choice: "read",
          confidence: 0.9,
          probabilities: { read: 0.9, none: 0.1 },
        },
        enough_information: { type: "noul", noul: 0.9 },
        needs_verification: { type: "noul", noul: 0.7 },
        task_complete: { type: "noul", noul: 0.2 },
        human_review: { type: "noul", noul: 0.1 },
      },
      _elapsed_seconds: 0,
    };
    expect(summarizeWorkflow(result, built)).toEqual({
      human_review_recommended: false,
      next_steps: ["Verify result", "Task completion unproven"],
      selections: { tool: "read" },
    });
  });

  it("rejects cross-runtime model routing and malformed score/noul questions", () => {
    expect(() =>
      buildWorkflowRequest({
        runtime: "antigravity",
        task: "Task",
        models: { a: "One", b: "Two" },
      }),
    ).toThrow();
    expect(
      requestSchema.safeParse({
        state: "x",
        questions: {
          n: { type: "noul", instructions: "x", criteria: { true: "yes" } },
        },
      }).success,
    ).toBe(false);
  });
});
