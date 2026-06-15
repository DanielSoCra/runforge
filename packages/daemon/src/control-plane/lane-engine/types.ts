// packages/daemon/src/control-plane/lane-engine/types.ts

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

/** A field that may be a single value, or declared per lifecycle phase. */
export type ByMode<T> = T | Record<string, T>;

export interface LaneQualification {
  complexity?: Complexity[];
  changeKind?: ChangeKind[];
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
  touchedPaths: string[];
}

export type Eligibility =
  | {
      kind: 'eligible';
      effectiveRisk: RiskLevel;
      gateSet: string;
      mergePolicy: MergePolicy;
      tripwire: TripwireVerdict;
    }
  | {
      kind: 'escalate';
      effectiveRisk: RiskLevel;
      reason: 'out-of-scope';
      tripwire: TripwireVerdict;
    };

export interface LaneTrackRecord {
  cleanMerges: number;
  bounceFreeDays: number;
}

export type EarnInResult =
  | { kind: 'not-eligible'; reasons: string[] }
  | { kind: 'eligible-for-promotion'; evidence: LaneTrackRecord };
