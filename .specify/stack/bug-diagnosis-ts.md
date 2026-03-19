---
id: STACK-AC-DIAGNOSIS
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-DIAGNOSIS
code_paths:
  - packages/daemon/src/diagnosis/
test_paths:
  - packages/daemon/src/diagnosis/**/*.test.ts
---

# STACK-AC-DIAGNOSIS — Bug Diagnosis Service (TypeScript)

## Pattern

**One-shot session with structured output validation.** The diagnostician is a single prompt → response session (not agentic). It receives the bug report, implementation, and spec content as a single assembled prompt and returns structured JSON validated against a Zod schema. No tool use, no multi-turn — diagnosis is a classification task, not an exploration task.

## Key Decisions

**Structured output: `--json-schema` (CLI) or `outputSchema` (SDK).** The diagnosis schema is defined once as a Zod schema, converted to JSON Schema for the CLI adapter, and used directly as a TypeScript type for the SDK adapter. Zod is the single source of truth for the shape.

**Schema validation: Zod.** Runtime validation of the session's JSON output. Chosen over Ajv (Zod integrates with TypeScript types — one schema produces both runtime validation and compile-time types). The schema defines: `type` (enum: 'A' | 'B' | 'C'), `confidence` (number 0-1), `affectedSpecs` (string[]), `affectedArtifacts` (string[]), `suggestedAction` (string), `reasoning` (string).

**Confidence threshold: Configuration value.** Stored in `config.diagnosis.confidenceThreshold` (default: 0.7). Not hard-coded — the Operator can tune this based on observed false positive/negative rates.

**Prompt assembly: Context concatenation.** The diagnostic prompt concatenates: system instructions (classification rules, output format), bug report body, affected implementation content (read from the branch), and governing spec content (pre-loaded by the Control Plane). Total context must fit in a single reasoning context — if it doesn't, truncate implementation content to the most relevant files (guided by artifact paths in the bug report).

## Examples

```typescript
// Diagnosis schema (Zod — single source of truth)
const BugDiagnosisSchema = z.object({
  type: z.enum(['A', 'B', 'C']),
  confidence: z.number().min(0).max(1),
  affectedSpecs: z.array(z.string()),
  affectedArtifacts: z.array(z.string()),
  suggestedAction: z.string(),
  reasoning: z.string(),
}).refine(d => d.affectedSpecs.length + d.affectedArtifacts.length >= 1,
  { message: 'At least one affected spec or artifact required' });
type BugDiagnosis = z.infer<typeof BugDiagnosisSchema>;
```

```typescript
// Zod → JSON Schema conversion (for CLI adapter)
import { zodToJsonSchema } from 'zod-to-json-schema';
const jsonSchema = zodToJsonSchema(BugDiagnosisSchema);
```

```typescript
// Diagnosis routing
function routeDiagnosis(d: BugDiagnosis, threshold: number): RoutingDecision {
  if (d.confidence < threshold) return { route: 'needs-human', reason: 'low confidence' };
  if (d.type === 'A') return { route: 'bug-pipeline' };
  if (d.type === 'B') return { route: 'needs-spec-update' };
  return { route: 'needs-human', reason: 'type C' };
}
```

## Gotchas

- The `--json-schema` flag in the CLI adapter requires the schema to be a valid JSON Schema draft-07 string. `zod-to-json-schema` produces draft-07 by default — verify this on library updates.
- One-shot sessions (`--max-turns 1`) still consume the full prompt context. If the bug report + implementation + specs exceed the model's context window, the session will fail or truncate. Measure prompt size before spawning and truncate proactively.
- Confidence scores from LLMs are notoriously unreliable. The threshold is a safety net, not a guarantee. Calibrate by reviewing historical Type A diagnoses that turned out to be Type B — if this happens frequently, raise the threshold.
- The diagnostician prompt should explicitly instruct the model to output `"C"` when unsure, not to fabricate a confident `"A"` or `"B"`. The prompt itself is a safety mechanism.
- Retry on invalid output: if the session returns JSON that fails Zod validation, retry once with the same prompt. If the second attempt also fails, route to human (`needs-human` label) with a note that automatic diagnosis failed. Same fallback for session timeout and budget exceeded.
- The BugDiagnosis result must include all fields needed for the results ledger entry (classification type, confidence, outcome). The Control Plane records these in `state/results.jsonl` after routing.
