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

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
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

/**
 * Persistence backend for per-deployment autonomy state. Implementations are
 * fail-soft on read (an unreadable/absent/invalid store returns `{}`) and
 * atomic on write so a crash mid-save never leaves a corrupt file.
 */
export interface AutonomyStore {
  loadAll(): Record<string, AutonomyState>;
  saveAll(map: Record<string, AutonomyState>): void;
}

/**
 * A JSON-file AutonomyStore. Writes are atomic (temp file + rename) and the
 * parent directory is created on demand. No external dependencies.
 */
export class JsonFileAutonomyStore implements AutonomyStore {
  constructor(private path: string) {}

  loadAll(): Record<string, AutonomyState> {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return {};
      }
      return parsed as Record<string, AutonomyState>;
    } catch {
      return {};
    }
  }

  saveAll(map: Record<string, AutonomyState>): void {
    const tmp = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}

/** Constructor options: either the legacy fleet-capacity seed or an options bag. */
export type DeploymentRegistryOptions =
  | Readonly<FleetCapacityConfig>
  | {
      autonomyStore?: AutonomyStore;
      fleetCapacity?: Readonly<FleetCapacityConfig>;
    };

export class DeploymentRegistry {
  private profiles = new Map<string, Readonly<DeploymentProfile>>();
  private fleetCapacity: Readonly<FleetCapacityConfig> | undefined;
  private autonomyStore: AutonomyStore | undefined;
  private autonomy: Map<string, AutonomyState>;

  /**
   * @param options either the legacy fleet-capacity seed (backward compatible
   *        with registry.test.ts / regressions.test.ts) or an options bag with
   *        an optional AutonomyStore and optional fleet capacity. Capacity pools
   *        are fleet-level, set ONCE — not copied per profile.
   */
  constructor(options?: DeploymentRegistryOptions) {
    let fleetCapacity: Readonly<FleetCapacityConfig> | undefined;
    if (options !== undefined && 'pools' in options) {
      fleetCapacity = options;
    } else if (options !== undefined) {
      fleetCapacity = options.fleetCapacity;
      this.autonomyStore = options.autonomyStore;
    }

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

    // Load any persisted autonomy state. A missing/broken store returns `{}`,
    // so the registry is always bootable even if the autonomy file is corrupt.
    this.autonomy = new Map(
      Object.entries(this.autonomyStore?.loadAll() ?? {}),
    );
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
  readAutonomyState(id: string, riskClass?: RiskClass, lane?: string): AutonomyReading[] {
    const state = this.autonomy.get(id);
    if (state === undefined) {
      return [];
    }

    const classes = riskClass === undefined ? RISK_CLASSES : [riskClass];
    return classes.map((rc) => {
      // Effective autonomy for (class, lane): widened if the LEVEL-WIDE grant OR
      // (when a lane is supplied) the LANE-SPECIFIC grant is widened. Without a
      // lane this reduces to the level-wide reading (backward compatible).
      const laneVal = lane !== undefined ? state.laneEntries?.[lane]?.[rc] : undefined;
      const levelWide = state.entries[rc] ?? 'human-gated';
      const laneSpecific = laneVal ?? 'human-gated';
      const level: AutonomyLevel =
        levelWide === 'widened' || laneSpecific === 'widened' ? 'widened' : 'human-gated';
      // Attribute to the scope that determined the reading (lane-specific takes
      // precedence when widened; an explicit lane entry owns a human-gated read).
      const scopeLane =
        level === 'widened'
          ? laneSpecific === 'widened'
            ? lane
            : undefined
          : laneVal !== undefined
            ? lane
            : undefined;
      const record = this.findAuthorizingRecord(state.history, rc, level, scopeLane);
      return {
        riskClass: rc,
        ...(lane !== undefined ? { lane } : {}),
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
    lane?: string,
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

    // A lane-scoped grant must name a lane DECLARED in this deployment's lane set.
    // Otherwise a typo'd/stale lane records as ok but is never effective (integrate
    // queries autonomy with the profile's real lane name), and pollutes the history.
    if (lane !== undefined) {
      const profile = this.profiles.get(id);
      const declared = profile?.laneSet.lanes.some((l) => l.name === lane) === true;
      if (declared === false) {
        return { ok: false, reason: `unknown lane '${lane}' for deployment '${id}'` };
      }
    }

    // A LANE-SPECIFIC grant (lane given) updates laneEntries[lane][riskClass] and
    // leaves the level-wide entries untouched; a LEVEL-WIDE grant (no lane) updates
    // entries[riskClass]. The record carries the lane for attribution.
    let newState: AutonomyState;
    if (lane !== undefined) {
      const prior = state.laneEntries?.[lane]?.[riskClass] ?? 'human-gated';
      newState = {
        entries: { ...state.entries },
        laneEntries: {
          ...state.laneEntries,
          [lane]: { ...(state.laneEntries?.[lane] ?? {}), [riskClass]: target },
        },
        history: [
          ...state.history,
          { deploymentId: id, riskClass, lane, prior, next: target, authorization, recordedAt: now },
        ],
      };
    } else {
      const prior = state.entries[riskClass] ?? 'human-gated';
      // A level-wide DEMOTION re-gates the class EVERYWHERE — it must also clear any
      // lane-specific widenings for that class. Otherwise readAutonomyState's
      // (level-wide OR lane-specific) would leave a lane still reading `widened`, and
      // a demote-on-red / operator reversal would silently fail to re-gate it.
      // Per-lane revocation records: each lane grant the demotion clears gets its
      // OWN append-only record (its true prior + lane), so demote-on-red stays fully
      // reconstructable from history — not just the single level-wide record below.
      const revocations: WideningRecord[] = [];
      let laneEntries = state.laneEntries;
      if (target === 'human-gated' && laneEntries !== undefined) {
        const cleared: Record<string, Partial<Record<RiskClass, AutonomyLevel>>> = {};
        for (const [ln, classes] of Object.entries(laneEntries)) {
          const kept: Partial<Record<RiskClass, AutonomyLevel>> = {};
          for (const [c, lvl] of Object.entries(classes)) {
            if (c !== riskClass) {
              kept[c as RiskClass] = lvl;
            } else if (lvl !== 'human-gated') {
              revocations.push({
                deploymentId: id,
                riskClass,
                lane: ln,
                prior: lvl,
                next: 'human-gated',
                authorization,
                recordedAt: now,
              });
            }
          }
          cleared[ln] = kept;
        }
        laneEntries = cleared;
      } else if (laneEntries !== undefined) {
        laneEntries = { ...laneEntries };
      }
      newState = {
        entries: { ...state.entries, [riskClass]: target },
        ...(laneEntries !== undefined ? { laneEntries } : {}),
        history: [
          ...state.history,
          ...revocations,
          { deploymentId: id, riskClass, prior, next: target, authorization, recordedAt: now },
        ],
      };
    }

    // Deep-freeze before storing AND returning (`Readonly` is compile-time only;
    // an un-frozen handle would let a caller bypass the authorization + history path).
    const frozen = deepFreeze(newState);
    this.autonomy.set(id, frozen);
    this.autonomyStore?.saveAll(Object.fromEntries(this.autonomy));
    return { ok: true, state: frozen };
  }

  /**
   * Read one declared datum (compliance reviewers, honest-automation map, budget,
   * landing target / production-release path, capability bindings, or the optional
   * gate-set definitions) from the frozen profile. Read-only; tagged not-found on
   * an unknown id. An absent optional datum (e.g. gateSets) resolves to a `found`
   * read with `value: undefined`.
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
    scopeLane?: string,
  ): WideningRecord | undefined {
    // Match the SCOPE that determined the reading: a lane-specific reading attributes
    // to a record with that lane; a level-wide reading attributes to a record with no
    // lane. (record.lane === scopeLane: both undefined for level-wide, both the lane
    // for lane-specific.) Keeps the audit trail accurate across scopes.
    for (let i = history.length - 1; i >= 0; i--) {
      const record = history[i];
      if (
        record !== undefined &&
        record.riskClass === riskClass &&
        record.next === level &&
        record.lane === scopeLane
      ) {
        return record;
      }
    }
    return undefined;
  }
}

/**
 * Factory mirror of the lane-engine/window-scheduler convention. The fleet
 * capacity and/or an AutonomyStore may be supplied here or set later via
 * setFleetCapacity.
 */
export function createDeploymentRegistry(
  options?: {
    fleetCapacity?: Readonly<FleetCapacityConfig>;
    autonomyStore?: AutonomyStore;
  },
): DeploymentRegistry {
  return new DeploymentRegistry(options);
}
