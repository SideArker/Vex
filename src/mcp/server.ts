import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { decide, errorResult, type EngineOptions } from "../core/engine.js";
import { boundedDecisionSchema } from "../core/schemas.js";

/** MCP tools reuse the CLI decision paths and never execute selected actions. */
export function createServer(engine: EngineOptions = {}): McpServer {
  const server = new McpServer({ name: "vex", version: "0.1.0" });
  server.registerTool(
    "vex_choose",
    {
      description:
        "Choose among supplied options with TypeSafe Jev; abstains on missing or weak evidence. Input is sent to OpenRouter.",
      inputSchema: boundedDecisionSchema,
    },
    async (request) => {
      try {
        const result = await decide(request, {
          operation: "vex_choose",
          source: "vex",
          ...engine,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify(errorResult(error)) }],
          isError: true,
        };
      }
    },
  );
  return server;
}

export async function startServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
