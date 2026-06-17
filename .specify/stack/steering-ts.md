---
id: STACK-AC-STEERING
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-STEERING
code_paths: []  # DEFERRED to implementation — path-existence validator requires real files (cf. STACK-AC-DEPLOYMENT-REGISTRY)
test_paths: []  # DEFERRED to implementation — same reason
---

# STACK-AC-STEERING — Steering-Role Registry & Deciders (TypeScript)

## Pattern

**Parse-validate-freeze at the edge, pure deciders in the middle — the same declare → validate → freeze → lookup shape the Deployment Registry uses, applied to role declarations.** A `SteeringRole` arrives as already-parsed config-pack data (from the config-load seam, not a parallel loader); the registry parses it once with a zod `.strict()` schema, runs the cross-role duplicate-id check, deep-freezes the survivor under an identified `RoleVersion`, and stores it in an in-memory map keyed by role id. On top of the registry sit two **pure deciders** — `decideWake` and `checkSpend` — each a total function over a frozen role and a snapshot of state passed in by the caller. This mirrors the lane-engine / deployment-registry idiom exactly: I/O at the edges (config load, Postgres persistence, the live clock, the cost layer's running spend), decisions in pure, exhaustively-testable functions. The registry and deciders schedule nothing, spawn nothing, and execute nothing — the timer, the session spawn, and the dispatch are the Control Plane's.

**No live clock, no live spend — every input the deciders read is passed in.** `decideWake(role, snapshot)` reads `snapshot.now` and `snapshot.lastWakingAt` — never `Date.now()`; `checkSpend(role, runningSpend)` reads the spend the cost layer reports — it accounts for nothing itself. This is the window-scheduler `observedAt` / lane-engine passed-in-`now` rule: a pure function that reads a clock or measures spend is untestable and non-deterministic. The Control Plane owns the timer that supplies `now` and the cost layer owns the accounting that supplies `runningSpend`.

**Fail-closed discriminated-union outcomes — never throw on a policy/config question.** `RegistrationOutcome = { ok: true; role; version } | { ok: false; offenders }`; `WakeDecision`, `SpendVerdict`, `RouteResult`, and `LookupResult` are all tagged unions whose cautious arm carries a cause. A malformed role is rejected *whole*, naming every offender — never silently repaired, never partially applied. The deciders' "cannot decide" arms map to the most cautious treatment (a wake that cannot be evaluated does not fire; a spend that cannot be bounded concludes). Exceptions are reserved for programmer error, exactly as in the lane engine and deployment registry.

## Key Decisions

**Module layout: a `control-plane/steering/` sibling dir, pure-module split mirroring `deployment-registry/` and `lane-engine/`.**

| File | Responsibility |
|---|---|
| `types.ts` | `SteeringRole`, `WakeRhythm`, `RoleVersion`, `Waking`, `WakeDecision`, `SpendVerdict`, `RouteRequest`, `RouteResult`, `RegistrationOutcome`, `WakeSnapshot`, `LookupResult` — the data model and the fail-closed result unions. No logic. |
| `schema.ts` | The `.strict()` zod `SteeringRoleSchema` (incl. the `WakeRhythmSchema` discriminated union), `parseRole(raw)` → validate + deep-freeze, the `deepFreeze` helper, and `zodOffenders` (the lane-engine `<path>: <message>` flattening). Single-role shape only — duplicate-id is cross-record. |
| `decide.ts` | The two **pure deciders**: `decideWake(role, snapshot): WakeDecision` and `checkSpend(role, runningSpend): SpendVerdict`. No I/O, no clock, no persistence — total functions over frozen inputs. |
| `registry.ts` | The in-memory `SteeringRegistry`: `register` (parse + cross-role duplicate-id check + version bump), `lookup`, `openWaking`, `closeWaking`, `route` (the routing-grant check + recorded `RouteRequest`), and the version-attribution map. The persistence edge (Postgres) is called here, never inside `parseRole` or the deciders. |
| `index.ts` | Public surface (mirrors `deployment-registry/index.ts`): `export * from './types.js'` + named exports of the parse / decide / registry functions. |

DB persistence (role declarations, RoleVersions, Wakings, RouteRequests survive restart) is the I/O edge `registry.ts` calls out to — never inside the parse or pure-decide functions. On restart each persisted declaration is re-run through `parseRole` before it is served; a now-invalid declaration is held inactive with offenders named, never served degraded.

**`WakeRhythm` is a discriminated union, resolved by the decider — never a free-form string.** The rhythm declares a *cadence as data*; the L2 says the wake decision is "pure over the rhythm declaration and the snapshot." A tagged union makes "the rhythm elapsed" a total, exhaustive switch:

```typescript
type WakeRhythm =
  | { kind: 'interval'; everyMs: number }   // wakes when now - lastWakingAt >= everyMs
  | { kind: 'cron'; expr: string };         // wakes when a cron field elapses since lastWakingAt
```

`everyMs` is `.int().positive()` and `expr` is a non-empty string validated as a parseable cron expression at parse time — a malformed rhythm is a parse-time offender (L2: "a role without a sound rhythm cannot be scheduled"), never a runtime surprise inside the decider. The decider exhausts the union with a `never` default so a future rhythm kind cannot silently fall through to "not due."

**`SteeringRoleSchema` is `.strict()` across the whole graph — a typo'd key fails activation, never a silent default.** Every object is `.strict()` (the lane-engine / deployment-registry precedent): `capabilityGrant: ['x']` typo'd to `capabilityGrants` must reject, not collapse to an empty grant. The schema validates **shape, not values** (the L2 boundary: the mechanism never judges whether a charter is wise or a budget sufficient). Field shapes:

- `charter`, `instructions`, `voice` — non-empty strings (`voice` may later become a `z.enum` of declared personas; a string keeps it data-driven for now and the schema is the one place to tighten).
- `capabilityGrant`, `referenceKnowledge`, `routingGrant` — `z.array(z.string())`; each entry is a *named-as-data* reference whose existence (is this a known capability / known path?) is a cross-subsystem check the registry runs, not a shape check the schema runs.
- `wakeRhythm` — the `WakeRhythmSchema` discriminated union above.
- `perWakingBudget` — `z.number().positive()` (the L2: a non-positive budget is rejected, "a role without a sound budget cannot fail safe at the spend boundary").

**Cross-role validation (duplicate role id) lives in `registry.register`, not the schema** — mirroring the deployment-registry's cross-deployment one-owner check. The schema validates one role's shape; the schema cannot see the other roles. `register` checks the incoming id against every other active role and, on collision, returns `{ ok: false; offenders: ["role id 'x' is already owned by an active declaration"] }`, naming the contested id (L2 error handling: "attribution requires that a role id resolve to exactly one declaration"). The grant-membership checks (a `routingGrant` / `capabilityGrant` entry naming an unknown target) also run here against the platform's known-paths / known-capabilities sets supplied by the Control Plane — an entry naming an unknown target is an offender and the whole declaration is rejected.

**Versioned attribution: `register` freezes a new `RoleVersion`; the registry yields the active one; re-registration bumps it.** A `RoleVersion` is `{ roleId; version; activatedAt; digest }` — the attribution anchor. `register` computes a content digest of the frozen declaration, assigns the next version number for that role id, and stores `(role, version)`. `lookup(id)` returns the *active* (latest) version. Re-registration of an existing id parses + validates the new declaration; on success it freezes a **new** `RoleVersion` (the prior remains identifiable for records that ran under it); on failure the prior frozen declaration stays active (L2: "replaces the old one only on success"). `openWaking` stamps the Waking with the **current** version and that Waking keeps it for all its records even across a later re-registration — the in-flight pin, exactly the lane-engine "in-flight runs pin the recorded pack version" rule.

**The two deciders are pure and cautious-armed.** `decideWake` returns `{ kind: 'due'; reason } | { kind: 'not-due'; reason }`; it computes due-ness from `now - lastWakingAt` against the rhythm and reads no clock. A first-ever wake (`lastWakingAt` absent) is `due` (the rhythm has trivially elapsed). `checkSpend` returns `{ kind: 'proceed' } | { kind: 'conclude-and-record'; reason }`; it is over-budget when `runningSpend >= role.perWakingBudget` (bounded by the declared budget; the cost layer reports the spend) — over-budget concludes cleanly, never errors and never overspends. A `decideWake` for an unknown role is the registry's `not-found` (the L2: "there is no platform-level default steering role to fall back on"), not a decider arm.

**`route` is the only exit; it checks the routing grant and records — it never executes.** `route(role, target, artifactRef): RouteResult` checks `role.routingGrant.includes(target)`; an ungranted target returns `{ kind: 'rejected'; reason }` and records nothing dispatched (the rejection is itself recorded against the waking per L2). A granted target returns `{ kind: 'recorded'; request }` where `request` is a `RouteRequest` stamped with the originating waking id + RoleVersion, the input it concerns, the target path, and the shaped payload. The registry records and hands off — it **never** runs the structured workflow, merges, or starts implementation. A consult to another role and an Operator proposal are **both** `RouteRequest`s distinguished only by their target path (e.g. `operator-proposal`) — there is no second route type and no private channel.

## Examples

```typescript
// The wake decider: PURE over the snapshot — no Date.now(), exhaustive on rhythm.
function decideWake(role: SteeringRole, snap: WakeSnapshot): WakeDecision {
  const elapsed = snap.lastWakingAt === undefined ? Infinity : snap.now - snap.lastWakingAt;
  switch (role.wakeRhythm.kind) {
    case 'interval':
      return elapsed >= role.wakeRhythm.everyMs
        ? { kind: 'due', reason: 'interval elapsed' }
        : { kind: 'not-due', reason: 'interval not elapsed' };
    case 'cron':
      return cronElapsed(role.wakeRhythm.expr, snap)   // pure: evaluated against snap.now
        ? { kind: 'due', reason: 'cron field elapsed' }
        : { kind: 'not-due', reason: 'cron not yet due' };
    default: { const _x: never = role.wakeRhythm; return _x; }   // future kinds cannot fall through
  }
}
```

```typescript
// The spend decider: bounded by the declared budget, fail-closed — over-budget concludes.
function checkSpend(role: SteeringRole, runningSpend: number): SpendVerdict {
  return runningSpend >= role.perWakingBudget
    ? { kind: 'conclude-and-record', reason: 'per-waking budget reached' }  // never overspend
    : { kind: 'proceed' };
}
```

```typescript
// Route is the ONLY way judgment leaves a role — grant-checked, recorded, never executed.
function route(role: SteeringRole, version: RoleVersion, wakingId: string,
               target: string, artifactRef: ArtifactRef): RouteResult {
  if (!role.routingGrant.includes(target))
    return { kind: 'rejected', reason: `target '${target}' is outside the role's routing grant` };
  return { kind: 'recorded', request: { wakingId, version, target, artifactRef } };  // hand-off only
}
```

```typescript
type RegistrationOutcome =
  | { ok: true; role: Readonly<SteeringRole>; version: RoleVersion }
  | { ok: false; offenders: string[] };   // every offending field, never a partial accept
```

## Gotchas

- **No `Date.now()` in `decideWake`; no accounting in `checkSpend`.** The clock is `snapshot.now` and the spend is the `runningSpend` argument — both passed in by the Control Plane / cost layer edge. A decider that reads a live clock or measures spend is untestable and non-deterministic (the window-scheduler `observedAt` / lane-engine passed-in-`now` rule). The deciders read only their frozen role and their snapshot argument.
- **Exhaust the `WakeRhythm` union with a `never` default.** A future rhythm kind added to the type without a decider arm must be a *compile error*, not a silent "not due." The `const _x: never` default is the structural guard — never a `return { kind: 'not-due' }` catch-all.
- **`route` records the rejection too — an ungranted target is not a silent no-op.** The L2 says "the rejection is itself recorded against the waking." Return the `rejected` arm *and* have the registry edge persist it; a dropped rejection breaks the attribution chain (an invisible attempted hop).
- **A Waking pins the `RoleVersion` it opened under for its whole life.** Never re-read the "current" version inside an open waking's records — a re-registration mid-waking must not retro-stamp it. `openWaking` captures the version once; `route`/`closeWaking` reuse the captured version, exactly the lane-engine in-flight-pin rule.
- **Reject whole, name every offender — flatten the schema's messages into one `offenders[]`.** A declaration with a bad rhythm *and* a non-positive budget names both; never short-circuit on the first failure. The duplicate-id and grant-membership offenders (from `register`) merge into the same `offenders[]` as the schema offenders.
- **A typo'd key fails activation — never silently stripped.** Every object is `.strict()`. `routingGrants: [...]` (plural typo) must reject naming the unknown key, not collapse `routingGrant` to an empty array (which would silently strip the role of every exit).
- **Deep-freeze the whole role graph, including `wakeRhythm` and the grant arrays.** `Readonly<>` is compile-time only; a consumer that mutates `role.routingGrant` or `role.wakeRhythm.everyMs` at runtime would corrupt shared frozen state and let a waking route somewhere its declaration never granted. Recurse-then-`Object.freeze` (the lane-engine / deployment-registry `deepFreeze` precedent).
- **`lookup` miss is a hard stop, not a default.** An unknown / inactive role id returns tagged `not-found`; there is no platform-level default steering role — `decideWake` is never called for a role the registry cannot resolve. Don't invent a default role.
- **Persistence fails closed for Wakings and RouteRequests.** A waking's action is not reported done until its record is durably written, and a route is not dispatched until its `RouteRequest` is recorded (L2: an unrecorded hop breaks the attribution chain). The pure `route`/decider functions return their result in memory; the registry edge must persist before reporting success.
- **The registry never executes, merges, or starts implementation.** `route` produces a recorded `RouteRequest` and hands it to the Control Plane; an `operator-proposal` target produces a recorded proposal and nothing more. There is no code path in this module that runs a structured workflow or reads the Operator's decision — that returns only as a new recorded input a later waking scans.
- **Steering is above the machinery, never load-bearing.** A role that fails to open (its declaration no longer validates at wake time) is not woken and the failure is recorded against the role, never against the deterministic layer — no pipeline decision waits on a steering verdict.

## Concerns This Spec Does Not Cover

- The *content* of product-ownership and technical-leadership judgment (FUNC-AC-PRODUCT-OWNER / FUNC-AC-TECH-LEAD own *what* each role concludes; this spec runs roles as data — those become the first two `SteeringRole` declarations, their substance unmoved).
- The structured workflows steering routes into — the research pipeline, the spec pipeline, the technical-judgment consult path (owned by their own specs); this spec validates a route targets a granted path and hands the `RouteRequest` off, it neither defines nor runs them.
- The Operator inbox, proposal-presentation surface, and interruption ranking (FUNC-AC-OPERATOR-SURFACE); this spec emits a proposal as a recorded `RouteRequest` into the `operator-proposal` path — presenting, ranking, and carrying the Operator's decision live there.
- Config-pack loading, versioning, and activation lifecycle (the FUNC-AC-PLUGINS chain); this spec consumes the already-parsed role declarations that pipeline produces and adds the role schema + cross-role validation on top — it identifies a `RoleVersion` from the declaration handed to it but does not load or activate packs.
- The actual timer, session spawn, and dispatch execution (the Daemon Control Plane); this spec decides *whether* a role is due and *whether* a step may spend (pure, over a snapshot) — the live clock that calls `decideWake`, the session that runs a waking, and the dispatch that carries a `RouteRequest` are the Control Plane's.
- Live spend accounting and the deployment budget (the session-runtime cost layer / the Deployment Registry's deployment budget); this spec holds each role's per-waking budget and bounds against the running spend the cost layer reports — it performs no accounting and enforces no deployment-level cap.
- The DB persistence layer's table shapes, migrations, and transaction plumbing (the daemon data layer); this spec defines the in-memory parse/validate/freeze + pure-decide seam and where it fails closed, not the storage schema.
- The live migration of the hard-coded product-owner agent and tech-lead scheduler onto this mechanism (a Plan-2 migration); this spec defines the data shape and the mechanism they generalize into, not the work of moving the running code.
