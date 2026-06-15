// packages/daemon/src/control-plane/lane-engine/verifier-gate/schema.ts
//
// Zod schema for a lane's optional VerifierDeclaration. The schema is .strict()
// so a typo'd key or self-asserted usability flag fails pack activation rather
// than collapsing into an unintended default. The gate does not trust the kind
// as a usability flag — it is data only.

import { z } from 'zod';
import type { VerifierDeclaration } from './types.js';

const VerifierKind = z.enum([
  'test-suite',
  'integration',
  'e2e',
  'deployable-check',
  'deterministic',
  'independent-check',
]);

export const VerifierDeclarationSchema: z.ZodType<VerifierDeclaration> = z
  .object({
    kind: VerifierKind,
    invoke: z.object({ ref: z.string().min(1) }).strict(),
  })
  .strict();
