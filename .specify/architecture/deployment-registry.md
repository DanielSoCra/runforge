---
id: ARCH-AC-DEPLOYMENT-REGISTRY
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-FLEET
---

# ARCH-AC-DEPLOYMENT-REGISTRY — Deployment-Profile Registry

## Overview

The Deployment Registry realizes FUNC-AC-FLEET's **self-describing deployment** behavior: it is the single per-deployment record the Control Plane reads to run a project using only that project's profile, so adding a project is registering a profile, not changing the platform. It parses each deployment's profile from the configuration subsystem's already-loaded data, validates it atomically and fail-closed (a malformed profile fails activation as a whole, naming its offenders), freezes the validated profile, and answers per-deployment lookups keyed by deployment id. It produces exactly the consumable shapes its sibling deciders need — per deployment, the lane set and the risk-path map plus default minimum; and, once for the whole fleet, the capacity-pool set with preference order — and it owns the small slice of profile state the Control Plane mutates over a deployment's life: the per-deployment, per-risk-class autonomy state. Capacity pools are the Operator's shared subscriptions and so are a **fleet-level** record held once, not a field copied into every deployment's profile. It decides nothing about lanes, risk floors, capacity windows, or merges; it is the authoritative config source those deciders read, and the keeper of the autonomy state they consult.

## Data Model

A **DeploymentProfile** is the self-describing record for one deployment, keyed by a unique deployment id. It is parsed from the deployment's active configuration once and frozen for the life of that activation. It holds:

- **Owned repositories** — the set of repositories this deployment runs, each by owner and name. A repository belongs to exactly one deployment; the registry rejects a profile that claims a repository another active profile already owns.
- **Risk-classification config** — the per-repository **risk-path map** (an escalate-only list of path-pattern groups, each naming a minimum risk level) and a single **default minimum risk level** applied to any path the map does not match. This is exactly the `RiskPathMap` plus default-minimum pair the Lane Engine consumes; the registry validates its shape (every entry names a known risk level, the default is present), never its risk policy.
- **Lane set** — the deployment's lanes: for each lane its name, qualification criteria, allowed-scope path patterns, gate-set reference, merge policy, optional post-merge batch-review policy, and optional earn-in policy reference; plus the most-cautious lane and the set of declared lifecycle phases. This is exactly the lane-set shape the Lane Engine consumes. The registry validates the lane set's structural integrity and rejects a malformed one; it makes no lane assignment.
- **Lifecycle mode** — the deployment's currently declared lifecycle phase (one of the lane set's declared phases). The mode is a stored value the Lane Engine reads to resolve phase-variant gate sets and merge policies; the registry holds and serves it and validates that it names a declared phase, but the mode is written only through an Operator decision (see Event Flows), never by the registry on its own.
- **Compliance reviewer set** — the domain reviewers that gate this deployment's changes, as data (who reviews, for which conditions). The registry stores and serves this set; the Compliance Gate decides with it.
- **Honest-automation map** — the deployment's classification of its own work into automatable, strained, and irreducibly-human, as data. The registry stores and serves it; consumers use it to concentrate Operator attention and to refuse to attempt what the deployment marks irreducibly human.
- **Budget value** — the spend cap for this deployment, as a value. The registry holds the number; it performs no accounting and enforces no limit.
- **Landing target and production-release path** — where this deployment's changes are allowed to land first, and the declared path by which they are released to production, both as declared data. The registry holds these declarations; it neither lands nor releases anything.
- **Capability-version bindings** — for each shared capability this deployment runs, the identified version it is bound to, as data. The registry records the bindings; staged rollout and demote-on-red execution that change them live elsewhere.

A **FleetCapacityConfig** is a single **fleet-level** record, not part of any DeploymentProfile: the Operator's configured capacity pools and their preference order — per pool a name, the providers drawing on it, the window shape, the permitted signal sources, and a preference rank. It is exactly the pool-config set the Window Scheduler consumes, including the cross-pool invariant that every named provider belongs to exactly one pool. It is fleet-level because the pools are shared subscriptions — a usage window belongs to the subscription, not to any one deployment — so the registry holds and validates it once and serves it to every deployment's provider resolution. (Pool attribution still composes with per-deployment budgets: spend on whichever pool carries a piece of work counts against the carrying deployment's budget, enforced by the cost layer, not here.)

An **AutonomyState** belongs to one DeploymentProfile and records, per risk class, whether that class is human-gated or widened, and — where the Operator pre-approved an earn-in policy — a reference to that policy and the moment of its grant. Default state (no widening recorded) is fully human-gated. This is the one part of the profile the registry mutates after activation: a widening sets one (deployment, risk class) entry and touches no other entry and no other deployment. Every entry carries who authorized it, when, and whether by per-event approval or pre-approved earn-in, so that every widening is recorded and reversible.

A **WideningRecord** is the append-only history of changes to an AutonomyState entry: the deployment id, the risk class, the prior and new state, the authorization (per-event Operator grant or pre-approved earn-in policy reference), and a timestamp. A demotion is itself a WideningRecord entry returning a class to human-gated, so the autonomy state is always reconstructable and an executed reversal is visible.

A **RegistrationOutcome** is the result of parsing and validating one profile at activation: either an accepted, frozen DeploymentProfile, or a rejection carrying the full list of offending fields and why each failed. The registry never partially accepts a profile.

## API Contract

The Deployment Registry exposes the following operations to the Daemon Control Plane; it has no external surface of its own.

**Register / activate profile** — Called when a deployment's configuration is first loaded and on each configuration reload. Request: deployment id and the parsed-but-unvalidated profile data from the configuration subsystem. Response: a RegistrationOutcome — an accepted frozen DeploymentProfile, or a rejection naming every offender. Validation is atomic and fail-closed: any structural error (unknown key, malformed lane set, a pool provider claimed by zero or two pools, a risk-path entry naming an unknown level, a lifecycle mode naming an undeclared phase, a repository already owned by another active deployment) rejects the whole profile; on rejection the deployment keeps its previously active profile, or — on a first activation that fails — does not become active and the Operator is told. A profile is never silently repaired and never partially applied.

**Look up profile by deployment id** — Called whenever a phase needs the deployment's config. Request: deployment id. Response: the frozen DeploymentProfile, or not-found. Resolution reads only the named deployment's record and never any other deployment's data.

**Resolve lane-engine inputs** — Called by the Control Plane when it consults the Lane Engine for a run in this deployment. Request: deployment id. Response: the lane set, the risk-path map, the default minimum risk level, and the current lifecycle mode — exactly the inputs the Lane Engine's assign and evaluate-eligibility operations require. The registry supplies these inputs verbatim from the frozen profile and makes no lane or risk decision.

**Resolve capacity-pool inputs** — Called by the Control Plane / Session Runtime when resolving providers for any work. Request: none (the pool config is fleet-level, not deployment-scoped). Response: the validated FleetCapacityConfig — the capacity-pool set and its preference order, exactly the input the Window Scheduler reads to filter and rank. The registry supplies the pools and the order and makes no scheduling decision.

**Read autonomy state** — Called by the merge decision (the earned-trust risk floor) and the Operator surface. Request: deployment id and risk class (or all classes). Response: human-gated or widened for that class, with the authorization on record. Read-only.

**Record autonomy widening** — Called by the Control Plane when the Operator grants a widening (per event, or as a pre-approved earn-in policy) or orders a demotion. Request: deployment id, risk class, target state, and the authorization. Effect: update exactly that one (deployment, risk class) entry, append a WideningRecord, and leave every other entry and every other deployment untouched. The registry records and serves autonomy state; it never decides to widen — eligibility and earn-in are the Lane Engine's, and the grant is the Operator's.

**Read declared data** — Called by the consumers that decide with profile data the registry only holds: the compliance reviewer set (Compliance Gate), the honest-automation map (attention-concentration and attempt-gating consumers), the budget value (the cost layer), the landing target and production-release path (the integration / release machinery), and the capability-version bindings (the rollout machinery). Request: deployment id and which datum. Response: that datum from the frozen profile. Read-only.

## System Boundaries

- Deployment Registry OWNS: the per-deployment DeploymentProfile record (its parse → validate → freeze → lookup lifecycle), the per-deployment AutonomyState and its WideningRecord history, the deployment→repository ownership invariant, the single fleet-level FleetCapacityConfig (parse/validate/freeze/serve, incl. the cross-pool one-provider-one-pool invariant), and the structural validation that admits or rejects each record as a whole.
- Deployment Registry IS CONSULTED BY: the Daemon Control Plane (profile lookup, lane-engine inputs, capacity-pool inputs, declared-data reads) and the Operator surface (autonomy-state and profile reads). It is WRITTEN TO only via record-autonomy-widening, and only by the Control Plane carrying an Operator authorization.
- Deployment Registry CONSUMES: the parsed profile data produced by the configuration subsystem's loader (it composes with the existing config-load seam rather than introducing a parallel loader); it adds the deployment-profile schema and the cross-field/cross-deployment validation on top of that loaded data.
- **Boundary vs ARCH-AC-LANE-ENGINE:** the registry OWNS the per-deployment config the Lane Engine consumes — the lane set (qualification, allowed paths, gate-set references, merge policies, earn-in policy references), the risk-path map and default minimum risk level, and the stored lifecycle mode. The Lane Engine OWNS every decision over that config: lane assignment, the scope tripwire, the escalate-only risk-path floor evaluation, gate-set and merge-policy selection resolved against the mode, lane track records, lane decision records, and earn-in eligibility. The registry supplies inputs and never assigns a lane, evaluates a tripwire, applies a risk floor, resolves a mode variant, or judges earn-in. The Lane Engine reads the registry's config and the registry's autonomy state (its earned-trust risk floor composes over lane policy) and writes neither — a widening is recorded only through the registry's record-autonomy-widening on an Operator grant.
- **Boundary vs ARCH-AC-WINDOW-SCHEDULER:** the registry OWNS the **fleet-level** capacity-pool config (the FleetCapacityConfig — shared across deployments because the pools are shared subscriptions) and its preference order as configuration data (pool membership, window shapes, signal sources, preference ranks) and the cross-pool one-provider-one-pool invariant at validation time. The Window Scheduler OWNS every decision over that config: the per-pool window ledger, headroom estimation, exhaustion-vs-throttle classification, filter-and-rank during provider resolution, failover, and outcome provenance. The registry supplies the pools and the order and never tracks a window, classifies a signal, ranks a candidate, or fails work over.
- Lifecycle-mode transitions are Operator decisions raised and recorded elsewhere; the registry stores the mode the Operator's decision sets and serves it, and never transitions it on its own.
- Profiles and autonomy state are persisted as deployment state in the Database, surviving daemon restarts; on restart the registry re-validates each profile before serving it, and a profile that no longer validates is held inactive with its offenders named rather than served degraded.
- **A configured deployment is the "merge-governed" boundary.** A deployment is *merge-governed* exactly when it has a deployment profile (the daemon was started with a `deployment` configured); even an all-permissive lane set cannot remove the no-verification / unknown-risk / compliance / orange–red / first-unattended / phase-change escalations that must reach the Operator. This predicate — *a profile is present* — is the single condition the Daemon Control Plane's startup fail-safe (ARCH-AC-OPERATIONAL-SAFETY, A1) and its runtime decision-transport health both key off of. The registry rejects a malformed profile by naming its offenders (it stores nothing and serves nothing); promoting that rejection to a **boot refusal** for a *configured* deployment — rather than running with an empty registry that surfaces the failure later at the decision point — is the Control Plane's fail-safe responsibility, not the registry's, which never aborts the process.

## Concerns This Spec Does Not Cover

- **The focus-gated cross-deployment inbox and interruption ranking** — owned by FUNC-AC-OPERATOR-SURFACE and FUNC-AC-OPERATOR-LEARNING. This spec makes a deployment self-describing and isolated at the config level; the cross-deployment surface and its ranking are separate.
- **Staged rollout of shared capabilities and demote-on-red rollback execution** — a separate FLEET mechanism / capability-version slice. This spec holds the capability-version bindings and the autonomy state as data; the machinery that promotes a version through a low-stakes deployment first, and that reverts a bad version or learned bias fleet-wide, lives there. (The demote-on-red *mechanism* is elsewhere; the autonomy *state* it reads and updates is owned here.)
- **Live budget enforcement and cost accounting** — the session-runtime cost layer. This spec holds the budget value; it performs no accounting, raises no near-limit decision, and halts no work.
- **Lane-assignment, risk-floor, eligibility, and earn-in decisions** — ARCH-AC-LANE-ENGINE. This spec only supplies their config inputs and holds the autonomy state they consult.
- **Capacity windowing decisions** — ARCH-AC-WINDOW-SCHEDULER. This spec only supplies the pool set and preference order.
- **Configuration-pack loading, versioning, and activation lifecycle** — the FUNC-AC-PLUGINS chain. This spec consumes the parsed profile that pipeline produces; it does not load, version, or activate packs.

## Event Flows

**Registering a project as a deployment:**
1. The Operator registers a new project; the configuration subsystem loads its profile data and the Control Plane calls register / activate profile with the deployment id.
2. The registry parses the profile against the deployment-profile schema, then runs cross-field and cross-deployment validation: lane-set integrity, capacity-pool membership, risk-path levels, lifecycle mode against declared phases, and repository ownership against every other active deployment.
3. On success the profile is frozen and recorded; the deployment is now runnable from its profile alone, with no platform change.
4. On any error the whole profile is rejected with its offenders named; nothing is activated and the Operator is told.

**A deployment classifies and gates a change using its own profile:**
1. A run in a deployment reaches classification; the Control Plane calls resolve lane-engine inputs for that deployment id.
2. The registry returns the deployment's lane set, risk-path map, default minimum, and lifecycle mode from its frozen profile.
3. The Lane Engine assigns the lane and (at the integration boundary) evaluates eligibility against those inputs; a change one deployment's profile treats as low-risk is bound by that deployment's lanes and risk map, never another's, because resolution read only this deployment's record.
4. Downstream, the Compliance Gate reads this deployment's compliance reviewer set and the merge decision reads this deployment's autonomy state — both via the registry, both for this deployment alone.

**Resolving capacity for any work:**
1. The Session Runtime resolves a provider for a spawn; the Control Plane calls resolve capacity-pool inputs (fleet-level — no deployment id).
2. The registry returns the validated FleetCapacityConfig: the pool set and preference order from the single frozen fleet record.
3. The Window Scheduler filters and ranks candidates over those pools; the registry took no scheduling decision. (Spend is still attributed to the carrying deployment's budget by the cost layer.)

**Widening autonomy for one deployment and one risk class:**
1. The Lane Engine's earn-in evaluation finds a lane eligible and the Control Plane raises a promotion decision; or a pre-approved earn-in policy's condition is met.
2. The Operator grants the widening (per event) or it auto-promotes under the pre-approved policy; the Control Plane calls record autonomy widening with the deployment id, risk class, target state, and authorization.
3. The registry updates exactly that one (deployment, risk class) entry, appends a WideningRecord, and leaves every other entry and deployment unchanged.
4. Subsequent merge decisions read the updated autonomy state for that deployment and class; no other deployment's autonomy moved.

**Reversing a widening (demote-on-red):**
1. The rollback mechanism (elsewhere) determines a class must return to human-gated and the Control Plane calls record autonomy widening with the demotion target and its authorization.
2. The registry sets the entry back to human-gated and appends a WideningRecord capturing prior state, new state, and why.
3. The autonomy state now reads human-gated for that class; the reversal is on record and reconstructable.

**Configuration reload and restart:**
1. A reload re-runs register / activate profile for the affected deployment; the new profile is validated as a whole and replaces the old one only on success, else the old frozen profile stays active.
2. On daemon restart, each persisted profile is re-validated before it is served; a profile that no longer validates is held inactive with offenders named, never served degraded. Autonomy state and widening history are reloaded from durable deployment state.

## Error Handling

**Malformed profile at activation (unknown key, missing required field, wrong shape):** Reject the whole profile fail-closed, naming every offender; keep the previously active profile, or — on a failed first activation — leave the deployment inactive and tell the Operator. A typo'd key is rejected, never silently stripped into an unintended default.

**Lane set invalid (duplicate lane name, most-cautious lane absent, overlapping qualifications, a phase-variant referencing an undeclared phase or not covering every declared phase):** The lane set fails validation and the whole profile is rejected with the offending lanes named; the deployment keeps its prior profile. The registry never admits a half-valid lane set.

**Fleet capacity-pool config invalid (a provider claimed by two or more pools, a non-positive window length, an empty provider list):** The FleetCapacityConfig fails validation as a whole and is rejected, naming every offending provider; the registry never admits a pool config that would route work to an ambiguously owned provider. (Because the pool config is fleet-level, its rejection is independent of any one deployment's profile.)

**Risk-path map invalid or missing (an entry naming an unknown risk level, or no default minimum):** Reject the profile; a risk-classification config without a default minimum cannot fail safe at the floor, so it is never admitted. (A profile that validates always carries a default minimum, so the Lane Engine's floor never silently evaluates as "no floor.")

**Lifecycle mode names an undeclared phase:** Reject the profile, naming the offending mode and the declared phases; the mode never silently defaults to a permissive phase, and the Lane Engine is never handed a mode its lane set cannot resolve.

**Repository claimed by two deployments:** Reject the newly activating profile, naming the contested repository and the deployment that already owns it; isolation requires that a repository resolve to exactly one deployment's profile.

**Lookup for an unknown or inactive deployment id:** Return not-found; the caller treats an absent profile as a hard stop for that deployment's work rather than proceeding under platform defaults — there are no platform-level project defaults to fall back to.

**Autonomy widening for an unknown deployment or risk class, or without authorization:** Reject the write and record nothing; the autonomy state changes only on a well-formed, authorized grant, and an unauthorized or malformed widening never mutates state. Cross-deployment isolation holds: a widening request naming one deployment can never touch another's state.

**Persistence unavailable when recording a widening:** Fail closed — the widening is not reported as applied until the WideningRecord and the new state are durably written; an autonomy change that cannot be recorded is not granted, because an unrecorded widening would be neither reversible nor explainable.

**Stale or unvalidatable profile after restart:** A persisted profile that no longer passes validation is held inactive with its offenders named rather than served; the deployment does not run on a profile the registry can no longer vouch for.
