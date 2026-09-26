import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  decide,
  decideTyped,
  DecisionError,
  resolveApiKey,
  resolveOpenRouterApiKey,
  resolveProviderConfig,
  resolveTypeSafeApiKey,
} from "../src/core/engine.js";
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_TYPESAFE_MODEL,
  OPENROUTER_DECISIONS_URL,
  TYPESAFE_SYSTEMONE_URL,
} from "../src/core/schemas.js";
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

describe("multi-provider resolution and TypeSafe direct keys", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.JEV_PROVIDER;
    delete process.env.VEX_PROVIDER;
    delete process.env.TYPESAFE_BASE_URL;
    delete process.env.JEV_BASE_URL;
    delete process.env.TYPESAFE_MODEL;
    delete process.env.OPENROUTER_MODEL;
    delete process.env.JEV_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves TypeSafe API key from environment variables", async () => {
    process.env.TYPESAFE_API_KEY = "ts-test-key-1";
    expect(await resolveTypeSafeApiKey()).toBe("ts-test-key-1");
    expect(await resolveApiKey()).toBe("ts-test-key-1");

    delete process.env.TYPESAFE_API_KEY;
    process.env.JEV_API_KEY = "ts-test-key-2";
    expect(await resolveTypeSafeApiKey()).toBe("ts-test-key-2");
    expect(await resolveApiKey()).toBe("ts-test-key-2");
  });

  it("resolves OpenRouter API key from environment variable", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    expect(await resolveOpenRouterApiKey()).toBe("sk-or-v1-test");
    expect(await resolveApiKey()).toBe("sk-or-v1-test");
  });

  it("auto-detects provider configuration from TypeSafe key", async () => {
    process.env.TYPESAFE_API_KEY = "ts-live-12345";
    const config = await resolveProviderConfig();
    expect(config.provider).toBe("typesafe");
    expect(config.apiKey).toBe("ts-live-12345");
    expect(config.url).toBe(TYPESAFE_SYSTEMONE_URL);
    expect(config.model).toBe(DEFAULT_TYPESAFE_MODEL);
    expect(config.headers["X-Client"]).toBe("vex");
    expect(config.headers["Authorization"]).toBe("Bearer ts-live-12345");
  });

  it("auto-detects provider configuration from OpenRouter key", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-67890";
    const config = await resolveProviderConfig();
    expect(config.provider).toBe("openrouter");
    expect(config.apiKey).toBe("sk-or-v1-67890");
    expect(config.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(config.model).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(config.headers["HTTP-Referer"]).toBe("https://github.com/typesafe-ai/jev");
  });

  it("respects explicit provider option and key prefix", async () => {
    const configTypeSafe = await resolveProviderConfig({
      apiKey: "custom-key",
      provider: "typesafe",
    });
    expect(configTypeSafe.provider).toBe("typesafe");
    expect(configTypeSafe.url).toBe(TYPESAFE_SYSTEMONE_URL);

    const configPrefix = await resolveProviderConfig({
      apiKey: "ts-prefix-key",
    });
    expect(configPrefix.provider).toBe("typesafe");

    const configOpenRouterPrefix = await resolveProviderConfig({
      apiKey: "sk-or-v1-abc",
    });
    expect(configOpenRouterPrefix.provider).toBe("openrouter");
  });

  it("respects custom base URL and model overrides", async () => {
    process.env.TYPESAFE_API_KEY = "ts-test";
    const config = await resolveProviderConfig({
      baseUrl: "https://my-proxy.internal/v1/systemone",
      model: "jev-fast",
    });
    expect(config.url).toBe("https://my-proxy.internal/v1/systemone");
    expect(config.model).toBe("jev-fast");
  });

  it("executes decisions directly via TypeSafe endpoint with jev-latest", async () => {
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(TYPESAFE_SYSTEMONE_URL);
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe(DEFAULT_TYPESAFE_MODEL);
        expect((init?.headers as Record<string, string>)["X-Client"]).toBe("vex");
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              route: {
                type: "choice",
                choice: "a",
                confidence: 0.95,
                probabilities: { a: 0.95, b: 0.05 },
              },
            },
            usage: { input_tokens: 120, output_tokens: 15 },
          }),
          { status: 200 },
        );
      },
    );

    const result = await decideTyped(request, {
      apiKey: "ts-live-test-key",
      provider: "typesafe",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.answers.route.type).toBe("choice");
    expect(result.answers.route.choice).toBe("a");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
