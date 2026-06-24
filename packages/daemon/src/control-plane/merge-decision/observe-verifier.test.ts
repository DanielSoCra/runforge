// GATE (immovable) — the REAL observeVerifierStatus contract (Phase B slice 1).
//
// observeVerifierStatus answers ONE question: does a USABLE, FALSIFIABLE oracle EXIST and is it
// RUNNABLE now — NOT "did it pass this change" (that is the separate validationPassed signal).
// Per the ratified verifier-definition decision: a verifier must be an outcome-failable oracle;
// a bare independent-check (model-as-judge) does NOT qualify; anything undefined/unresolvable
// fails closed so the gate cannot pass.
//
// Contract: observeVerifierStatus(verifier, ctx) where ctx.probeOracle(invoke) reports whether
// the declared oracle is reachable/runnable now (the live call site implements probeOracle
// against the repo workspace; tests inject it).
import { describe, it, expect } from 'vitest';
import { observeVerifierStatus } from './observe-verifier.js';
import { evaluateVerifierGate } from '../lane-engine/verifier-gate/evaluate.js';
import type { VerifierDeclaration } from '../lane-engine/verifier-gate/types.js';

const ctx = (runnable: boolean) => ({ probeOracle: (_invoke: { ref: string }) => runnable });
const decl = (kind: VerifierDeclaration['kind']): VerifierDeclaration => ({ kind, invoke: { ref: 'pnpm test' } });

const FALSIFIABLE: VerifierDeclaration['kind'][] = [
  'test-suite', 'integration', 'e2e', 'deployable-check', 'deterministic',
];

describe('observeVerifierStatus — real observation', () => {
  it('undefined verifier ⇒ fully fail-closed ⇒ gate assist-and-escalate(no-verifier)', () => {
    const status = observeVerifierStatus(undefined, ctx(true));
    expect(status).toEqual({ observed: false, runnable: false, falsifying: false });
    expect(evaluateVerifierGate(undefined, status)).toEqual({
      kind: 'assist-and-escalate', reason: 'no-verifier',
    });
  });

  it('a declared, runnable, outcome-failable verifier ⇒ {observed,runnable,falsifying}=true ⇒ verifier-gated', () => {
    const v = decl('test-suite');
    const status = observeVerifierStatus(v, ctx(true));
    expect(status).toEqual({ observed: true, runnable: true, falsifying: true });
    expect(evaluateVerifierGate(v, status)).toEqual({ kind: 'verifier-gated' });
  });

  it('every outcome-failable kind reaches verifier-gated when runnable', () => {
    for (const kind of FALSIFIABLE) {
      const v = decl(kind);
      expect(observeVerifierStatus(v, ctx(true))).toEqual({ observed: true, runnable: true, falsifying: true });
      expect(evaluateVerifierGate(v, status_for(v))).toEqual({ kind: 'verifier-gated' });
    }
    function status_for(v: VerifierDeclaration) { return observeVerifierStatus(v, ctx(true)); }
  });

  it('a bare independent-check (model-as-judge) is observed+runnable but NOT falsifying ⇒ verifier-non-falsifying', () => {
    const v = decl('independent-check');
    const status = observeVerifierStatus(v, ctx(true));
    expect(status.observed).toBe(true);
    expect(status.runnable).toBe(true);
    expect(status.falsifying).toBe(false);
    expect(evaluateVerifierGate(v, status)).toEqual({
      kind: 'assist-and-escalate', reason: 'verifier-non-falsifying',
    });
  });

  it('a declared oracle that is NOT reachable/runnable ⇒ runnable=false ⇒ verifier-unusable', () => {
    const v = decl('test-suite');
    const status = observeVerifierStatus(v, ctx(false));
    expect(status.observed).toBe(true);
    expect(status.runnable).toBe(false);
    expect(status.falsifying).toBe(false);
    expect(evaluateVerifierGate(v, status)).toEqual({
      kind: 'assist-and-escalate', reason: 'verifier-unusable',
    });
  });
});
