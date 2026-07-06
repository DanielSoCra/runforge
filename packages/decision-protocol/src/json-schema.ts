import { z } from "zod";
import { DecisionRequestSchema } from "./decision-request.js";

/**
 * Generate the canonical JSON Schema artifact for DecisionRequest. The committed
 * copy under schema/decision-request.schema.json must equal this output (a test
 * regenerates-and-diffs). Cross-language consumers (runforge #685) validate
 * against the committed artifact.
 *
 * zod4 port note: the original package used `zod-to-json-schema`, but that library
 * does NOT traverse zod 4 schemas — its own README states that under v3.25 "Zod v4
 * [is] a peer-dependency ... [but] it does _not_ mean it supports v4 schemas", and
 * it recommends zod 4's built-in generator. Calling `zodToJsonSchema()` on a zod 4
 * schema silently emits an empty `{}` definition. We therefore use zod 4's native
 * `z.toJSONSchema`.
 *
 * Two options are pinned to keep the artifact faithful to the legacy contract:
 *  - `target: "draft-07"` — matches the committed `$schema` dialect.
 *  - `io: "input"` — a DecisionRequest is validated on the WAY IN, so default-bearing
 *    fields (`protocol_version`) are optional, matching the committed `required` set.
 *    (The default `io: "output"` would mark `protocol_version` required.)
 *
 * zod 4 emits two intrinsically-different (but semantically equivalent / stricter)
 * forms vs the old zod-to-json-schema output, reflected in the committed artifact:
 *  - the `answer_schema` discriminated union renders as `oneOf` (exactly-one) rather
 *    than `anyOf`;
 *  - `z.record(z.string(), …)` maps add `propertyNames: { type: "string" }`.
 * `additionalProperties: false` on closed objects is preserved by declaring those
 * objects with `z.strictObject`.
 *
 * The committed schema keeps the `$ref` + `definitions/DecisionRequest` envelope the
 * legacy artifact used (cross-language consumers resolve `#/definitions/DecisionRequest`),
 * which we rebuild around zod 4's inline body.
 */
export function buildDecisionRequestJsonSchema(): unknown {
  const body = z.toJSONSchema(DecisionRequestSchema, {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;
  // zod 4 stamps `$schema` on the inline body; we re-stamp it on the envelope root
  // to match the committed artifact's shape.
  delete body["$schema"];
  return {
    $ref: "#/definitions/DecisionRequest",
    definitions: { DecisionRequest: body },
    $schema: "http://json-schema.org/draft-07/schema#",
  };
}
