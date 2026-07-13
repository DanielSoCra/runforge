// packages/daemon/src/control-plane/deployment-registry/types.ts
//
// Deployment-Profile Registry — types (STACK-AC-DEPLOYMENT-REGISTRY / L3).
//
// Composition, not re-declaration: the lane-engine owns LaneSet / RiskPathMap /
// RiskLevel / RiskPathEntry / ModeResolution and the window-scheduler owns
// PoolConfig. We re-export those verbatim and define only the *envelope* shapes
// the siblings do not (repositories, lifecycle mode, declared data, autonomy
// state) plus the cross-record outcome/result discriminated unions.

import type {
  LaneSet,
  RiskPathMap,
  RiskLevel,
  GateSetDefinitions,
} from '../lane-engine/types.js';
import type { PoolConfig } from '../../session-runtime/providers/window-scheduler/types.js';
import type { SanitizerConfig } from '@runforge/sanitization';
import type { ComplianceReviewVerdict } from '../../compliance/schemas.js';

// Re-export the sibling shapes so consumers of the registry import them from one
// place and never re-declare a lane/pool/risk field (the L3 composition rule).
export type { LaneSet, RiskPathMap, RiskPathEntry, RiskLevel, ModeResolution, GateKey, GateSetDefinition, GateSetDefinitions } from '../lane-engine/types.js';
export type { PoolConfig } from '../../session-runtime/providers/window-scheduler/types.js';

/**
 * A risk *class* the autonomy state is keyed by. The L2 says autonomy is recorded
 * "per risk class"; the risk vocabulary is the lane engine's four-level enum, so
 * RiskClass IS RiskLevel — no second vocabulary (L3: "no second risk vocabulary").
 */
export type RiskClass = RiskLevel;

/** Whether a (deployment, risk class) pair is human-gated or has been widened. */
export type AutonomyLevel = 'human-gated' | 'widened';

/**
 * How a widening was authorized. Either a per-event Operator grant, a pre-approved
 * earn-in policy auto-promotion (carrying cleared floors + triggering evidence),
 * or an automatic demote-on-red reversal.
 */
export type AutonomyAuthorization =
  | { kind: 'operator-grant'; operator: string }
  | {
      kind: 'earn-in-policy';
      policyRef: string;
      /** Required on a mint; optional on the type only for backward-compat with existing tests. */
      clearedFloors?: string[];
      /** Required on a mint; optional on the type only for backward-compat with existing tests. */
      evidence?: EarnInWideningEvidence;
    }
  | { kind: 'demote-on-red'; trigger: string };

/** The triggering track-record snapshot recorded with an earn-in-policy widening. */
export interface EarnInWideningEvidence {
  cleanMerges: number;
  cleanMergesInWindow: number;
  bounceFreeDays: number;
  redEventInWindow: boolean;
}

/** A repository this deployment owns, identified by owner + name. */
export interface OwnedRepository {
  owner: string;
  name: string;
}

/** A single compliance reviewer declaration (who reviews, for which condition). */
export interface ComplianceReviewer {
  reviewer: string;
  condition: string;
}

/** The deployment's classification of its own work (honest-automation map). */
export interface HonestAutomationMap {
  automatable: string[];
  strained: string[];
  irreduciblyHuman: string[];
}

/** How a deployment's production release is carried out (one of three declared shapes). */
export type DeclaredReleasePath =
  | { kind: 'platform-performs' }
  | { kind: 'trigger-automated'; trigger: string }
  | { kind: 'record-only'; procedure: string };

/** Where changes may land first, and the declared path to production release. */
export interface LandingTarget {
  landsOn: string;
  productionReleasePath: DeclaredReleasePath;
  /**
   * OPTIONAL explicit list of required check names the daemon polls before a
   * controlled code-change merge. Absent or empty for a governed deployment is
   * treated as fail-closed (escalate) — never as an implicit green.
   */
  requiredChecks?: string[];
  /**
   * OPTIONAL required-check wait policy in milliseconds. Absent falls back to
   * the await-checks defaults (60s budget / 5s poll).
   */
  checkBudgetMs?: number;
  checkPollMs?: number;
}

/** For each shared capability, the identified version this deployment is bound to. */
export interface CapabilityBinding {
  capability: string;
  version: string;
}

/**
 * The self-describing record for one deployment, keyed by deployment id. Parsed
 * once, validated atomically, deep-frozen for the life of the activation.
 *
 * `laneSet` is the lane engine's own frozen LaneSet (verbatim, the object the
 * engine consumes). `riskPathMap` + `defaultMinLevel` are exactly the pair the
 * Lane Engine's floor consumes. `fleetCapacity` is NOT held here — capacity pools
 * are a fleet-level record (FleetCapacityConfig).
 */
export interface DeploymentProfile {
  id: string;
  repositories: OwnedRepository[];
  riskPathMap: RiskPathMap;
  defaultMinLevel: RiskLevel;
  laneSet: LaneSet;
  /**
   * OPTIONAL gate-set DEFINITIONS (XCUT P2#1): gate-set NAME → the gate keys that
   * must have PASSED for the set to be satisfied. The integrate verdict looks up a
   * lane's resolved `gateSet` name here. Absent ⇒ the verdict feature is inert.
   */
  gateSets?: GateSetDefinitions;
  /**
   * OPTIONAL sanitizer bindings (STACK-AC-SANITIZATION). Absent or empty ⇒ the
   * input-boundary sanitization pipeline is the identity (default today).
   */
  sanitizers?: SanitizerConfig;
  /** Currently declared lifecycle phase — must be one of laneSet.declaredPhases. */
  lifecycleMode: string;
  complianceReviewers: ComplianceReviewer[];
  /**
   * OPTIONAL recorded compliance review verdicts (FUNC-AC-COMPLIANCE-GATE):
   * one entry per reviewer that has reviewed this deployment's regulated paths,
   * keyed downstream by `reviewerRoleId`. Absent ⇒ the merge-decision compliance
   * lens falls back to path-condition matching (force escalation on any match);
   * present ⇒ the full evaluator runs and a recorded `pass` from every required
   * reviewer can earn a `proceed` that clears the force.
   */
  complianceVerdicts?: ComplianceReviewVerdict[];
  honestAutomation: HonestAutomationMap;
  budget: number;
  landing: LandingTarget;
  capabilityBindings: CapabilityBinding[];
}

/**
 * The single fleet-level capacity-pool record (shared subscriptions). Validated
 * once via the window-scheduler's PoolConfigSchema + validatePoolMembership; held
 * independently of any one deployment's profile.
 */
export interface FleetCapacityConfig {
  pools: PoolConfig[];
}

/**
 * One entry in the append-only history of an AutonomyState change. A demotion is
 * itself a record returning a class to human-gated, so history is reconstructable
 * and a reversal is visible. `recordedAt` is passed in (no clock read here).
 */
export interface WideningRecord {
  deploymentId: string;
  riskClass: RiskClass;
  /** The lane this grant is scoped to; absent for a LEVEL-WIDE grant. */
  lane?: string;
  prior: AutonomyLevel;
  next: AutonomyLevel;
  authorization: AutonomyAuthorization;
  recordedAt: number;
}

/**
 * The one mutable slice of a deployment's profile: autonomy. A grant is either
 * LEVEL-WIDE (keyed by risk class in `entries`) or LANE-SPECIFIC (keyed by lane
 * then risk class in `laneEntries`) — FUNC-AC-MERGE-DECISION grants autonomy "for
 * a given risk level OR lane". A (class, lane) is effectively widened when the
 * level-wide entry OR the lane-specific entry is widened. Default is human-gated.
 * `history` is the append-only WideningRecord log.
 */
export interface AutonomyState {
  entries: Partial<Record<RiskClass, AutonomyLevel>>;
  laneEntries?: Record<string, Partial<Record<RiskClass, AutonomyLevel>>>;
  history: WideningRecord[];
}

/** A read of one class's autonomy, with the authorization on record (if any). */
export interface AutonomyReading {
  riskClass: RiskClass;
  /** The lane scope this reading was resolved for, if a lane was supplied. */
  lane?: string;
  level: AutonomyLevel;
  authorization?: AutonomyAuthorization;
}

/**
 * Result of parsing + validating one profile at activation. Never a partial
 * accept: either an accepted frozen profile or a rejection naming every offender.
 */
export type RegistrationOutcome =
  | { ok: true; profile: Readonly<DeploymentProfile> }
  | { ok: false; offenders: string[] };

/** Result of parsing + validating the fleet capacity config. */
export type FleetCapacityOutcome =
  | { ok: true; fleet: Readonly<FleetCapacityConfig> }
  | { ok: false; offenders: string[] };

/**
 * Result of a write op that may fail on an unknown deployment/class or missing
 * authorization. Mirrors RegistrationOutcome's fail-closed discriminated union;
 * `reason` carries the offending detail (the op mutates nothing on failure).
 */
export type WideningOutcome =
  | { ok: true; state: Readonly<AutonomyState> }
  | { ok: false; reason: string };

/**
 * Lookups never throw: an unknown / inactive id resolves to a tagged not-found.
 * The caller treats a not-found as a hard stop (there are no platform defaults).
 */
export type LookupResult =
  | { kind: 'found'; profile: Readonly<DeploymentProfile> }
  | { kind: 'not-found'; deploymentId: string };

/**
 * The exact input shape the Lane Engine's assign + evaluate-eligibility ops read.
 * `mode` is the stored lifecycleMode string — the registry serves it; the lane
 * engine resolves it.
 */
export interface LaneEngineInputs {
  laneSet: LaneSet;
  riskPathMap: RiskPathMap;
  defaultMinLevel: RiskLevel;
  mode: string;
}

/** resolveLaneEngineInputs / resolveCapacityPoolInputs may fail on a bad id. */
export type LaneEngineInputsResult =
  | { kind: 'found'; inputs: Readonly<LaneEngineInputs> }
  | { kind: 'not-found'; deploymentId: string };

/**
 * The fleet-level capacity inputs the Window Scheduler reads: the pool set and
 * its preference order. Fleet-level — no deployment id. `not-configured` when no
 * fleet capacity has been set yet.
 */
export type CapacityPoolInputsResult =
  | { kind: 'found'; pools: PoolConfig[] }
  | { kind: 'not-configured' };

/** Which declared datum readDeclaredData serves. */
export type DeclaredDatum =
  | 'complianceReviewers'
  // The OPTIONAL recorded compliance VERDICTS (FUNC-AC-COMPLIANCE-GATE). Read the
  // same way as complianceReviewers — value is ComplianceReviewVerdict[] | undefined
  // (undefined ⇒ the merge-decision lens falls back to path-condition matching).
  | 'complianceVerdicts'
  | 'honestAutomation'
  | 'budget'
  | 'landing'
  | 'capabilityBindings'
  // The OPTIONAL gate-set DEFINITIONS (XCUT P2#1). The integrate handler reads this
  // the same way it reads complianceReviewers — value is GateSetDefinitions | undefined
  // (undefined ⇒ the lane-specific verdict feature is inert).
  | 'gateSets';

/** Read of a declared datum; tagged not-found rather than a throw on a bad id. */
export type DeclaredDataResult =
  | { kind: 'found'; which: DeclaredDatum; value: unknown }
  | { kind: 'not-found'; deploymentId: string };

/** The grant payload the pure widening update consumes (timestamp passed by caller). */
export interface WideningGrant {
  deploymentId: string;
  riskClass: RiskClass;
  target: AutonomyLevel;
  authorization: AutonomyAuthorization;
}
