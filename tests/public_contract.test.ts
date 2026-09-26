import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decide, DecisionError } from "../src/core/engine.js";
import { runCli } from "../src/cli/jev.js";
import { createServer } from "../src/mcp/server.js";

const request = {
  question: "What next?",
  context: "Tests passed",
  options: [
    { id: "review", description: "Review docs" },
    { id: "none", description: "Gather evidence" },
  ],
};
const answer = (
  choice = "review",
  confidence = 0.9,
  probabilities: Record<string, number> = {
    review: 0.85,
    none: 0.1,
    __jev_abstain__: 0.05,
  },
) =>
  new Response(
    JSON.stringify({
      answers: {
        decision: { type: "choice", choice, confidence, probabilities },
      },
    }),
    { status: 200 },
  );

describe("public bounded decision", () => {
  it("forces routing to highest supplied option, with supplied order breaking exact ties", async () => {
    const routing = { ...request, decisionType: "routing" as const };
    const lowLead = await decide(routing, { apiKey: "test", fetchImpl: async () => answer("review", 0.51, { review: 0.40, none: 0.41, __jev_abstain__: 0.19 }) });
    expect(lowLead).toMatchObject({ choice: "none", abstained: false, confidence: 0.51 });
    const tie = await decide(routing, { apiKey: "test", fetchImpl: async () => answer("__jev_abstain__", 0.2, { review: 0.4, none: 0.4, __jev_abstain__: 0.2 }) });
    expect(tie).toMatchObject({ choice: "review", abstained: false });
    await expect(decide(routing, { apiKey: "test", fetchImpl: async () => answer("review", 0.9, { review: 0.8, none: 0.2 }) })).rejects.toThrow("Invalid routing probabilities");
  });
  it("allows one forced routing option while ordinary decisions still need two", async () => {
    const options = [request.options[0]!];
    const routing = await decide({ ...request, options, decisionType: "routing" }, {
      apiKey: "test", fetchImpl: async () => answer("review", 0.2, { review: 0.8, __jev_abstain__: 0.2 }),
    });
    expect(routing).toMatchObject({ choice: "review", abstained: false });
    await expect(decide({ ...request, options }, { apiKey: "test", fetchImpl: async () => answer() })).rejects.toThrow("Ordinary decisions need at least two options");
  });
  it("returns one versioned, allowed choice", async () => {
    const fetchImpl = vi.fn(async () => answer());
    expect(
      await decide(request, {
        apiKey: "test",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).toEqual({
      contractVersion: "1",
      choice: "review",
      abstained: false,
      confidence: 0.9,
      probabilities: { review: 0.85, none: 0.1 },
    });
  });

  it("abstains on invented choice, invented probability key, weak confidence, or split probabilities", async () => {
    for (const response of [
      answer("invented"),
      answer("__jev_abstain__"),
      answer("review", 0.9, { review: 0.9, bad: 0.1, __jev_abstain__: 0 }),
      answer("review", 0.69),
      answer("review", 0.9, { review: 0.5, none: 0.4, __jev_abstain__: 0.1 }),
    ]) {
      const result = await decide(request, {
        apiKey: "test",
        fetchImpl: async () => response,
      });
      expect(result.choice).toBeNull();
      expect(result.abstained).toBe(true);
    }
  });

  it("fails closed on missing key, timeout, and invalid options", async () => {
    await expect(
      decide(request, { keyProvider: async () => null, fetchImpl: vi.fn() }),
    ).rejects.toBeInstanceOf(DecisionError);
    const fetchImpl: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    await expect(
      decide(request, { apiKey: "test", fetchImpl, timeoutMs: 2 }),
    ).rejects.toBeInstanceOf(DecisionError);
    await expect(
      decide(
        { ...request, options: [request.options[0], request.options[0]] },
        { apiKey: "test", fetchImpl: vi.fn() },
      ),
    ).rejects.toThrow();
    await expect(
      decide(
        {
          ...request,
          options: [
            { id: "__jev_abstain__", description: "Collision" },
            request.options[1],
          ],
        },
        { apiKey: "test", fetchImpl: vi.fn() },
      ),
    ).rejects.toThrow();
  });

  it("CLI JSON and MCP tool return the same result through the shared engine", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vex-contract-"));
    const file = join(directory, "request.json");
    await writeFile(file, JSON.stringify(request));
    const fetchImpl = vi.fn(async () => answer()) as typeof fetch;
    const output: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
    const server = createServer({ apiKey: "test", fetchImpl });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      expect(
        await runCli(["decide", file, "--json"], { apiKey: "test", fetchImpl }),
      ).toBe(0);
      const cliResult = JSON.parse(output.join(""));
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "vex_choose",
        "vex_tool",
        "vex_gate",
        "vex_verify",
      ]);
      const mcpResult = await client.callTool({
        name: "vex_choose",
        arguments: request,
      });
      expect(mcpResult.structuredContent).toEqual(cliResult);
    } finally {
      stdout.mockRestore();
      await client.close();
      await server.close();
      await unlink(file);
      await rmdir(directory);
    }
  });
});

describe("CLI workflow", () => {
  it("returns typed model answers and only a supported route selection", async () => {
    const context = {
      runtime: "codex",
      task: "Implement a focused change",
      models: {
        "luna-low": "gpt-6-luna low, routine small task",
        "sol-medium": "gpt-6-sol medium, broader coding task",
      },
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.questions.model.criteria).toEqual(context.models);
      return new Response(JSON.stringify({
        answers: {
          model: {
            type: "choice",
            choice: "sol-medium",
            confidence: 0.9,
            probabilities: { "luna-low": 0.1, "sol-medium": 0.9 },
          },
        },
      }), { status: 200 });
    }) as typeof fetch;
    const directory = await mkdtemp(join(tmpdir(), "vex-workflow-"));
    const file = join(directory, "workflow.json");
    await writeFile(file, JSON.stringify(context));
    const output: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
    try {
      expect(
        await runCli(["workflow", file, "--raw"], { apiKey: "test", fetchImpl }),
      ).toBe(0);
      const result = JSON.parse(output.join(""));
      expect(result).toMatchObject({
        workflow: {
          human_review_recommended: false,
          next_steps: [],
          selections: { model: "sol-medium" },
        },
        response: { answers: { model: { choice: "sol-medium" } } },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      stdout.mockRestore();
      await unlink(file);
      await rmdir(directory);
    }
  });

  it("abstains on weak model evidence and rejects cross-runtime routing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      answers: {
        model: {
          type: "choice",
          choice: "sol-medium",
          confidence: 0.65,
          probabilities: { "luna-low": 0.45, "sol-medium": 0.55 },
        },
      },
    }), { status: 200 })) as typeof fetch;
    const directory = await mkdtemp(join(tmpdir(), "vex-workflow-"));
    const file = join(directory, "workflow.json");
    const models = { "luna-low": "Small", "sol-medium": "Broader" };
    await writeFile(file, JSON.stringify({ runtime: "codex", task: "Route", models }));
    const output: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
    try {
      expect(
        await runCli(["workflow", file, "--raw"], { apiKey: "test", fetchImpl }),
      ).toBe(0);
      const result = JSON.parse(output.join(""));
      expect(result).toMatchObject({
        workflow: {
          human_review_recommended: true,
          next_steps: ["Uncertain model choice"],
          selections: {},
        },
      });
      await writeFile(file, JSON.stringify({ runtime: "antigravity", task: "Route", models }));
      await expect(
        runCli(["workflow", file, "--raw"], { apiKey: "test", fetchImpl }),
      ).rejects.toThrow("Model routing is available only for Codex");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      stdout.mockRestore();
      await unlink(file);
      await rmdir(directory);
    }
  });
});

describe("MCP lean tools: vex_tool, vex_gate, vex_verify", () => {
  it("vex_tool selects the best tool", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          answers: {
            decision: {
              type: "choice",
              choice: "view_file",
              confidence: 0.92,
              probabilities: {
                view_file: 0.85,
                run_command: 0.1,
                __jev_abstain__: 0.05,
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const server = createServer({ apiKey: "test", fetchImpl });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({
        name: "vex_tool",
        arguments: {
          task: "Inspect unit test failure",
          tools: {
            view_file: "View test file source",
            run_command: "Run pytest",
          },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        tool: "view_file",
        abstained: false,
        confidence: 0.92,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("vex_gate evaluates destructive actions", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          answers: {
            is_destructive: { type: "noul", noul: 0.95 },
            escalate_to_human: { type: "noul", noul: 0.85 },
            risk_level: { type: "score", score: 2 },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const server = createServer({ apiKey: "test", fetchImpl });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({
        name: "vex_gate",
        arguments: {
          action: "git reset --hard origin/main",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        action: "git reset --hard origin/main",
        is_destructive: true,
        escalate_to_human: true,
        risk_level: "High",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("vex_verify evaluates acceptance criteria against evidence", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          answers: {
            enough_information: { type: "noul", noul: 0.9 },
            needs_verification: { type: "noul", noul: 0.1 },
            task_complete: { type: "noul", noul: 0.95 },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const server = createServer({ apiKey: "test", fetchImpl });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({
        name: "vex_verify",
        arguments: {
          task: "Add login tests",
          acceptance: "All login tests pass with 100% coverage",
          evidence: "Added 4 test cases; pytest passes 4/4",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        task_complete: true,
        needs_verification: false,
        evidence_sufficient: true,
        next_steps: [],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
