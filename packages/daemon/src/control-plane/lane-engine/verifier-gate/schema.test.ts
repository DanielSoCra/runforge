// packages/daemon/src/control-plane/lane-engine/verifier-gate/schema.test.ts
//
// IMMOVABLE acceptance gate for the VerifierDeclaration schema (STACK-AC-VERIFIER-GATE).
// The declaration is an OPTIONAL field on a lane: absence is the valid default and means
// "this lane is not verifier-gated". The schema is .strict() — a typo'd key must fail pack
// activation (fail-closed), exactly like LaneDefinitionSchema. The gate never trusts a
// self-asserted "isVerifier" flag, so the declaration carries `kind` (data) + `invoke`, not
// a boolean usability flag. The implementer makes these pass WITHOUT modifying them.
import { describe, it, expect } from 'vitest';
import { VerifierDeclarationSchema } from './schema.js';

const validDeclaration = {
  kind: 'test-suite',
  invoke: { ref: 'pnpm -C packages/daemon test' },
};

describe('VerifierDeclarationSchema', () => {
  it('accepts a shape-valid declaration', () => {
    const r = VerifierDeclarationSchema.safeParse(validDeclaration);
    expect(r.success).toBe(true);
  });

  it('rejects an unknown key instead of silently stripping it (.strict(), fail-closed)', () => {
    // A typo or a self-asserted flag must fail activation, never collapse to a loose default.
    const r = VerifierDeclarationSchema.safeParse({ ...validDeclaration, isVerifier: true });
    expect(r.success).toBe(false);
  });

  it('rejects a missing kind', () => {
    const r = VerifierDeclarationSchema.safeParse({ invoke: { ref: 'x' } });
    expect(r.success).toBe(false);
  });

  it('rejects a missing invoke reference', () => {
    const r = VerifierDeclarationSchema.safeParse({ kind: 'test-suite' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown verifier kind (kind is a closed enum of falsifiable-oracle kinds)', () => {
    const r = VerifierDeclarationSchema.safeParse({ kind: 'vibes', invoke: { ref: 'x' } });
    expect(r.success).toBe(false);
  });

  it('accepts each declared verifier kind from the L3 enum', () => {
    const kinds = [
      'test-suite',
      'integration',
      'e2e',
      'deployable-check',
      'deterministic',
      'independent-check',
    ];
    for (const kind of kinds) {
      const r = VerifierDeclarationSchema.safeParse({ kind, invoke: { ref: 'x' } });
      expect(r.success).toBe(true);
    }
  });

  it('is optional on a lane — an absent declaration is valid (means not verifier-gated)', () => {
    // `.optional()` accepts undefined; an undeclared verifier is the default, not an error.
    const r = VerifierDeclarationSchema.optional().safeParse(undefined);
    expect(r.success).toBe(true);
    // The parsed value for an absent declaration is undefined (no default is injected).
    const parsed = r.success === true ? r.data : null;
    expect(parsed).toBeUndefined();
  });
});
