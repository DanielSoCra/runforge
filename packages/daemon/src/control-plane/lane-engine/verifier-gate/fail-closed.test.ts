// Non-gate regression test: the gate must fail CLOSED on partial/undefined status
// fields (e.g. a status cast from runtime/JSON that omits `falsifying`).
import { describe, it, expect } from 'vitest';
import { evaluateVerifierGate } from './evaluate.js';
import type { VerifierDeclaration, VerifierStatus } from './types.js';

const decl: VerifierDeclaration = { kind: 'test-suite', invoke: { ref: 'pnpm test' } };

describe('evaluateVerifierGate — fail-closed on partial status', () => {
  it('withholds when falsifying is missing (undefined !== true)', () => {
    const partial = { observed: true, runnable: true } as unknown as VerifierStatus;
    const r = evaluateVerifierGate(decl, partial);
    expect(r.kind).toBe('assist-and-escalate');
    if (r.kind === 'assist-and-escalate') expect(r.reason).toBe('verifier-non-falsifying');
  });

  it('withholds when observed is missing', () => {
    const partial = {} as unknown as VerifierStatus;
    const r = evaluateVerifierGate(decl, partial);
    expect(r.kind).toBe('assist-and-escalate');
    if (r.kind === 'assist-and-escalate') expect(r.reason).toBe('evaluation-indeterminate');
  });

  it('still passes only when all three are explicitly true', () => {
    const r = evaluateVerifierGate(decl, { observed: true, runnable: true, falsifying: true });
    expect(r.kind).toBe('verifier-gated');
  });
});
