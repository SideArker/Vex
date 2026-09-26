import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  decide,
  decideTyped,
  errorResult,
  type EngineOptions,
} from "../core/engine.js";
import {
  boundedDecisionSchema,
  toolSelectionSchema,
  gateSchema,
  verifySchema,
} from "../core/schemas.js";

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

  server.registerTool(
    "vex_tool",
    {
      description:
        "Select the best available tool for a task from supplied tool candidates. Abstains if evidence is insufficient.",
      inputSchema: toolSelectionSchema,
    },
    async (request) => {
      try {
        const options = Object.entries(request.tools).map(
          ([id, description]) => ({
            id,
            description,
          }),
        );
        const result = await decide(
          {
            question: `Which tool best advances the task: "${request.task}"?`,
            context: request.context,
            options,
          },
          { operation: "vex_tool", source: "vex", ...engine },
        );
        const structuredContent = {
          tool: result.choice,
          abstained: result.abstained,
          confidence: result.confidence,
          probabilities: result.probabilities,
          reason: result.reason,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
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
    "vex_gate",
    {
      description:
        "Evaluate if a proposed action is destructive or requires human confirmation before execution.",
      inputSchema: gateSchema,
    },
    async (request) => {
      try {
        const state = request.context
          ? `Proposed action: ${request.action}\nContext: ${request.context}`
          : `Proposed action: ${request.action}`;
        const response = await decideTyped(
          {
            state,
            questions: {
              is_destructive: {
                type: "noul",
                instructions:
                  "Is this action destructive (e.g. data loss, irreversible state)?",
                criteria: {
                  true: "Destructive or irreversible",
                  false: "Safe or easily reversible",
                },
              },
              escalate_to_human: {
                type: "noul",
                instructions:
                  "Does this action need human confirmation before proceeding?",
                criteria: {
                  true: "Material ambiguity or significant consequence",
                  false: "Standard authorized operation",
                },
              },
              risk_level: {
                type: "score",
                instructions: "Assess overall operational risk",
                criteria: ["Low", "Medium", "High"],
              },
            },
          },
          { operation: "vex_gate", source: "vex", ...engine },
        );
        const isDestructive =
          response.answers.is_destructive?.type === "noul" &&
          response.answers.is_destructive.noul >= 0.5;
        const escalateToHuman =
          response.answers.escalate_to_human?.type === "noul" &&
          response.answers.escalate_to_human.noul >= 0.5;
        const riskIndex =
          response.answers.risk_level?.type === "score"
            ? response.answers.risk_level.score
            : 0;
        const riskLevel = ["Low", "Medium", "High"][riskIndex] ?? "Low";
        const structuredContent = {
          action: request.action,
          is_destructive: isDestructive,
          escalate_to_human: escalateToHuman,
          risk_level: riskLevel,
          confidence: {
            destructive:
              response.answers.is_destructive?.type === "noul"
                ? response.answers.is_destructive.noul
                : 0,
            escalate:
              response.answers.escalate_to_human?.type === "noul"
                ? response.answers.escalate_to_human.noul
                : 0,
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
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
    "vex_verify",
    {
      description:
        "Verify whether observed evidence satisfies acceptance criteria before completing a task.",
      inputSchema: verifySchema,
    },
    async (request) => {
      try {
        const state = `Task: ${request.task}\nAcceptance Criteria: ${request.acceptance}\nObserved Evidence: ${request.evidence}`;
        const response = await decideTyped(
          {
            state,
            questions: {
              enough_information: {
                type: "noul",
                instructions:
                  "Is the observed evidence sufficient to evaluate acceptance conditions without guessing?",
                criteria: {
                  true: "Facts and test outcomes are clear",
                  false: "Key evidence or check results are missing",
                },
              },
              needs_verification: {
                type: "noul",
                instructions:
                  "Does the result still need task-relevant verification before claiming completion?",
                criteria: {
                  true: "An acceptance condition has not been checked",
                  false: "Relevant checks already support the result",
                },
              },
              task_complete: {
                type: "noul",
                instructions:
                  "Do the observed results satisfy all stated acceptance conditions?",
                criteria: {
                  true: "All acceptance conditions are met by evidence",
                  false: "Work or verification remains",
                },
              },
            },
          },
          { operation: "vex_verify", source: "vex", ...engine },
        );
        const infoVal =
          response.answers.enough_information?.type === "noul"
            ? response.answers.enough_information.noul
            : 0;
        const verifyVal =
          response.answers.needs_verification?.type === "noul"
            ? response.answers.needs_verification.noul
            : 1;
        const completeVal =
          response.answers.task_complete?.type === "noul"
            ? response.answers.task_complete.noul
            : 0;

        const nextSteps: string[] = [];
        if (infoVal < 0.7) nextSteps.push("Gather more information");
        if (verifyVal >= 0.5)
          nextSteps.push("Verify result with tests or checks");
        if (completeVal < 0.8) nextSteps.push("Task completion unproven");

        const structuredContent = {
          task_complete: completeVal >= 0.8,
          needs_verification: verifyVal >= 0.5,
          evidence_sufficient: infoVal >= 0.7,
          next_steps: nextSteps,
          scores: {
            task_complete: completeVal,
            needs_verification: verifyVal,
            enough_information: infoVal,
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
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
