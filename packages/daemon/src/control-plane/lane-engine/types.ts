// packages/daemon/src/control-plane/lane-engine/types.ts

import type { VerifierDeclaration } from './verifier-gate/types.js';

/** Risk levels, ordered least → most cautious. */
export type RiskLevel = 'green' | 'yellow' | 'orange' | 'red';

/** Classifier complexity (mirrors the existing ClassificationResult enum). */
export type Complexity = 'simple' | 'standard' | 'complex';

/** Kind of change, used for lane qualification. */
export type ChangeKind =
  | 'docs'
  | 'formatting'
  | 'dependency-refresh'
  | 'feature'
  | 'fix'
  | 'refactor'
  | 'config'
  | 'other';

/** How a qualifying change may join the shared mainline. Ordered by caution. */
export type MergePolicy = 'auto' | 'review-then-auto' | 'hold';

/**
 * The platform's gate vocabulary (XCUT P2#1) — the concrete checks a gate-set
 * DEFINITION may reference and the keys a run records in `RunState.passedGates`.
 * Superset of the four review `GateType`s (`result.gateResults[].gate`) plus
 * `'holdout'`, which is a lifecycle PHASE rather than a review gate — it produces
 * no `gateResults` entry, so the holdout handler appends the key itself when its
 * scenarios pass. This is the SINGLE source of truth for gate-set membership; a
 * gate-set definition naming a key outside this set is rejected at pack
 * activation.
 */
export type GateKey =
  | 'deterministic'
  | 'spec-compliance'
  | 'quality'
  | 'security'
  | 'holdout';

/**
 * A single gate-set DEFINITION: the gate keys that must have PASSED for the set
 * to be satisfied. Keyed by gate-set NAME in `GateSetDefinitions` (the same name
 * space a lane's `gateSet` field selects). `required` is the closed contract the
 * pure `gateSetVerdict` evaluates against a run's observed `passedGates`.
 */
export interface GateSetDefinition {
  required: GateKey[];
}

/**
 * The deployment-level map from gate-set NAME → its definition. OPTIONAL on a
 * deployment profile: absent ⇒ the lane-specific gate-set verdict feature is
 * INERT (the integrate handler preserves today's safe `validationPassed = true`).
 * When present, a lane's resolved `gateSet` name is looked up here; a
 * declared-but-dangling reference (lane names a set not in this map) fails CLOSED.
 */
export type GateSetDefinitions = Record<string, GateSetDefinition>;

/** A field that may be a single value, or declared per lifecycle phase. */
export type ByMode<T> = T | Record<string, T>;

export interface LaneQualification {
  complexity?: Complexity[];
  changeKind?: ChangeKind[];
  /** Declared-scope categories the lane qualifies on (matched against the verdict's scope). */
  scope?: string[];
}

export interface BatchReviewPolicy {
  enabled: boolean;
  cadence: string;
}

export interface EarnInPolicy {
  cleanMerges: number;
  bounceFreeDays: number;
}

/** Raw lane declaration as it arrives from a config pack (pre mode-resolution). */
export interface LaneDefinition {
  name: string;
  qualify: LaneQualification;
  allowedPaths: string[];
  roleRouting: Record<string, string>;
  gateSet: ByMode<string>;
  mergePolicy: ByMode<MergePolicy>;
  postMergeReview?: BatchReviewPolicy;
  earnIn?: EarnInPolicy;
  /**
   * Optional pre-approved earn-in policy declaration. Opaque to the Lane Engine;
   * earn-in is its sole interpreter. `enabled: false` makes the policy inert.
   */
  preApprovedEarnIn?: { enabled: boolean; policyRef: string };
  /**
   * The falsifiable oracle this lane declares for verifier-gated autonomy. A
   * lane without it withholds autonomy (the merge-decision gate escalates
   * `verifier-withheld`). Optional so existing packs without a declaration stay
   * valid — they simply never earn auto-merge.
   */
  verifier?: VerifierDeclaration;
}

/** A validated, frozen set of lanes for one deployment + its declared phases. */
export interface LaneSet {
  lanes: LaneDefinition[];
  mostCautiousLane: string;
  declaredPhases: string[];
}

/** A lane after lifecycle-mode resolution: gateSet & mergePolicy are plain values. */
export interface ResolvedLane {
  name: string;
  qualify: LaneQualification;
  allowedPaths: string[];
  roleRouting: Record<string, string>;
  gateSet: string;
  mergePolicy: MergePolicy;
  postMergeReview?: BatchReviewPolicy;
  earnIn?: EarnInPolicy;
  /** Carried through mode resolution unchanged (earn-in is mode-invariant). */
  preApprovedEarnIn?: { enabled: boolean; policyRef: string };
  /** Carried through mode resolution unchanged (the verifier is mode-invariant). */
  verifier?: VerifierDeclaration;
}

export interface ModeResolution {
  /** The phase actually used, or null when degraded. */
  mode: string | null;
  degraded: boolean;
  cause?: string;
}

export interface ResolvedLaneSet {
  lanes: ResolvedLane[];
  mostCautiousLane: string;
  resolution: ModeResolution;
}

/** The classifier output fields lane assignment matches on. */
export interface ClassifierVerdict {
  complexity?: Complexity;
  changeKind?: ChangeKind;
  /** Declared-scope category. Populated by the Plan-2 classifier extension; matched against a lane's `scope`. */
  scope?: string;
}

export type LaneAssignmentResult =
  | { kind: 'assigned'; lane: string; reasons: string[] }
  | {
      kind: 'fallback-most-cautious';
      lane: string;
      cause: 'no-match' | 'ambiguous' | 'verdict-unavailable';
    };

export type TripwireVerdict =
  | { kind: 'in-scope'; touched: string[] }
  | { kind: 'out-of-scope'; touched: string[]; outside: string[] };

export interface RiskPathEntry {
  paths: string[];
  minLevel: RiskLevel;
}
export type RiskPathMap = RiskPathEntry[];

export interface EligibilityInput {
  lane: ResolvedLane;
  classifierLevel: RiskLevel;
  riskPathMap: RiskPathMap;
  /** The deployment's configured default minimum risk level — applied to paths that match no RiskPathMap entry. */
  defaultMinLevel: RiskLevel;
  touchedPaths: string[];
  /** The mode resolution the lane was resolved under (from resolveForMode), carried into the result for audit. */
  modeResolution: ModeResolution;
}

export type Eligibility =
  | {
      kind: 'eligible';
      effectiveRisk: RiskLevel;
      gateSet: string;
      mergePolicy: MergePolicy;
      tripwire: TripwireVerdict;
      modeResolution: ModeResolution;
    }
  | {
      kind: 'escalate';
      effectiveRisk: RiskLevel;
      reason: 'out-of-scope';
      tripwire: TripwireVerdict;
      modeResolution: ModeResolution;
    };

export interface LaneTrackRecord {
  cleanMerges: number;
  bounceFreeDays: number;
}

export type EarnInResult =
  | { kind: 'not-eligible'; reasons: string[] }
  | { kind: 'eligible-for-promotion'; evidence: LaneTrackRecord };
