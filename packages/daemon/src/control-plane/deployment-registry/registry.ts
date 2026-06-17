// packages/daemon/src/control-plane/deployment-registry/registry.ts
//
// Deployment-Profile Registry — the in-memory record (STACK-AC-DEPLOYMENT-REGISTRY).
//
// Pure lookups + one pure mutation in the middle; I/O (config load, DB persist)
// at the edges. The registry is the config source the deciders read — it assigns
// no lane, ranks no pool, applies no floor. Bodies are STUBBED to throw
// 'not implemented'; the implementer (Kimi) fills them to satisfy the immovable
// acceptance tests in registry.test.ts / autonomy.test.ts.
//
// Fail-closed discriminated-union outcomes — never throw on a config/policy
// question (lookups → tagged not-found; widening → { ok:false; reason }).
// Exceptions are reserved for programmer error.

import type {
  RegistrationOutcome,
  LookupResult,
  LaneEngineInputsResult,
  CapacityPoolInputsResult,
  FleetCapacityOutcome,
  FleetCapacityConfig,
  AutonomyReading,
  WideningOutcome,
  AutonomyAuthorization,
  AutonomyLevel,
  RiskClass,
  DeclaredDatum,
  DeclaredDataResult,
  DeploymentProfile,
  AutonomyState,
  WideningRecord,
} from './types.js';
import { parseProfile, parseFleetCapacity, deepFreeze } from './schema.js';

/**
 * The Deployment Registry: holds per-deployment frozen profiles keyed by id, the
 * single fleet-level capacity config, and the per-deployment autonomy state +
 * widening history. The cross-deployment one-owner-per-repository invariant lives
 * in `register` (the schema cannot see other profiles).
 */
const RISK_CLASSES: RiskClass[] = ['green', 'yellow', 'orange', 'red'];

function repoKey(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}

function isValidAuthorization(auth: AutonomyAuthorization): boolean {
  if (auth.kind === 'operator-grant') {
    return auth.operator.length > 0;
  }
  if (auth.kind === 'earn-in-policy') {
    return auth.policyRef.length > 0;
  }
  return false;
}

function emptyAutonomyState(): AutonomyState {
  return { entries: {}, history: [] };
}

export class DeploymentRegistry {
  private profiles = new Map<string, Readonly<DeploymentProfile>>();
  private fleetCapacity: Readonly<FleetCapacityConfig> | undefined;
  private autonomy = new Map<string, AutonomyState>();

  /**
   * @param fleetCapacity optional initial fleet capacity (else set via setFleetCapacity).
   *        Capacity pools are a fleet-level record, set ONCE — not copied per profile.
   */
  constructor(fleetCapacity?: Readonly<FleetCapacityConfig>) {
    if (fleetCapacity !== undefined) {
      // Validate through the SAME parser as setFleetCapacity — the one-provider-
      // one-pool invariant is not encoded in the type, so a type-valid-but-
      // invariant-violating config must not be frozen and served as valid. A
      // constructor has no outcome channel, so an invalid seed is a programmer
      // error (bypassing setFleetCapacity) and throws rather than failing open.
      const outcome = parseFleetCapacity(fleetCapacity.pools);
      if (!outcome.ok) {
        throw new Error(
          `invalid fleet capacity passed to constructor: ${outcome.offenders.join('; ')}`,
        );
      }
      this.fleetCapacity = outcome.fleet;
    }
  }

  /**
   * Set / replace the single fleet-level capacity config. Parsed + validated via
   * parseFleetCapacity (one-provider-one-pool); rejected whole on any offender.
   * Fleet-level — independent of any deployment.
   */
  setFleetCapacity(raw: unknown): FleetCapacityOutcome {
    const outcome = parseFleetCapacity(raw);
    if (outcome.ok) {
      this.fleetCapacity = outcome.fleet;
    }
    return outcome;
  }

  /**
   * Parse + validate + freeze + store one deployment's profile, keyed by id.
   * Atomic and fail-closed: any structural error (unknown key, malformed lane
   * set, risk-path entry naming an unknown level, missing defaultMinLevel,
   * lifecycle mode naming an undeclared phase, a repository already owned by
   * another active deployment) rejects the whole profile naming every offender,
   * and NOTHING is stored. On a re-register, the prior profile stays active on
   * rejection.
   */
  register(id: string, rawProfile: unknown): RegistrationOutcome {
    const parsed = parseProfile(id, rawProfile);
    if (!parsed.ok) {
      return parsed;
    }

    const profile = parsed.profile;
    const ownershipOffenders: string[] = [];
    for (const repo of profile.repositories) {
      const key = repoKey(repo);
      for (const [otherId, otherProfile] of this.profiles) {
        if (otherId === id) continue;
        if (otherProfile.repositories.some((r) => repoKey(r) === key)) {
          ownershipOffenders.push(
            `repository ${key} is already owned by deployment '${otherId}'`,
          );
        }
      }
    }

    if (ownershipOffenders.length > 0) {
      return { ok: false, offenders: ownershipOffenders };
    }

    this.profiles.set(id, profile);
    if (!this.autonomy.has(id)) {
      this.autonomy.set(id, emptyAutonomyState());
    }
    return { ok: true, profile };
  }

  /** Look up the frozen profile by id, or tagged not-found (never throws). */
  lookup(id: string): LookupResult {
    const profile = this.profiles.get(id);
    if (profile === undefined) {
      return { kind: 'not-found', deploymentId: id };
    }
    return { kind: 'found', profile };
  }

  /**
   * Whether the deployment `id`'s profile OWNS the given repository. The live
   * merge seam uses this to refuse applying one deployment's lane/risk/autonomy
   * profile to a repo it does not own (the deployment→repository ownership
   * invariant, enforced at the decision point). Unknown id → false (never throws).
   */
  ownsRepo(id: string, owner: string, repo: string): boolean {
    const profile = this.profiles.get(id);
    if (profile === undefined) {
      return false;
    }
    return profile.repositories.some((r) => r.owner === owner && r.name === repo);
  }

  /**
   * Resolve exactly the inputs the Lane Engine reads: { laneSet, riskPathMap,
   * defaultMinLevel, mode } — verbatim from the frozen profile, deciding nothing.
   * Tagged not-found on an unknown id.
   */
  resolveLaneEngineInputs(id: string): LaneEngineInputsResult {
    const result = this.lookup(id);
    if (result.kind === 'not-found') {
      return result;
    }
    const profile = result.profile;
    return {
      kind: 'found',
      inputs: {
        laneSet: profile.laneSet,
        riskPathMap: profile.riskPathMap,
        defaultMinLevel: profile.defaultMinLevel,
        mode: profile.lifecycleMode,
      },
    };
  }

  /**
   * Resolve the fleet-level capacity inputs the Window Scheduler reads: the pool
   * set + preference order. Takes NO id (fleet-level) — same result regardless of
   * any deployment. `not-configured` if no fleet capacity has been set.
   */
  resolveCapacityPoolInputs(): CapacityPoolInputsResult {
    if (this.fleetCapacity === undefined) {
      return { kind: 'not-configured' };
    }
    return { kind: 'found', pools: this.fleetCapacity.pools };
  }

  /**
   * Read autonomy state for one deployment. With a riskClass, returns that one
   * class's reading; without, returns every class. Default (no recorded widening)
   * is human-gated. Read-only. Tagged not-found is surfaced via an empty/throw-free
   * path — see types; an unknown deployment yields an empty result, not a throw.
   */
  readAutonomyState(id: string, riskClass?: RiskClass): AutonomyReading[] {
    const state = this.autonomy.get(id);
    if (state === undefined) {
      return [];
    }

    const classes = riskClass === undefined ? RISK_CLASSES : [riskClass];
    return classes.map((rc) => {
      const level = state.entries[rc] ?? 'human-gated';
      const record = this.findAuthorizingRecord(state.history, rc, level);
      return {
        riskClass: rc,
        level,
        authorization: record?.authorization,
      };
    });
  }

  /**
   * Record an autonomy widening (or demotion) for exactly one (deployment, risk
   * class) entry, appending a WideningRecord (prior state, new state,
   * authorization, timestamp passed in). Touches no other entry and no other
   * deployment. An unknown deployment/class or missing authorization is rejected
   * ({ ok:false; reason }) and mutates nothing. `now` is passed in — no clock read.
   */
  recordWidening(
    id: string,
    riskClass: RiskClass,
    target: AutonomyLevel,
    authorization: AutonomyAuthorization,
    now: number,
  ): WideningOutcome {
    if (!RISK_CLASSES.includes(riskClass)) {
      return { ok: false, reason: `unknown risk class '${riskClass}'` };
    }
    if (!isValidAuthorization(authorization)) {
      return { ok: false, reason: 'missing authorization' };
    }

    const state = this.autonomy.get(id);
    if (state === undefined) {
      return { ok: false, reason: `unknown deployment '${id}'` };
    }

    const prior = state.entries[riskClass] ?? 'human-gated';
    const record: WideningRecord = {
      deploymentId: id,
      riskClass,
      prior,
      next: target,
      authorization,
      recordedAt: now,
    };

    // Deep-freeze the new state before storing AND returning it: `Readonly` is
    // compile-time only, so an un-frozen returned object would let a caller mutate
    // entries/history directly and bypass the authorization + history path that is
    // the whole point of this method. (Subsequent widenings spread these frozen
    // collections into fresh mutable copies, so freezing here is safe.)
    const newState: AutonomyState = deepFreeze({
      entries: { ...state.entries, [riskClass]: target },
      history: [...state.history, record],
    });

    this.autonomy.set(id, newState);
    return { ok: true, state: newState };
  }

  /**
   * Read one declared datum (compliance reviewers, honest-automation map, budget,
   * landing target / production-release path, or capability bindings) from the
   * frozen profile. Read-only; tagged not-found on an unknown id.
   */
  readDeclaredData(id: string, which: DeclaredDatum): DeclaredDataResult {
    const result = this.lookup(id);
    if (result.kind === 'not-found') {
      return result;
    }
    return { kind: 'found', which, value: result.profile[which] };
  }

  private findAuthorizingRecord(
    history: WideningRecord[],
    riskClass: RiskClass,
    level: AutonomyLevel,
  ): WideningRecord | undefined {
    for (let i = history.length - 1; i >= 0; i--) {
      const record = history[i];
      if (record !== undefined && record.riskClass === riskClass && record.next === level) {
        return record;
      }
    }
    return undefined;
  }
}

/**
 * Factory mirror of the lane-engine/window-scheduler convention. The fleet
 * capacity may be supplied here or set later via setFleetCapacity.
 */
export function createDeploymentRegistry(
  fleetCapacity?: Readonly<FleetCapacityConfig>,
): DeploymentRegistry {
  return new DeploymentRegistry(fleetCapacity);
}
