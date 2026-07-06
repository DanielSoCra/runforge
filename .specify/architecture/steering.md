---
id: ARCH-AC-STEERING
type: architecture
domain: runforge
status: draft
version: 1
layer: 2
references: FUNC-AC-STEERING
---

# ARCH-AC-STEERING — Steering-Role Registry & Scheduler

## Overview

The Steering mechanism realizes FUNC-AC-STEERING's **roles-as-data** behavior: it is the registry and scheduler the Control Plane reads to run standing judgment roles from their declarations alone, so adding or reshaping a steering role is editing a declaration, not changing the platform. It parses each SteeringRole from the configuration subsystem's already-loaded pack data, validates it atomically and fail-closed (a malformed role fails activation as a whole, naming its offenders), freezes the validated declaration under an identified version, and answers lookups keyed by role id — the same declare → validate → freeze → lookup shape the Deployment Registry uses, applied to role declarations. On top of the registry it adds two pure deciders: a **wake decision** (given a role's rhythm and a snapshot of time, should this role wake now) and a **spend decision** (given a waking's declared budget and its running spend, may this step proceed or must the waking conclude). Everything a woken role produces leaves as a recorded work item or artifact stamped with the role version it ran under; the mechanism dispatches fuzzy inputs into configured structured paths and never executes, merges, or starts implementation. It schedules nothing itself: the actual timer, the session spawn, and the dispatch are the Control Plane's; this spec owns the declarations, their validation, the attribution, and the wake/spend/route decisions those actions are driven by.

## Data Model

A **SteeringRole** is one standing role's declaration, read from the deployment's active configuration pack and frozen for the life of that activation, keyed by a unique role id. It is the data that replaces today's hard-coded product-ownership and technical-leadership modules. It holds:

- **Charter and instructions** — what the role is and the standing brief it operates under, as declared text. The mechanism validates that a charter is present; it never interprets its meaning.
- **Capability grant** — the set of capabilities and tools the role's wakings may use, named as data. A waking may use only what its grant names; a capability outside the grant is unavailable to it.
- **Reference knowledge** — the set of knowledge sources the role may consult, named as data. The mechanism resolves the references' shape; the knowledge content is owned elsewhere.
- **Voice and disposition** — the persona the role speaks with, as declared text carried into its wakings.
- **Wake rhythm** — the cadence on which the role wakes (a recurring interval and the input classes it scans), plus the event classes that may additionally rouse it between scheduled wakings. This is the data the wake decision reads.
- **Per-waking budget** — the spend cap a single waking may consume, as a value (the analogue of the deployment budget value: the mechanism holds the number and bounds against it; the cost layer performs the accounting).
- **Routing grant** — the set of structured paths this role may dispatch into (for example a research path, a technical-judgment consult, an Operator-proposal path), named as data. A role may route only into paths its grant names; routing into an ungranted path is rejected.

Every value in a SteeringRole is policy data; the mechanism validates shape, not values — it never judges whether a charter is wise, a budget sufficient, or a rhythm appropriate. The allowed-routing grant, the capability grant, and the budget are the boundaries it enforces; what the role *does* within them is the role's own judgment.

A **RoleVersion** identifies one frozen state of a SteeringRole declaration: the role id, an identified version, the moment it became active, and a digest of the declared content, so that every later record can name exactly which declaration was in force. Editing a declaration produces a new RoleVersion; the prior version remains identifiable for records that ran under it. This is the attribution anchor — no waking is recorded without one.

A **Waking** is the durable record of one wake-to-sleep cycle of a role. It contains: the role id and the RoleVersion in force, what roused it (scheduled rhythm or a named event class), the inputs it scanned (the new-since-last-waking set its charter covers), the budget granted to this waking, the spend accumulated, the conclusions it reached, the work items and artifacts it emitted, and the bounding timestamps. A Waking is the single attributable unit: every steering action belongs to exactly one Waking, and every Waking names exactly one RoleVersion.

A **WakeDecision** is the recorded outcome of the wake decision for one role at one moment: the role id, the snapshot of time it was evaluated against, whether the rhythm is due, and the reason. It is pure over the role's rhythm declaration and the time snapshot — it reads no live clock and dispatches nothing; the Control Plane consults it to decide whether to actually rouse the role.

A **SpendVerdict** is the recorded outcome of the spend decision for one step within a waking: the waking id, the budget granted, the spend already accumulated, whether the next step may proceed within budget, and — when it may not — the directive to conclude with what the waking has. The over-budget directive is `conclude-and-record`: the unmet need becomes a recorded item for a later waking or a decision for the Operator, never a silent overspend and never an open error.

A **RouteRequest** is one recorded hop a waking emits to move a fuzzy input into a structured path: the originating waking id and RoleVersion, the input it concerns, the named target path (which must be within the role's routing grant), and the shaped payload. It is the only way a steering role's judgment leaves the role — there is no private channel. A consult to another steering role and a proposal to the Operator are both RouteRequests, distinguished only by their target path; the answer returns as another recorded item, never as a direct reply.

A **RegistrationOutcome** is the result of parsing and validating one role declaration at activation: either an accepted, frozen SteeringRole with its RoleVersion, or a rejection carrying the full list of offending fields and why each failed. The mechanism never partially accepts a role declaration.

## API Contract

The Steering mechanism exposes the following operations to the Daemon Control Plane; it has no external surface of its own.

**Register / activate role** — Called when a configuration pack carrying steering roles is loaded and on each configuration reload. Request: the parsed-but-unvalidated role declaration data from the configuration subsystem. Response: a RegistrationOutcome — an accepted frozen SteeringRole with its RoleVersion, or a rejection naming every offender. Validation is atomic and fail-closed: any structural error (unknown key, missing charter, a routing-grant entry naming an unknown path, a capability-grant entry naming an unknown capability, a non-positive budget, a malformed rhythm, a duplicate role id) rejects the whole declaration; on rejection the role keeps its previously active declaration, or — on a first activation that fails — does not become active and the Operator is told. A declaration is never silently repaired and never partially applied.

**Look up role by id** — Called whenever the Control Plane needs a role's declaration. Request: role id. Response: the frozen SteeringRole and its current RoleVersion, or not-found. Resolution reads only the named role's record and never another role's data.

**Decide wake** — Called by the Control Plane on its timer tick (and when an event class fires) to ask whether a role is due. Request: role id, a snapshot of the current time, and the role's last-waking marker. Response: a WakeDecision — due (with the rousing reason) or not-due (with the reason). Pure over the rhythm declaration and the snapshot; it consults no clock, spawns nothing, and mutates nothing. The Control Plane owns the timer that calls this and the spawn that follows a due verdict.

**Open waking** — Called by the Control Plane when it acts on a due WakeDecision to actually rouse a role. Request: role id. Effect: create a Waking bound to the role's current RoleVersion and its declared per-waking budget, recording what roused it and the inputs in scope (the new-since-last-waking set its charter covers). Response: the open Waking, against which spend is checked and to which emitted items attach. A role that fails to open (its declaration no longer validates) is not woken, and the failure is recorded against the role, never against the deterministic layer.

**Check spend** — Called before each step of a waking that would consume budget. Request: the waking id and the cost of the next step. Response: a SpendVerdict — proceed, or `conclude-and-record` when the step would exceed the granted budget. The mechanism bounds against the granted budget; it performs no accounting itself (the cost layer reports the running spend it checks against). An over-budget verdict ends the waking cleanly, not in error.

**Route** — Called when a waking emits a hop into a structured path. Request: the waking id, the target path, and the shaped payload. Effect: validate the target against the role's routing grant, record a RouteRequest, and hand it to the Control Plane to dispatch into the named structured workflow. Response: the recorded RouteRequest, or a rejection when the target is outside the role's routing grant. The mechanism records and hands off; it never runs the structured workflow, never merges, and never starts implementation. A route whose target is `operator-proposal` produces a recorded proposal for the Operator surface and nothing more — implementation begins only on the Operator's recorded word, which this mechanism neither gives nor simulates.

**Close waking** — Called when a waking concludes (its work is done or its budget bounded it). Request: the waking id and its conclusions. Effect: finalize the Waking record with its spend, conclusions, and emitted items, and advance the role's last-waking marker so the next scan reads only what is new. Response: the closed Waking. Closing is the point at which the waking becomes a complete, attributable record; an unclosed waking is reconstructable from its open state and its recorded steps.

## System Boundaries

- Steering OWNS: the per-role SteeringRole declaration (its parse → validate → freeze → lookup lifecycle), the RoleVersion attribution anchor, the Waking record for every wake-to-sleep cycle, the wake decision and spend decision (both pure), the RouteRequest record and the routing-grant check that admits or rejects each hop, and the structural validation that admits or rejects each declaration as a whole.
- Steering IS CONSULTED BY: the Daemon Control Plane (register, look up, decide wake, open/close waking, check spend, route) and — through the records it writes — the Operator surface and other steering roles, which read its Wakings, RouteRequests, and proposals. It is WRITTEN TO only via its own operations, and only by the Control Plane.
- Steering CONSUMES: the parsed role declarations produced by the configuration subsystem's loader (it composes with the existing config-load seam rather than introducing a parallel loader, exactly as the Deployment Registry does); the running spend of a waking from the cost layer (it bounds against it, it does not measure it); and the inputs a role scans — newly filed work items, the Operator's inbox of unshaped items, and submitted raw ideas — which it reads as the durable record the rest of the platform already keeps.
- **Boundary vs FUNC-AC-PRODUCT-OWNER / FUNC-AC-TECH-LEAD:** those specs own the *content* of judgment — *what* a product-ownership role decides about shape and priority, and *what* a technical-leadership role decides about technical soundness. This spec owns *how* any such role is declared, versioned, scheduled, bounded, and permitted to route — the mechanism that runs them as data. When the product-owner and tech-lead functions migrate, they become the first two SteeringRole declarations under this mechanism; their judgment substance stays theirs, and nothing in this spec decides what they conclude, only how their conclusions are bounded and recorded.
- **Boundary vs FUNC-AC-OPERATOR-SURFACE:** that spec owns the Operator's inbox, the proposal-presentation surface, and interruption ranking — *where and how* a shaped proposal reaches the Operator and how he acts on it. This spec owns only the act of *emitting* a proposal as a recorded RouteRequest into the `operator-proposal` path; once recorded, the proposal is the Operator surface's to present, rank, and carry the Operator's decision on. Steering never presents to the Operator directly and never reads his decision except as a new recorded input a later waking scans.
- Steering NEVER: executes a structured workflow (the Control Plane dispatches it and the deterministic layer runs it under its ordinary gates, budgets, and decisions), merges, deploys, alters a pipeline phase, edits a specification or the vision, or starts implementation — every routed thing runs under the deterministic layer's unmodified rules, and steering confers no exemption. It also never communicates outside the durable record: there is no private agent-to-agent channel, by construction and not by configuration.
- Steering is **above the machinery, never load-bearing inside it**: a role that fails to open, overruns its budget, or produces nothing leaves the deterministic layer fully operational. No deterministic-pipeline decision waits on a steering verdict.
- Role declarations, RoleVersions, Wakings, and RouteRequests are persisted as deployment state in the Database, surviving daemon restarts; on restart each role declaration is re-validated before it is served, and a declaration that no longer validates is held inactive with its offenders named rather than served degraded.

## Concerns This Spec Does Not Cover

- **The content of product-ownership and technical-leadership judgment** — owned by FUNC-AC-PRODUCT-OWNER and FUNC-AC-TECH-LEAD. This spec runs roles as data; *what* each role judges, and the quality of that judgment, is theirs. (Those roles become the first two SteeringRole declarations; their substance does not move here.)
- **The structured workflows steering routes into** — the research pipeline, the spec pipeline, the technical-judgment consult path, and any other configured path are owned by their own specs. This spec validates that a route targets a granted path and hands the RouteRequest off; it neither defines nor runs those workflows.
- **The Operator inbox, proposal-presentation surface, and interruption ranking** — owned by FUNC-AC-OPERATOR-SURFACE. This spec emits a proposal as a recorded item; presenting, ranking, and carrying the Operator's decision on it live there.
- **Configuration-pack loading, versioning, and activation lifecycle** — the FUNC-AC-PLUGINS chain. This spec consumes the parsed role declarations that pipeline produces; it does not load, version, or activate packs (it identifies a RoleVersion from the declaration the pipeline hands it, but the pack lifecycle is not its concern).
- **The actual timer, session spawn, and dispatch execution** — the Daemon Control Plane. This spec decides *whether* a role is due and *whether* a step may spend (pure, over a snapshot); the live clock that calls decide-wake, the session that runs a waking, and the dispatch that carries a RouteRequest into a workflow are the Control Plane's.
- **Live spend accounting and the deployment budget** — the session-runtime cost layer (and the Deployment Registry holds the deployment budget value). This spec holds each role's per-waking budget and bounds a waking against the running spend the cost layer reports; it performs no accounting and enforces no deployment-level cap.
- **The live migration of the hard-coded product-owner agent and tech-lead scheduler** — a Plan-2 migration. This spec defines the data shape and the mechanism those hard-coded roles generalize into; moving the running code onto it is implementation work, not this spec's contract.

## Event Flows

**Declaring a steering role from configuration:**
1. A configuration pack carrying steering roles is loaded; the configuration subsystem parses the declaration data and the Control Plane calls register / activate role.
2. The mechanism parses each declaration against the role schema, then validates: charter present, every capability-grant entry a known capability, every routing-grant entry a known path, budget positive, rhythm well-formed, role id unique.
3. On success the declaration is frozen under a new RoleVersion and recorded; the role is now runnable from its declaration alone, with no platform change.
4. On any error the whole declaration is rejected with its offenders named; nothing is activated and the Operator is told.

**A role wakes on its rhythm and triages its inputs:**
1. The Control Plane's timer ticks; for each role it calls decide wake with the current-time snapshot and the role's last-waking marker.
2. The mechanism returns a WakeDecision; for a not-due role nothing happens. For a due role the Control Plane calls open waking, which creates a Waking bound to the current RoleVersion and the declared per-waking budget and records the new-since-last-waking inputs in scope.
3. The waking scans those inputs and, before each spending step, the Control Plane calls check spend; while the SpendVerdict says proceed the waking continues using only its granted capabilities.
4. When the work is done, or when a SpendVerdict returns `conclude-and-record`, the Control Plane calls close waking; the Waking is finalized with its conclusions and emitted items, the last-waking marker advances, and the role sleeps. The over-budget remainder, if any, is a recorded item for a later waking or a decision for the Operator.

**Routing a fuzzy input into a structured path:**
1. During a waking the role judges that an input needs a structured path — an idea to be researched, a finding to be put before a technical-judgment consult, a shaped result to reach the Operator.
2. The Control Plane calls route with the target path and the shaped payload; the mechanism checks the target against the role's routing grant, records a RouteRequest stamped with the waking and RoleVersion, and hands it off.
3. The Control Plane dispatches the RouteRequest into the named structured workflow, which runs under the deterministic layer's ordinary phases, gates, budgets, and decisions — exactly as if the Operator had dispatched it. Steering confers no exemption.
4. The workflow's shaped outcome returns as a new recorded item; a later waking of the originating role (or of another role) scans it and may route the next hop. The chain from raw input to shaped proposal is reconstructable end to end from the recorded RouteRequests and Wakings.

**One steering role consults another:**
1. A waking of one role wants another role's judgment; it routes a consult RouteRequest into the consult path naming the other role.
2. The mechanism records the request; the Control Plane schedules it as an input the other role's next waking scans (or rouses that role per its event classes).
3. The second role's waking produces its judgment as a recorded item, which the first role reads on a later waking. The question and the answer are both durable records either role and the Operator can later read; there is no direct reply.

**A baseline technology question becomes a decision brief:**
1. A waking's scan surfaces a baseline technology question (a database, a hosting provider, a reasoning-model vendor, or comparable foundation).
2. The role routes research to assemble the viable options and a recommendation; the research runs under the deterministic layer's ordinary rules.
3. The shaped outcome is routed as an `operator-proposal` RouteRequest framed as a technology-selection decision request; the steering layer settles nothing itself and routes no implementation that presumes an unsettled foundation. The Operator surface presents it; implementation begins only on the Operator's recorded word.

**Configuration reload and restart:**
1. A reload re-runs register / activate role for the affected roles; a new declaration is validated as a whole and replaces the old one only on success (producing a new RoleVersion), else the old frozen declaration stays active. A waking already open keeps the RoleVersion it opened under for all of its records; only the next waking reads the new version.
2. On daemon restart, each persisted role declaration is re-validated before it is served; a declaration that no longer validates is held inactive with offenders named, never served degraded. Wakings and RouteRequests are reloaded from durable deployment state, so the attribution chain survives the restart.

## Error Handling

**Malformed role declaration at activation (unknown key, missing charter, wrong shape):** Reject the whole declaration fail-closed, naming every offender; keep the previously active declaration, or — on a failed first activation — leave the role inactive and tell the Operator. A typo'd key is rejected, never silently stripped into an unintended default, and no role runs from a declaration the mechanism cannot vouch for.

**Routing grant or capability grant names an unknown target:** The declaration fails validation as a whole and is rejected, naming the offending entries; a role is never admitted with a routing grant that points at a path the platform does not offer or a capability it cannot supply, so a waking can never route into or use something undeclared.

**Non-positive or absent per-waking budget, or malformed rhythm:** Reject the declaration, naming the offender; a role without a sound budget cannot fail safe at the spend boundary and a role without a sound rhythm cannot be scheduled, so neither is ever admitted. A role that validates always carries a positive budget and a well-formed rhythm.

**Duplicate role id:** Reject the newly activating declaration, naming the contested id and the declaration that already owns it; attribution requires that a role id resolve to exactly one declaration, so two roles can never share an id.

**Wake decision for an unknown role:** Return not-found; the Control Plane treats an absent role as nothing to wake rather than rousing a default — there is no platform-level default steering role to fall back on.

**A waking exceeds its budget:** Check spend returns `conclude-and-record`; the waking concludes with what it has and the unmet need becomes a recorded item for a later waking or a decision for the Operator. An over-budget waking is bounded, never an error and never a silent overspend.

**A route targets a path outside the role's grant:** Reject the route and record nothing dispatched; a waking can emit only into paths its declaration grants, so an attempt to route into an ungranted path never reaches a structured workflow. The rejection is itself recorded against the waking.

**A role fails to open (its declaration no longer validates at wake time):** The role is not woken and the failure is recorded against the role; the deterministic layer is untouched, because steering is above the machinery and never load-bearing inside it.

**Persistence unavailable when recording a Waking or RouteRequest:** Fail closed — a waking's action is not reported as done until its record is durably written; a route is not dispatched until its RouteRequest is recorded, because an unrecorded hop would break the attribution chain and leave an invisible step between raw input and shaped proposal.

**Stale or unvalidatable role declaration after restart:** A persisted declaration that no longer passes validation is held inactive with its offenders named rather than served; the role does not wake on a declaration the mechanism can no longer vouch for, and its prior Wakings remain readable for attribution.
