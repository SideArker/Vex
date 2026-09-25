import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = join(process.cwd(), "dist", "cli", "jev.js");
const request = {
  question: "What next?",
  options: [
    { id: "review", description: "Review docs" },
    { id: "none", description: "Gather evidence" },
  ],
};

describe("jev process contract", () => {
  it("reads one JSON request on stdin and emits exactly one JSON result", () => {
    const directory = mkdtempSync(join(tmpdir(), "vex-cli-"));
    const preload = join(directory, "mock.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = async () => new Response(JSON.stringify({answers:{decision:{type:"choice",choice:"review",confidence:0.9,probabilities:{review:0.85,none:0.1,__jev_abstain__:0.05}}}}),{status:200});`,
    );
    try {
      const run = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, entry, "decide", "--json"],
        {
          cwd: process.cwd(),
          input: JSON.stringify(request),
          encoding: "utf8",
          timeout: 5000,
          env: { ...process.env, OPENROUTER_API_KEY: "test-key" },
        },
      );
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout.trim().split(/\r?\n/)).toHaveLength(1);
      expect(JSON.parse(run.stdout)).toMatchObject({
        contractVersion: "1",
        choice: "review",
        abstained: false,
      });
    } finally {
      unlinkSync(preload);
      rmdirSync(directory);
    }
  });

  it("accepts a human question with repeated described options", () => {
    const directory = mkdtempSync(join(tmpdir(), "vex-cli-human-"));
    const preload = join(directory, "mock.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = async (_url, init) => { const request = JSON.parse(init.body); const valid = request.state.question === "What next?" && request.state.context === "Tests passed" && request.state.constraints[0] === "No network" && request.questions.decision.criteria.review === "Review docs" && request.questions.decision.criteria.none === "Gather evidence"; return new Response(valid ? JSON.stringify({answers:{decision:{type:"choice",choice:"review",confidence:0.9,probabilities:{review:0.85,none:0.1,__jev_abstain__:0.05}}}}) : JSON.stringify({error:"bad request"}), {status:valid ? 200 : 400}); };`,
    );
    try {
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(preload).href,
          entry,
          "decide",
          "What next?",
          "--option",
          "review=Review docs",
          "--option",
          "none=Gather evidence",
          "--context",
          "Tests passed",
          "--constraint",
          "No network",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 5000,
          env: { ...process.env, OPENROUTER_API_KEY: "test-key" },
        },
      );
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toContain("Choice: review");
    } finally {
      unlinkSync(preload);
      rmdirSync(directory);
    }
  });

  it("reports invalid stdin with one JSON error, stderr diagnostic, and nonzero exit", () => {
    const run = spawnSync(process.execPath, [entry, "decide", "--json"], {
      cwd: process.cwd(),
      input: "not-json",
      encoding: "utf8",
      timeout: 5000,
    });
    expect(run.status).toBe(2);
    expect(run.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(run.stdout)).toMatchObject({
      contractVersion: "1",
      error: true,
    });
    expect(run.stderr).toContain("[ERROR]");
  });
});

describe("vex command", () => {
  it("starts an MCP stdio server with vex_choose tool", async () => {
    const client = new Client({ name: "smoke-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "dist", "index.js"), "mcp", "serve"],
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "vex_choose",
      ]);
      const stderr = transport.stderr;
      expect(stderr).not.toBeNull();
      let diagnostic = "";
      stderr!.on("data", (chunk: Buffer | string) => {
        diagnostic += chunk.toString();
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(diagnostic).toContain(
        "Vex MCP stdio server is ready; waiting for client requests.",
      );
    } finally {
      await client.close();
    }
  });
});
