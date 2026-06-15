// packages/daemon/src/control-plane/lane-engine/verifier-gate/evaluate.ts
//
// Pure precondition evaluation for FUNC-AC-VERIFIER-GATE. No I/O, no thrown
// errors on policy questions, no 'granted' arm, no mutation of inputs.
// The ONLY path to 'verifier-gated' is a present + runnable + falsifying
// verifier; every other input returns 'assist-and-escalate'.

import type { VerifierDeclaration, VerifierGateResult, VerifierStatus } from './types.js';

export function evaluateVerifierGate(
  declaration: VerifierDeclaration | undefined,
  status: VerifierStatus,
): VerifierGateResult {
  if (declaration === undefined) {
    return { kind: 'assist-and-escalate', reason: 'no-verifier' };
  }
  if (status.observed === false) {
    return { kind: 'assist-and-escalate', reason: 'evaluation-indeterminate' };
  }
  if (status.runnable === false) {
    return { kind: 'assist-and-escalate', reason: 'verifier-unusable' };
  }
  if (status.falsifying === false) {
    return { kind: 'assist-and-escalate', reason: 'verifier-non-falsifying' };
  }
  return { kind: 'verifier-gated' };
}
