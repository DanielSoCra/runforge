import { z } from "zod";

/**
 * DecisionResponse — EXACTLY ONE of a chosen_option (option id) XOR a structured
 * `answer` validated against the request's answer_schema. answered-once is
 * enforced at the DB layer (decision_responses PK), not here.
 *
 * HARDENED (verdict fix_before_flag_on / decision-response.ts:8):
 *  - `z.strictObject()` rejects unknown extra top-level fields rather than
 *    silently passing them — the producer (daemon) is the stricter side, so a
 *    typo/injected field is surfaced at the type boundary, not absorbed.
 *  - the refine is an XOR (exactly one of chosen_option / answer): a payload
 *    carrying BOTH was previously valid-but-ambiguous (which one wins?). Forbid
 *    it before the pm-cockpit answer-consumer is built.
 *
 * NOTE: the LIVE cockpit write-back is NOT parsed through this schema. The
 * daemon's resume-consumer (parseCockpitAnswer / extractMatchingChoice) reads the
 * minimal fenced `{ chosen_option }` JSON directly (it deliberately does NOT run
 * the full envelope schema, which requires decision_id/answerer/answered_at/
 * idempotency_key). This schema is the FULL response envelope contract; XOR +
 * strictObject here does not touch that minimal live-parse path.
 */
export const DecisionResponseSchema = z
  .strictObject({
    decision_id: z.string().min(1),
    chosen_option: z.string().min(1).optional(),
    answer: z.unknown().optional(),
    answerer: z.string().min(1),
    answered_at: z.string().min(1),
    idempotency_key: z.string().min(1),
  })
  .refine((r) => (r.chosen_option !== undefined) !== (r.answer !== undefined), {
    message: "DecisionResponse must carry EXACTLY ONE of chosen_option or answer",
  });

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
