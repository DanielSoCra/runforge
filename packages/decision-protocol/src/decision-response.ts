import { z } from "zod";

/**
 * DecisionResponse — either a chosen_option (option id) OR a structured `answer`
 * validated against the request's answer_schema. answered-once is enforced at the
 * DB layer (decision_responses PK), not here.
 */
export const DecisionResponseSchema = z
  .object({
    decision_id: z.string().min(1),
    chosen_option: z.string().min(1).optional(),
    answer: z.unknown().optional(),
    answerer: z.string().min(1),
    answered_at: z.string().min(1),
    idempotency_key: z.string().min(1),
  })
  .refine((r) => r.chosen_option !== undefined || r.answer !== undefined, {
    message: "DecisionResponse must carry either chosen_option or answer",
  });

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
