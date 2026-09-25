import { z } from "zod";

export const DEFAULT_MODEL = "typesafe/jev-1.13";
export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

const criteria = z
  .record(z.string().min(1), z.string().min(1))
  .refine(
    (value) => Object.keys(value).length >= 2,
    "At least two described choices are required",
  );
const choiceQuestion = z
  .object({
    type: z.literal("choice"),
    instructions: z.string().min(1),
    criteria,
  })
  .strict();
const noulQuestion = z
  .object({
    type: z.literal("noul"),
    instructions: z.string().min(1),
    criteria: z
      .object({ true: z.string().min(1), false: z.string().min(1) })
      .strict(),
  })
  .strict();
const scoreQuestion = z
  .object({
    type: z.literal("score"),
    instructions: z.string().min(1),
    criteria: z.array(z.string().min(1)).min(2),
  })
  .strict();
export const questionSchema = z.discriminatedUnion("type", [
  choiceQuestion,
  noulQuestion,
  scoreQuestion,
]);
export const requestSchema = z
  .object({
    model: z.string().min(1).optional(),
    state: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
    questions: z
      .record(z.string().min(1), questionSchema)
      .refine(
        (q) => Object.keys(q).length > 0,
        "At least one question is required",
      ),
    session_id: z.string().min(1).optional(),
  })
  .strict();
export type DecisionRequest = z.infer<typeof requestSchema>;

const probability = z.number().finite().min(0).max(1);
const answerBase = z
  .object({ confidence: probability.optional() })
  .passthrough();
export const answerSchema = z.discriminatedUnion("type", [
  answerBase.extend({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(probability).optional(),
  }),
  answerBase.extend({
    type: z.literal("score"),
    score: z.number().finite(),
    probabilities: z.record(probability).optional(),
  }),
  answerBase.extend({ type: z.literal("noul"), noul: probability }),
]);
export const responseSchema = z
  .object({
    answers: z.record(answerSchema),
    model: z.string().optional(),
    usage: z
      .object({
        cost: z.number().optional(),
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type DecisionResponse = z.infer<typeof responseSchema> & {
  _elapsed_seconds: number;
};

export const boundedDecisionSchema = z
  .object({
    question: z.string().trim().min(1),
    context: z
      .union([z.string().trim().min(1), z.record(z.string(), z.unknown())])
      .optional(),
    options: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            description: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(2)
      .max(12)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "Option IDs must be unique",
      )
      .refine(
        (items) => items.every((item) => item.id !== "__jev_abstain__"),
        "Reserved option ID",
      ),
    decisionType: z.literal("choice").optional(),
    constraints: z
      .union([
        z.string().trim().min(1),
        z.array(z.string().trim().min(1)).min(1),
      ])
      .optional(),
  })
  .strict();
export type BoundedDecisionRequest = z.infer<typeof boundedDecisionSchema>;
export interface BoundedDecisionResult {
  contractVersion: "1";
  choice: string | null;
  abstained: boolean;
  confidence: number;
  probabilities?: Record<string, number>;
  reason?: string;
}
