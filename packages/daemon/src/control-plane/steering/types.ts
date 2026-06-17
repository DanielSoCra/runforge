// packages/daemon/src/control-plane/steering/types.ts
//
// Steering-Role Registry & Deciders — types (STACK-AC-STEERING / L3).
//
// The data model + the fail-closed result unions. No logic. Mirrors the
// deployment-registry's "declare → validate → freeze → lookup" shape applied to
// standing judgment-role declarations, plus the two pure deciders' outcome unions.
// Every decision is a tagged union whose cautious arm carries a cause; a role is
// rejected WHOLE (offenders[]), never partially applied (the L2 fail-closed rule).

/**
 * The cadence on which a role wakes, declared as DATA — never a free-form string.
 * A discriminated union so the wake decider exhausts it with a `never` default
 * (a future rhythm kind without a decider arm is a compile error, not a silent
 * "not due"). `everyMs` is a positive int; `expr` is a non-empty cron string —
 * both validated at parse time, never a runtime surprise inside the decider.
 */
export type WakeRhythm =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'cron'; expr: string };

/**
 * One standing role's declaration, read from the deployment's active config pack
 * and frozen for the life of that activation, keyed by a unique `id`. The data
 * that replaces today's hard-coded product-ownership / technical-leadership
 * modules. The mechanism validates SHAPE, not values — it never judges whether a
 * charter is wise, a budget sufficient, or a rhythm appropriate.
 */
export interface SteeringRole {
  /** The unique role id — the attribution key. */
  id: string;
  /** What the role is, as declared text. */
  charter: string;
  /** The standing brief the role operates under, as declared text. */
  instructions: string;
  /** The persona the role speaks with, carried into its wakings. */
  voice: string;
  /** Capabilities/tools the role's wakings may use, named as data. */
  capabilityGrant: string[];
  /** Knowledge sources the role may consult, named as data. */
  referenceKnowledge: string[];
  /** Structured paths this role may dispatch into, named as data. */
  routingGrant: string[];
  /** The cadence on which the role wakes (the data the wake decision reads). */
  wakeRhythm: WakeRhythm;
  /** The spend cap a single waking may consume (the cost layer does the accounting). */
  perWakingBudget: number;
}

/**
 * Identifies one frozen state of a SteeringRole declaration — the attribution
 * anchor. Editing a declaration produces a NEW RoleVersion; the prior remains
 * identifiable for records that ran under it. No waking is recorded without one.
 * `activatedAt` is passed in by the caller (no clock read in this module).
 */
export interface RoleVersion {
  roleId: string;
  version: number;
  activatedAt: number;
  digest: string;
}

/**
 * The durable record of one wake-to-sleep cycle of a role. Pins the RoleVersion
 * it opened under for its WHOLE life — a later re-registration must not retro-
 * stamp it (the in-flight pin). Every steering action belongs to exactly one
 * Waking, and every Waking names exactly one RoleVersion.
 */
export interface Waking {
  id: string;
  roleId: string;
  version: RoleVersion;
  /**
   * The frozen role declaration PINNED at open. Authorization (route's grant
   * check) reads THIS, never the registry's current role — a re-registration that
   * bumps the version mid-waking must not retro-change an in-flight waking's grants.
   */
  role: SteeringRole;
  openedAt: number;
  closedAt?: number;
}

/**
 * A snapshot of the state the wake decider reads — passed in by the Control
 * Plane's timer. `now` is the current-time snapshot; `lastWakingAt` is the
 * role's last-waking marker (absent on a first-ever wake). No live clock.
 */
export interface WakeSnapshot {
  now: number;
  lastWakingAt?: number;
}

/**
 * The pure wake decision: due (the rhythm has elapsed) or not-due, each with the
 * reason. A wake that cannot be evaluated maps to the most cautious treatment
 * (it does not fire). Pure over the rhythm declaration + the snapshot.
 */
export type WakeDecision =
  | { kind: 'due'; reason: string }
  | { kind: 'not-due'; reason: string };

/**
 * The pure spend decision for one step within a waking: proceed within budget,
 * or `conclude-and-record` when the running spend has reached the declared
 * budget. The over-budget arm ends the waking CLEANLY — never overspends, never
 * errors. The cost layer reports the running spend; this module performs no
 * accounting itself.
 */
export type SpendVerdict =
  | { kind: 'proceed' }
  | { kind: 'conclude-and-record'; reason: string };

/**
 * One recorded hop a waking emits to move a fuzzy input into a structured path —
 * the ONLY way a steering role's judgment leaves the role (there is no private
 * channel). A consult to another role and an Operator proposal are BOTH
 * RouteRequests, distinguished only by their `target` path.
 */
export interface RouteRequest {
  wakingId: string;
  version: RoleVersion;
  target: string;
  artifactRef: string;
}

/**
 * Result of a route: recorded (target was within the routing grant) or rejected
 * (target outside the grant). The mechanism records and hands off — it NEVER
 * executes the structured workflow. The rejection is itself recorded against the
 * waking (an ungranted target is not a silent no-op).
 */
export type RouteResult =
  | { kind: 'recorded'; request: RouteRequest }
  | { kind: 'rejected'; reason: string };

/**
 * Result of parsing + validating one role declaration at activation. Never a
 * partial accept: either an accepted frozen role with its RoleVersion, or a
 * rejection carrying the full list of offending fields and why each failed.
 */
export type RegistrationOutcome =
  | { ok: true; role: Readonly<SteeringRole>; version: RoleVersion }
  | { ok: false; offenders: string[] };

/**
 * Lookups never throw: an unknown / inactive role id resolves to a tagged
 * not-found. The caller treats a not-found as a hard stop (there is no
 * platform-level default steering role to fall back on).
 */
export type LookupResult =
  | { kind: 'found'; role: Readonly<SteeringRole>; version: RoleVersion }
  | { kind: 'not-found'; roleId: string };
