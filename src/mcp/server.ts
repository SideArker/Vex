import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { decide, decideTyped, errorResult, type EngineOptions } from "../core/engine.js";
import { boundedDecisionSchema } from "../core/schemas.js";
import {
  buildWorkflowRequest,
  summarizeWorkflow,
  workflowContextSchema,
} from "../cli/workflow.js";

/** One generic MCP tool using exactly the same public decision path as the CLI. */
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
        const result = await decide(request, engine);
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
  server.registerTool(
    "vex_workflow",
    {
      description:
        "Evaluate bounded Codex or Antigravity tool, agent, and Codex model choices with Jev. Returns typed answers and conservative selections; abstains on weak choices. Input is sent to OpenRouter.",
      inputSchema: workflowContextSchema,
    },
    async (context) => {
      try {
        const request = buildWorkflowRequest(context);
        const response = await decideTyped(request, engine);
        const result = { response, workflow: summarizeWorkflow(response, request) };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const result = errorResult(error);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
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
