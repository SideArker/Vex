import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";
import {
  readLocalStats,
  recordStat,
  resetLocalStats,
  fetchAccountStats,
  formatStatsReport,
  createEmptyStats,
  type LocalStats,
  type OpenRouterAccountStats,
} from "../src/core/stats.js";
import { decide, decideTyped } from "../src/core/engine.js";

const testStatsPath = join(
  tmpdir(),
  `vex_test_stats_${Date.now()}_${Math.random().toString(36).slice(2)}.json`,
);

describe("stats tracking and reporting", () => {
  afterEach(async () => {
    try {
      await unlink(testStatsPath);
    } catch {
      // ignore
    }
  });

  it("reads empty stats for nonexistent file", async () => {
    const stats = await readLocalStats(testStatsPath);
    expect(stats.total_requests).toBe(0);
    expect(stats.total_cost).toBe(0);
    expect(stats.operations).toEqual({});
  });

  it("records stats for both Vex and Jev operations and accumulates totals", async () => {
    // Record Jev op
    await recordStat(
      {
        operation: "decide",
        source: "jev",
        elapsedSeconds: 0.5,
        usage: { cost: 0.0001, input_tokens: 100, output_tokens: 20 },
      },
      testStatsPath,
    );

    // Record Vex op
    await recordStat(
      {
        operation: "vex_choose",
        source: "vex",
        elapsedSeconds: 0.8,
        usage: { cost: 0.0002, input_tokens: 200, output_tokens: 30 },
      },
      testStatsPath,
    );

    const stats = await readLocalStats(testStatsPath);
    expect(stats.total_requests).toBe(2);
    expect(stats.total_cost).toBeCloseTo(0.0003);
    expect(stats.total_input_tokens).toBe(300);
    expect(stats.total_output_tokens).toBe(50);
    expect(stats.total_time_seconds).toBeCloseTo(1.3);

    expect(stats.operations["decide"]?.count).toBe(1);
    expect(stats.operations["decide"]?.source).toBe("jev");
    expect(stats.operations["vex_choose"]?.count).toBe(1);
    expect(stats.operations["vex_choose"]?.source).toBe("vex");

    expect(stats.sources?.["jev"]?.count).toBe(1);
    expect(stats.sources?.["vex"]?.count).toBe(1);
  });

  it("resets local stats file", async () => {
    await recordStat(
      {
        operation: "gate",
        elapsedSeconds: 0.2,
        usage: { cost: 0.00005 },
      },
      testStatsPath,
    );
    const before = await readLocalStats(testStatsPath);
    expect(before.total_requests).toBe(1);

    const resetSuccess = await resetLocalStats(testStatsPath);
    expect(resetSuccess).toBe(true);

    const after = await readLocalStats(testStatsPath);
    expect(after.total_requests).toBe(0);
  });

  it("fetches account stats using fetchImpl", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/key")) {
        return new Response(
          JSON.stringify({
            data: {
              label: "test-key-label",
              limit: 10,
              limit_remaining: 9.5,
              usage: 0.5,
            },
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/credits")) {
        return new Response(
          JSON.stringify({
            data: {
              total_credits: 10,
              total_usage: 0.5,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const res = await fetchAccountStats("test-token", fetchImpl as typeof fetch);
    expect(res.key?.label).toBe("test-key-label");
    expect(res.credits?.total_credits).toBe(10);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("handles fetch errors gracefully", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Connection failed");
    });
    const res = await fetchAccountStats("test-token", fetchImpl as typeof fetch);
    expect(res.key_error).toContain("Connection failed");
    expect(res.credits_error).toContain("Connection failed");
  });

  it("formats combined stats report cleanly", () => {
    const local: LocalStats = {
      total_requests: 3,
      total_cost: 0.0005,
      total_input_tokens: 1500,
      total_output_tokens: 250,
      total_time_seconds: 1.5,
      sources: {
        vex: { count: 1, cost: 0.0002, time_seconds: 0.6, input_tokens: 600, output_tokens: 100 },
        jev: { count: 2, cost: 0.0003, time_seconds: 0.9, input_tokens: 900, output_tokens: 150 },
      },
      operations: {
        vex_choose: { count: 1, cost: 0.0002, time_seconds: 0.6, input_tokens: 600, output_tokens: 100, source: "vex" },
        decide: { count: 2, cost: 0.0003, time_seconds: 0.9, input_tokens: 900, output_tokens: 150, source: "jev" },
      },
    };
    const remote: OpenRouterAccountStats = {
      key: {
        label: "sk-or-v1-abc",
        limit: 5.0,
        limit_remaining: 4.8,
        usage: 0.2,
      },
      credits: {
        total_credits: 5.0,
        total_usage: 0.2,
      },
    };

    const report = formatStatsReport(local, remote);
    expect(report).toContain("================ VEX & JEV STATS (COMBINED) ================");
    expect(report).toContain("Key: sk-or-v1-abc");
    expect(report).toContain("Total Calls: 3 (Vex: 1, Jev: 2)");
    expect(report).toContain("[vex] vex_choose");
    expect(report).toContain("[jev] decide");
  });

  it("engine decision calls record stats when statsFilePath is provided", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          answers: {
            decision: {
              type: "choice",
              choice: "a",
              confidence: 0.95,
              probabilities: { a: 0.9, b: 0.1 },
            },
          },
          usage: { cost: 0.0001, input_tokens: 80, output_tokens: 15 },
        }),
        { status: 200 },
      );
    });

    await decide(
      {
        question: "Test question",
        options: [
          { id: "a", description: "Option A" },
          { id: "b", description: "Option B" },
        ],
      },
      {
        apiKey: "test-key",
        fetchImpl: fetchImpl as typeof fetch,
        statsFilePath: testStatsPath,
        operation: "decide",
        source: "jev",
      },
    );

    const stats = await readLocalStats(testStatsPath);
    expect(stats.total_requests).toBe(1);
    expect(stats.total_cost).toBeCloseTo(0.0001);
    expect(stats.operations["decide"]?.count).toBe(1);
  });

  it("runCli executes stats command with formatted and raw output", async () => {
    const { runCli } = await import("../src/cli/jev.js");
    await recordStat(
      {
        operation: "triage",
        source: "jev",
        elapsedSeconds: 0.4,
        usage: { cost: 0.00005, input_tokens: 50, output_tokens: 10 },
      },
      testStatsPath,
    );

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/key")) {
        return new Response(
          JSON.stringify({ data: { label: "key-123", usage: 0.01 } }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/credits")) {
        return new Response(
          JSON.stringify({ data: { total_credits: 5.0, total_usage: 0.01 } }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const exitCodeFormatted = await runCli(["stats"], {
      apiKey: "test-key",
      fetchImpl: fetchImpl as typeof fetch,
      statsFilePath: testStatsPath,
    });
    expect(exitCodeFormatted).toBe(0);
    const formattedOutput = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(formattedOutput).toContain("================ VEX & JEV STATS (COMBINED) ================");
    expect(formattedOutput).toContain("[jev] triage");

    writeSpy.mockClear();
    const exitCodeRaw = await runCli(["stats", "--raw"], {
      apiKey: "test-key",
      fetchImpl: fetchImpl as typeof fetch,
      statsFilePath: testStatsPath,
    });
    expect(exitCodeRaw).toBe(0);
    const rawOutput = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsedRaw = JSON.parse(rawOutput);
    expect(parsedRaw.local.total_requests).toBe(1);
    expect(parsedRaw.openrouter_account.key.label).toBe("key-123");

    writeSpy.mockClear();
    const exitCodeReset = await runCli(["stats", "--reset"], {
      statsFilePath: testStatsPath,
    });
    expect(exitCodeReset).toBe(0);
    const resetOutput = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(resetOutput).toContain("Local usage statistics reset");

    writeSpy.mockRestore();
  });
});

