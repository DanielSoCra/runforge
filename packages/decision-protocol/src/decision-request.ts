import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol-version.js";
import { RISK_CLASSES, RESUME_MODES, REVERSIBILITY } from "./state-machine-types.js";

export const OptionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().optional(),
});

/**
 * answer_schema — a discriminated union on `kind`.
 *   { kind: 'option' }                  — the answer must be one of options[].id
 *   { kind: 'json', schema: <jsonschema> } — the answer is validated against the schema
 * Richer forms are deferred (spec §risks).
 */
export const AnswerSchemaSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("option") }),
  z.strictObject({ kind: z.literal("json"), schema: z.record(z.string(), z.unknown()) }),
]);
export type AnswerSchema = z.infer<typeof AnswerSchemaSchema>;

export const DecisionRequestSchema = z.strictObject({
  decision_id: z.string().min(1),
  protocol_version: z.string().min(1).default(PROTOCOL_VERSION),
  source_url: z.string().min(1),
  source_etag: z.string().optional(),
  source_event_id: z.string().optional(),
  deployment: z.string().min(1),
  run_id: z.string().min(1),
  worker_session_id: z.string().min(1),
  phase: z.string().min(1),
  risk_class: z.enum(RISK_CLASSES),
  question: z.string().min(1),
  context: z.string(),
  options: z.array(OptionSchema).min(1),
  recommended_option: z.string().optional(),
  consequence_of_no_answer: z.string(),
  reversibility: z.enum(REVERSIBILITY),
  expires_at: z.string().min(1),
  answer_schema: AnswerSchemaSchema,
  resume_mode: z.enum(RESUME_MODES),
  idempotency_key: z.string().min(1),
  trace_id: z.string().optional(),
  agent_version: z.string().optional(),
  skill_version: z.string().optional(),
});

export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
export type DecisionOption = z.infer<typeof OptionSchema>;
