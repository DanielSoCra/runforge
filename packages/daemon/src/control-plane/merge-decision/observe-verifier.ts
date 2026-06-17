// packages/daemon/src/control-plane/merge-decision/observe-verifier.ts
//
// observeVerifierStatus — the LIVE shim that produces the VerifierStatus the
// verifier gate consumes (does a falsifying verifier EXIST and is it runnable
// NOW). This is the merge path's single observation point for the lane's declared
// oracle; the pure decideMerge never observes anything itself.
//
// STUB — Kimi fills the body. CONSERVATIVE / FAIL-CLOSED BY CONTRACT
// (FUNC-AC-MERGE-DECISION + the verifier-gate spec): when the live verifier
// observation is unavailable / indeterminate, this MUST return a status that the
// gate cannot pass — i.e. NOT { observed:true, runnable:true, falsifying:true }.
// The safe default is `{ observed:false, runnable:false, falsifying:false }`,
// which drives the gate to 'assist-and-escalate' (verifier-withheld). Real
// verifier-observation plumbing is a NAMED DEFERRAL in the plan — until it lands,
// the shim returns the withheld default rather than asserting a passing oracle.
//
// `validationPassed` (whether the lane's gate-set actually RAN and PASSED) is a
// SEPARATE signal the integrate handler derives from the run's own validation
// outcome — NOT produced here. This shim answers only "does a usable falsifying
// verifier exist", not "did it pass for this change".

import type {
  VerifierDeclaration,
  VerifierStatus,
} from '../lane-engine/verifier-gate/types.js';

/**
 * Observe the live status of a lane's declared verifier. `verifier` is the
 * assigned ResolvedLane's `verifier` (undefined when the lane declares none).
 * Returns a fail-closed VerifierStatus.
 */
export function observeVerifierStatus(
  verifier: VerifierDeclaration | undefined,
): VerifierStatus {
  // Real verifier-observation plumbing is a named deferral. Until it lands,
  // fail closed: a usable falsifying verifier can only be confirmed by live
  // observation, so any indeterminate state (including undefined) withholds
  // autonomy and drives the gate to 'assist-and-escalate'.
  void verifier;
  return { observed: false, runnable: false, falsifying: false };
}
