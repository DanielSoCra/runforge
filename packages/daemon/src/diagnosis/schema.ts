import { z } from 'zod';

export const BugDiagnosisSchema = z
  .object({
    type: z.enum(['A', 'B', 'C']),
    confidence: z.number().min(0).max(1),
    affectedSpecs: z.array(z.string()),
    affectedArtifacts: z.array(z.string()),
    suggestedAction: z.string(),
    reasoning: z.string(),
  })
  .refine(
    (d) => d.affectedSpecs.length + d.affectedArtifacts.length >= 1,
    { message: 'At least one affected spec or artifact required' },
  );

export type BugDiagnosisOutput = z.infer<typeof BugDiagnosisSchema>;
// z.toJSONSchema strips the .refine() constraint (not representable in JSON Schema).
// The "at least one affected spec or artifact" rule is enforced at parse time, not in the schema.
// target: 'draft-07' ensures CLI adapter compatibility (spec gotcha: --json-schema requires draft-07).
export const bugDiagnosisJsonSchema = JSON.stringify(
  z.toJSONSchema(BugDiagnosisSchema, { target: 'draft-07' }),
);

export const complianceReportJsonSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['contradiction', 'traceability', 'code-gap'] },
          severity: { type: 'string', enum: ['critical', 'warning'] },
          location: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['type', 'severity', 'location', 'description'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
    compliant: { type: 'boolean' },
  },
  required: ['findings', 'summary', 'compliant'],
  additionalProperties: false,
} as const;
