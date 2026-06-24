// packages/daemon/src/control-plane/merge-decision/observe-verifier.ts
//
// observeVerifierStatus — the LIVE shim that produces the VerifierStatus the
// verifier gate consumes (does a falsifying verifier EXIST and is it runnable
// NOW). This is the merge path's single observation point for the lane's declared
// oracle; the pure decideMerge never observes anything itself.
//
// CONSERVATIVE / FAIL-CLOSED BY CONTRACT (FUNC-AC-MERGE-DECISION + the
// verifier-gate spec): when the live verifier observation is unavailable /
// indeterminate, this MUST return a status that the gate cannot pass — i.e. NOT
// { observed:true, runnable:true, falsifying:true }. The safe default is
// `{ observed:false, runnable:false, falsifying:false }`, which drives the gate to
// 'assist-and-escalate' (verifier-withheld). Real observation confirms only:
//   1. a verifier is declared,
//   2. its invocation ref is reachable/runnable now (via ctx.probeOracle),
//   3. its kind is outcome-falsifiable (FALSIFIABLE_KINDS).
// Anything else — undefined verifier, unresolvable ref, probe throw, unknown kind —
// fails closed.
//
// `validationPassed` (whether the lane's gate-set actually RAN and PASSED) is a
// SEPARATE signal the integrate handler derives from the run's own validation
// outcome — NOT produced here. This shim answers only "does a usable falsifying
// verifier exist", not "did it pass for this change".

import type {
  VerifierDeclaration,
  VerifierInvocationRef,
  VerifierStatus,
} from '../lane-engine/verifier-gate/types.js';

/** Kinds of verifier that are outcome-falsifiable by construction. */
const FALSIFIABLE_KINDS = new Set<VerifierDeclaration['kind']>([
  'test-suite',
  'integration',
  'e2e',
  'deployable-check',
  'deterministic',
]);

/** Context for live verifier observation. */
export interface VerifierObservationContext {
  /**
   * Report whether the declared oracle is reachable/runnable NOW.
   * Must return `false` (or throw) when runnability cannot be positively
   * confirmed; observeVerifierStatus treats any throw as `false`.
   */
  probeOracle: (invoke: VerifierInvocationRef) => boolean;
}

function safeProbe(
  ctx: VerifierObservationContext,
  invoke: VerifierInvocationRef,
): boolean {
  try {
    return ctx.probeOracle(invoke) === true;
  } catch {
    // Any probe failure is an indeterminate oracle → fail closed.
    return false;
  }
}

/**
 * Observe the live status of a lane's declared verifier. `verifier` is the
 * assigned ResolvedLane's `verifier` (undefined when the lane declares none).
 * Returns a fail-closed VerifierStatus.
 */
export function observeVerifierStatus(
  verifier: VerifierDeclaration | undefined,
  ctx: VerifierObservationContext,
): VerifierStatus {
  const observed = verifier !== undefined;
  const runnable =
    verifier !== undefined && safeProbe(ctx, verifier.invoke);
  const falsifying =
    runnable && FALSIFIABLE_KINDS.has(verifier.kind);

  return { observed, runnable, falsifying };
}
