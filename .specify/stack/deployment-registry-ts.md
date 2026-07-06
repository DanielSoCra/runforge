---
id: STACK-AC-DEPLOYMENT-REGISTRY
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-DEPLOYMENT-REGISTRY
code_paths: []  # DEFERRED to implementation — path-existence validator requires real files (cf. STACK-AC-WINDOW-SCHEDULER)
test_paths: []  # DEFERRED to implementation — same reason
---

# STACK-AC-DEPLOYMENT-REGISTRY — Deployment-Profile Registry (TypeScript)

## Pattern

**Parse-validate-freeze at the edge, pure lookups + one pure mutation in the middle — composing the siblings' own parsers, never re-declaring their shapes.** A profile arrives as already-loaded config data (from `loadConfig`'s seam, not a parallel loader); the registry parses it once with a zod `.strict()` schema, runs cross-field and cross-deployment validation, deep-freezes the survivor, and stores it in an in-memory map keyed by deployment id. This mirrors the lane-engine idiom exactly: I/O at the edges (config load, Postgres persistence), decisions in pure, exhaustively-testable functions. The registry is the *config source* the deciders read — it assigns no lane, ranks no pool, applies no floor.

The defining constraint is **composition, not re-declaration.** The profile's `laneSet` field is validated by calling the lane engine's own `parseLaneSet(raw)` and the result is the lane engine's own frozen `LaneSet` — verbatim, the same object the engine consumes. The `fleetCapacity` pool set is validated by the window scheduler's own `PoolConfigSchema` + `validatePoolMembership`, yielding `PoolConfig[]`. The registry owns only the *envelope* schema (the fields the siblings don't define: repositories, lifecycle mode, declared data, autonomy state) and the *cross-record* invariants the siblings can't see (deployment→repository one-owner across all active profiles).

**Fail-closed discriminated-union outcomes — never throw on a policy/config question.** `RegistrationOutcome = { ok: true; profile } | { ok: false; offenders }`; lookups return a tagged `not-found`; `record-autonomy-widening` returns `{ ok: false; reason }` on an unknown deployment/class or missing authorization. A malformed profile is rejected *whole*, naming every offender — never silently repaired, never partially applied. Exceptions are reserved for programmer error (e.g. calling a resolve op for an id the caller never registered), exactly as in the lane engine and window scheduler.

## Key Decisions

**Module layout: a `control-plane/deployment-registry/` sibling dir, pure-module split mirroring `lane-engine/`.**

| File | Responsibility |
|---|---|
| `types.ts` | `DeploymentProfile`, `FleetCapacityConfig`, `AutonomyState`, `WideningRecord`, `RegistrationOutcome`, the resolve-input shapes — re-exporting the lane-engine `LaneSet`/`RiskPathMap` and window-scheduler `PoolConfig` rather than redefining them. |
| `schema.ts` | The envelope `.strict()` zod schemas + `parseProfile(raw)` / `parseFleetCapacity(raw)` that compose `parseLaneSet` and `PoolConfigSchema`/`validatePoolMembership`, deep-freeze on success, and the deep-freeze helper. |
| `registry.ts` | The in-memory registry object: `register`, `lookup`, the four resolve/read ops, `recordWidening` (the one pure-update + persist seam), and the cross-deployment one-owner invariant across active profiles. |
| `index.ts` | Public surface (mirrors `lane-engine/index.ts`): `export * from './types.js'` + named exports of the parse/registry functions. |

DB persistence (profiles + autonomy state survive restart) is the I/O edge `registry.ts` calls out to — never inside the parse or pure-update functions.

**Schema composition — what is reused vs. newly defined.** Reused verbatim: the lane engine's `parseLaneSet` (returns `ParseLaneSetResult` → the frozen `LaneSet`, incl. its own duplicate-name / overlap / mode-coverage checks); its `RiskPathMap`/`RiskLevel`/`ModeResolution` types; the window scheduler's `PoolConfigSchema` (per-pool shape) and `validatePoolMembership` (the cross-pool one-provider-one-pool invariant). Newly defined here: the envelope schema for `repositories`, `riskPathMap` + `defaultMinLevel` (a thin `.strict()` schema over `RiskPathEntry[]` + `RiskLevel`, since the lane engine only *consumes* these, never parses them), `lifecycleMode`, and the declared-data blocks (compliance reviewer set, honest-automation map, budget, landing target / production-release path, capability-version bindings). The registry never re-declares a lane or pool field.

**`RiskLevel` is the lane engine's enum, reused for both the map and the default-minimum.** The L2 says the risk-path map and default minimum are "exactly the `RiskPathMap` plus default-minimum pair the Lane Engine consumes." So the envelope schema validates each entry's `minLevel` and the `defaultMinLevel` against the same four-level set, and emits `RiskPathMap` + `RiskLevel` directly — no second risk vocabulary.

**Cross-deployment one-owner invariant lives in `registry.register`, not the schema.** `PoolConfigSchema` validates one pool; `validatePoolMembership` validates across pools. By analogy, the per-profile schema validates one profile's shape; the deployment→repository one-owner check runs in `register` against *every other currently-active profile* (the schema can't see them). A repository already owned by another active deployment is an offender naming the contested repo and the owning deployment. The `FleetCapacityConfig` is validated once via `validatePoolMembership` (it is fleet-level, parsed independently of any one profile).

**`AutonomyState` is the one mutable slice — a pure update returning new state, timestamp passed in.** Default (no widening recorded) is fully human-gated. `recordWidening(state, { deploymentId, riskClass, target, authorization, at })` returns a *new* `AutonomyState` with exactly one `(deployment, riskClass)` entry changed and a `WideningRecord` appended — touching no other entry and no other deployment. No `Date.now()` inside: the timestamp is a parameter (the window-scheduler / lane-engine `observedAt`/`now`-passed-in idiom). The persist-to-DB step wraps the pure update at the edge and fails closed: the widening is not reported applied until the new state + record are durably written.

**Resolve ops return exactly the sibling input shapes — id-keyed for the lane engine, id-less for capacity.** `resolveLaneEngineInputs(id)` returns `{ laneSet, riskPathMap, defaultMinLevel, mode }` — verbatim the inputs `resolveForMode` + `evaluateMergeEligibility` need (note: `mode` is the stored `lifecycleMode` string; the lane engine resolves it, the registry only serves it). `resolveCapacityPoolInputs()` takes **no id** (the pool config is fleet-level) and returns the `PoolConfig[]` + preference order the window scheduler reads. Both pull verbatim from frozen state and decide nothing.

## Examples

```typescript
// Compose the siblings' parsers — do not re-declare LaneSet/PoolConfig.
function parseProfile(id: string, raw: unknown): RegistrationOutcome {
  const env = ProfileEnvelopeSchema.safeParse(raw);          // .strict() envelope only
  if (!env.success) return { ok: false, offenders: zodOffenders(env.error) };
  const lanes = parseLaneSet(env.data.laneSet);              // lane engine's own parser + freeze
  if (!lanes.ok) return { ok: false, offenders: lanes.errors };
  return freezeProfile({ id, ...env.data, laneSet: lanes.laneSet });
}
```

```typescript
// Fleet capacity reuses the window scheduler's per-pool schema + cross-pool invariant.
function parseFleetCapacity(raw: unknown): FleetCapacityOutcome {
  const pools = z.array(PoolConfigSchema).safeParse(raw);
  if (!pools.success) return { ok: false, offenders: zodOffenders(pools.error) };
  const membership = validatePoolMembership(pools.data);     // one-provider-one-pool
  if (!membership.ok) return { ok: false, offenders: membership.offenders };
  return { ok: true, fleet: deepFreeze({ pools: pools.data }) };
}
```

```typescript
// The ONE mutation: pure, isolated, timestamp passed in, append-only history.
function recordWidening(state: AutonomyState, w: WideningGrant, at: number): AutonomyState {
  const prior = state.entries[w.riskClass] ?? HUMAN_GATED;
  return {                                                   // new object — never mutate `state`
    entries: { ...state.entries, [w.riskClass]: w.target },
    history: [...state.history, { ...w, prior, recordedAt: at }],
  };
}
```

```typescript
type RegistrationOutcome =
  | { ok: true; profile: Readonly<DeploymentProfile> }
  | { ok: false; offenders: string[] };   // every offending field, never a partial accept
```

## Gotchas

- **Compose `parseLaneSet` / `PoolConfigSchema`+`validatePoolMembership` — never re-declare a lane or pool field.** The siblings own those shapes and their invariants (lane name uniqueness, qualification overlap, mode coverage; one-provider-one-pool). Re-typing them here forks the contract and drifts. The registry's schema covers only the envelope and the cross-*deployment* invariant the siblings structurally cannot see.
- **Reject whole, name every offender — flatten the composed parsers' messages into one `offenders[]`.** Three sub-validators (envelope zod, `parseLaneSet`, `validatePoolMembership`) each produce messages; merge them so a profile with a bad lane *and* a stolen repo names both. Never short-circuit on the first failure into a partial accept.
- **A typo'd key fails activation — never silently stripped.** Every envelope object is `.strict()` (the lane-engine / window-scheduler precedent). `repositorys: [...]` must reject, not collapse to an empty default.
- **Deep-freeze the accepted profile *and* the nested LaneSet/pools.** `parseLaneSet` already freezes the lane set, but the envelope wrapper around it is new — freeze the whole graph so a consumer that mutates `profile.repositories` or `profile.riskPathMap` throws rather than corrupting shared state. Use the lane-engine `deepFreeze` precedent (recurse then `Object.freeze`).
- **No `Date.now()` in the pure update.** `recordWidening` takes the timestamp as a parameter; the caller (the Control Plane edge) supplies wall-clock — exactly the window-scheduler `observedAt` / lane-engine passed-in-`now` rule. A pure function reading a clock is untestable and non-deterministic.
- **A widening for an unknown deployment/class, or without authorization, mutates nothing.** Return the fail arm before constructing new state; an unauthorized or malformed grant is a no-op, and cross-deployment isolation holds — a request naming deployment A can never touch B's entries.
- **Persistence fails closed for widenings; the pure update is not "applied" until durably written.** The pure function returns new state in memory, but `register`/`recordWidening`'s edge must persist the `WideningRecord` + new entry before reporting success — an unrecorded widening is neither reversible nor explainable (L2 error-handling rule).
- **Lookup miss is a hard stop, not a default.** `lookup`/resolve for an unknown or inactive id returns the tagged `not-found`; there are no platform-level project defaults to fall back to — the caller halts that deployment's work. Don't invent a default profile.
- **On restart, re-validate before serving; a now-invalid profile is held inactive with offenders named.** Persisted state is re-run through `parseProfile`/`parseFleetCapacity` on load — never served degraded. Autonomy state + widening history reload from durable state and rebuild the in-memory map.
- **The registry never writes the lifecycle mode.** `mode` is Operator-decision-written state the registry stores and serves (same class as autonomy). There is no registry code path that transitions it — only `recordWidening` mutates state here, and even that is on an Operator authorization carried by the Control Plane.

## Concerns This Spec Does Not Cover

- Lane assignment, the scope tripwire, the risk-path floor, mode-variant resolution, and earn-in eligibility (STACK-AC-LANE-ENGINE owns every decision over the config this spec supplies).
- Window ledger, headroom estimation, exhaustion-vs-throttle classification, filter-and-rank, and failover (STACK-AC-WINDOW-SCHEDULER owns every decision over the pool set this spec supplies).
- Config-pack loading, versioning, and activation lifecycle (FUNC-AC-PLUGINS chain); this spec consumes the already-parsed profile data `loadConfig` produces and adds the profile schema + cross-deployment validation on top.
- The DB persistence layer's table shapes, migrations, and transaction plumbing (the daemon data layer); this spec defines the in-memory parse/validate/freeze + pure-update seam and where it fails closed, not the storage schema.
- Live budget enforcement, cost accounting, staged capability rollout, demote-on-red execution, and the cross-deployment Operator inbox/ranking (the cost layer, the FLEET capability slice, and FUNC-AC-OPERATOR-SURFACE); this spec only *holds and serves* the budget value, capability-version bindings, and autonomy state those mechanisms read and update.
