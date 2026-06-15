// packages/daemon/src/control-plane/lane-engine/verifier-gate/types.ts
//
// Type-only exports for the verifier-gate precondition. The gate consumes a
// validated VerifierDeclaration and an observed VerifierStatus and returns a
// fail-closed discriminated union: only a present + runnable + falsifying
// verifier reaches 'verifier-gated'; every other path returns
// 'assist-and-escalate' with a reason.

export type VerifierKind =
  | 'test-suite'
  | 'integration'
  | 'e2e'
  | 'deployable-check'
  | 'deterministic'
  | 'independent-check';

export interface VerifierInvocationRef {
  /** How the oracle is run and how its verdict is observed. */
  ref: string;
}

export interface VerifierDeclaration {
  /** The kind of falsifiable oracle this lane declares. */
  kind: VerifierKind;
  /** A reference to how the oracle is invoked and its verdict observed. */
  invoke: VerifierInvocationRef;
}

export interface VerifierStatus {
  /** Whether the verifier was observed at evaluation time. */
  observed: boolean;
  /** Whether the verifier is reachable and runnable now. */
  runnable: boolean;
  /** Whether the verifier has been shown able to return a failing verdict. */
  falsifying: boolean;
}

export type VerifierGateResult =
  | { kind: 'verifier-gated' }
  | {
      kind: 'assist-and-escalate';
      reason:
        | 'no-verifier'
        | 'verifier-unusable'
        | 'verifier-non-falsifying'
        | 'evaluation-indeterminate';
    };
