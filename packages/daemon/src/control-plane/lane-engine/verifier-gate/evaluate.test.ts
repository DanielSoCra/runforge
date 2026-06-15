// packages/daemon/src/control-plane/lane-engine/verifier-gate/evaluate.test.ts
//
// IMMOVABLE acceptance gate for the verifier-gate precondition (STACK-AC-VERIFIER-GATE,
// ARCH-AC-VERIFIER-GATE, FUNC-AC-VERIFIER-GATE). Encodes the default-deny shape: the ONLY
// path to 'verifier-gated' is a present + runnable + falsifying verifier; every other input
// returns 'assist-and-escalate' with the matching reason. The implementer makes these pass
// WITHOUT modifying them.
import { describe, it, expect } from 'vitest';
import { evaluateVerifierGate } from './evaluate.js';
import type { VerifierDeclaration, VerifierStatus, VerifierGateResult } from './types.js';

// A shape-valid declaration. `kind` is data — the gate must NOT trust it as a usability flag.
const declaration: VerifierDeclaration = {
  kind: 'test-suite',
  invoke: { ref: 'pnpm -C packages/daemon test' },
};

/** A fully-usable observed status: the ONLY combination that may reach 'verifier-gated'. */
const usable: VerifierStatus = { observed: true, runnable: true, falsifying: true };

describe('evaluateVerifierGate — the single permissive path', () => {
  it('returns verifier-gated for a present + runnable + falsifying verifier', () => {
    const result = evaluateVerifierGate(declaration, usable);
    expect(result).toEqual({ kind: 'verifier-gated' });
  });

  it('verifier-gated carries no reason and no granted/auto-merge field', () => {
    const result = evaluateVerifierGate(declaration, usable);
    expect(result.kind).toBe('verifier-gated');
    // The permissive verdict only declines-to-withhold; it never authorizes passage.
    expect(result).not.toHaveProperty('reason');
    expect(result).not.toHaveProperty('granted');
  });
});

describe('evaluateVerifierGate — default-deny for every other input', () => {
  it('undefined declaration → assist-and-escalate / no-verifier (the default)', () => {
    const result = evaluateVerifierGate(undefined, usable);
    expect(result).toEqual({ kind: 'assist-and-escalate', reason: 'no-verifier' });
  });

  it('declared but unobserved status → assist-and-escalate / evaluation-indeterminate', () => {
    const result = evaluateVerifierGate(declaration, {
      observed: false,
      runnable: true,
      falsifying: true,
    });
    expect(result).toEqual({ kind: 'assist-and-escalate', reason: 'evaluation-indeterminate' });
  });

  it('declared but not runnable (unreachable/unrunnable) → assist-and-escalate / verifier-unusable', () => {
    const result = evaluateVerifierGate(declaration, {
      observed: true,
      runnable: false,
      falsifying: true,
    });
    expect(result).toEqual({ kind: 'assist-and-escalate', reason: 'verifier-unusable' });
  });

  it('declared oracle that cannot return a failing verdict → assist-and-escalate / verifier-non-falsifying', () => {
    const result = evaluateVerifierGate(declaration, {
      observed: true,
      runnable: true,
      falsifying: false,
    });
    expect(result).toEqual({ kind: 'assist-and-escalate', reason: 'verifier-non-falsifying' });
  });

  it('a non-falsifying oracle is treated identically to absent (a check that cannot fail is not a verifier)', () => {
    const nonFalsifying = evaluateVerifierGate(declaration, {
      observed: true,
      runnable: true,
      falsifying: false,
    });
    const absent = evaluateVerifierGate(undefined, usable);
    expect(nonFalsifying.kind).toBe(absent.kind); // both withhold autonomy
    expect(nonFalsifying.kind).toBe('assist-and-escalate');
  });
});

describe('evaluateVerifierGate — fail-closed structure (the result can never grant)', () => {
  it('never returns a granted/auto-merge arm — only verifier-gated permits proceeding', () => {
    const samples: VerifierGateResult[] = [
      evaluateVerifierGate(declaration, usable),
      evaluateVerifierGate(undefined, usable),
      evaluateVerifierGate(declaration, { observed: false, runnable: false, falsifying: false }),
      evaluateVerifierGate(declaration, { observed: true, runnable: false, falsifying: false }),
      evaluateVerifierGate(declaration, { observed: true, runnable: true, falsifying: false }),
    ];
    for (const result of samples) {
      expect(['verifier-gated', 'assist-and-escalate']).toContain(result.kind);
      // No 'granted' arm exists at runtime regardless of input.
      expect(result.kind).not.toBe('granted');
    }
  });

  it('any partial/doubtful status withholds autonomy — only the fully-checked happy path passes', () => {
    // Every combination EXCEPT (true,true,true) must NOT be verifier-gated. This pins the
    // guard ordering so a future-added VerifierStatus field cannot silently become a pass.
    const bools = [true, false];
    for (const observed of bools) {
      for (const runnable of bools) {
        for (const falsifying of bools) {
          const result = evaluateVerifierGate(declaration, { observed, runnable, falsifying });
          if (observed && runnable && falsifying) {
            expect(result.kind).toBe('verifier-gated');
          } else {
            expect(result.kind).toBe('assist-and-escalate');
          }
        }
      }
    }
  });

  it('is pure — the same inputs always yield the same verdict, and inputs are not mutated', () => {
    const decl: VerifierDeclaration = { kind: 'e2e', invoke: { ref: 'run-e2e' } };
    const status: VerifierStatus = { observed: true, runnable: true, falsifying: true };
    const first = evaluateVerifierGate(decl, status);
    const second = evaluateVerifierGate(decl, status);
    expect(first).toEqual(second);
    expect(decl).toEqual({ kind: 'e2e', invoke: { ref: 'run-e2e' } });
    expect(status).toEqual({ observed: true, runnable: true, falsifying: true });
  });

  it('does not throw on any policy question (exceptions are reserved for programmer error)', () => {
    expect(() => evaluateVerifierGate(undefined, usable)).not.toThrow();
    expect(() =>
      evaluateVerifierGate(declaration, { observed: false, runnable: false, falsifying: false }),
    ).not.toThrow();
  });
});

describe('verifier-gate composes AHEAD of lane eligibility (precondition, never a substitute)', () => {
  // The L3/L2 contract: only a 'verifier-gated' result proceeds to the lane-engine eligibility
  // path; an 'assist-and-escalate' result makes the lane-engine result moot, so the caller must
  // NOT proceed. The L3 expresses this composition inline at the caller (no pure helper is
  // defined for it), so we encode the load-bearing caller predicate directly: proceed-to-other-
  // gates IFF the gate is verifier-gated.
  const proceedsToOtherGates = (g: VerifierGateResult): boolean => g.kind === 'verifier-gated';

  it('a verifier-gated result is the only one that proceeds to lane eligibility', () => {
    expect(proceedsToOtherGates(evaluateVerifierGate(declaration, usable))).toBe(true);
  });

  it('an assist-and-escalate result does NOT proceed to lane eligibility (lane result is moot)', () => {
    const withheld = evaluateVerifierGate(undefined, usable);
    expect(proceedsToOtherGates(withheld)).toBe(false);
    const degraded = evaluateVerifierGate(declaration, {
      observed: true,
      runnable: false,
      falsifying: true,
    });
    expect(proceedsToOtherGates(degraded)).toBe(false);
  });
});
