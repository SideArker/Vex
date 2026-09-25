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
        "vex_workflow",
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

describe("MCP workflow", () => {
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
    const server = createServer({ apiKey: "test", fetchImpl });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "vex_workflow", arguments: context });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        workflow: {
          human_review_recommended: false,
          next_steps: [],
          selections: { model: "sol-medium" },
        },
        response: { answers: { model: { choice: "sol-medium" } } },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
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
    const server = createServer({ apiKey: "test", fetchImpl });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const models = { "luna-low": "Small", "sol-medium": "Broader" };
      const result = await client.callTool({
        name: "vex_workflow",
        arguments: { runtime: "codex", task: "Route", models },
      });
      expect(result.structuredContent).toMatchObject({
        workflow: {
          human_review_recommended: true,
          next_steps: ["Uncertain model choice"],
          selections: {},
        },
      });
      const error = await client.callTool({
        name: "vex_workflow",
        arguments: { runtime: "antigravity", task: "Route", models },
      });
      expect(error.isError).toBe(true);
      expect(error.structuredContent).toMatchObject({ error: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
