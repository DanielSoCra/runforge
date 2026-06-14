---
id: ARCH-AC-LANE-ENGINE
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-MERGE-DECISION
---

# ARCH-AC-LANE-ENGINE — Lane Engine

## Overview

The Lane Engine realizes the lane mechanism of FUNC-AC-MERGE-DECISION as a policy-evaluation component inside the Daemon Control Plane. It loads lane declarations from the deployment's active configuration pack, assigns each run's change to exactly one lane from the classifier's verdict, selects the gate set and merge policy that lane demands — resolved against the deployment's declared **lifecycle mode**, since a lane may declare phase-variant gate sets and merge policies — and, at the integration boundary, on the change's real accumulated content, enforces the non-configurable scope tripwire and the escalate-only risk-path floor before any merge eligibility is granted. The tripwire and the risk-path floor are mode-independent by construction. It is consulted by the pipeline state machine; it never merges, never runs gates itself, never changes a deployment's lifecycle mode (that is an Operator decision recorded in the deployment profile), and never overrides the Compliance Gate or the earned-trust risk floor, both of which compose over its output.

## Data Model

A **LaneDefinition** is one lane's declaration, read from the deployment's active configuration pack. It contains: a unique lane name; qualification criteria expressed over classifier verdict fields (complexity, change kind, declared scope); an allowed-scope declaration (a set of path patterns naming what changes in this lane may touch); a role-routing map (which working role, at which capability level and provider binding, serves each phase for this lane); a gate-set reference (the named set of checks the Validation Service must pass for this lane), declarable either as a single value or as a per-lifecycle-mode map; a merge policy (autonomous-merge-eligible, independent-review-then-merge, or always-hold-for-operator), likewise declarable per lifecycle mode; an optional post-merge batch-review policy (enabled flag plus cadence reference); and an optional earn-in policy (a track-record predicate expressed over the LaneTrackRecord, with all numeric values carried as configuration data). Every value in a LaneDefinition is policy data; the Lane Engine validates shape, not values. The allowed-scope declaration, qualification, and earn-in are **not** mode-variant: only gate set and merge policy may vary by lifecycle mode.

A **DeploymentLifecycleMode** is the deployment's declared lifecycle phase (illustrative phase names: velocity, hardening, clinical — the actual set is configuration), read from the deployment profile at evaluation time. The mode selects which variant of a lane's gate set and merge policy applies. The mode is written only through an Operator decision recorded in the deployment profile (per FUNC-AC-MERGE-DECISION's phase-transition rule, raised as a DecisionRequest); the Lane Engine reads it and never writes it. The tripwire and the RiskPathMap evaluation take no mode input at all — they are structurally mode-independent.

A **LaneAssignment** binds one run to one lane. It contains: the run identifier, the assigned lane name, the configuration pack version the lane was read from, the classifier verdict it was derived from, the assignment reasons, and a timestamp. It is recorded in the run's durable state at classification time and is immutable for the life of the run — a re-classification produces a new recorded assignment, never an in-place edit.

A **RiskPathMap** is the per-repository escalate-only map from path patterns to minimum risk levels, read from the deployment profile. Its evaluation result can only raise a change's effective risk level or force a more cautious lane or a hold; no entry in it can lower a level or qualify a change for a more permissive lane. Unmatched paths fall through to the deployment's configured default minimum.

A **TripwireVerdict** is the recorded outcome of the scope verification. It contains: the run identifier; the set of paths the change actually touched (computed from the change's real content in source control, never from declared intent); the lane's allowed-scope declaration at evaluation time; the verdict (in-scope, or out-of-scope with the offending paths); and a timestamp. A TripwireVerdict is written durably before the merge decision consumes it.

A **LaneTrackRecord** accumulates one lane's history per deployment: counts of clean autonomous merges, counts and causes of bounces (scope violation, gate failure, review block, operator send-back), the timestamps bounding the bounce-free period, and the pack version under which each entry occurred. It feeds the earn-in evaluation and the Operator-facing promotion decision.

A **LaneDecisionRecord** is the audit entry for one change's passage: lane assignment, effective risk level after the RiskPathMap floor, the lifecycle mode in effect at evaluation, TripwireVerdict reference, gate verdicts, compliance-gate outcome, earned-autonomy state consulted, final disposition (auto-merged, held, escalated, sent back) and what authorized it. It is written before the disposition takes effect.

## API Contract

The Lane Engine exposes four operations to the Daemon Control Plane's pipeline state machine; it has no external surface of its own.

**Assign lane** — Called once per run after classification. Request: run identifier, classifier verdict, deployment identifier. Response: a LaneAssignment, or a fail-safe assignment to the deployment's most cautious lane with reason `unassignable` when no lane's qualification matches or more than one matches ambiguously. Never errors open: an unresolvable assignment is itself a valid, recorded, most-cautious assignment.

**Evaluate merge eligibility** — Called at the integration boundary, after the change's content is final for this attempt. Request: run identifier, the change's actual touched paths, the LaneAssignment. Response: an eligibility result containing the TripwireVerdict, the effective risk level (classifier level raised by the RiskPathMap floor, never lowered), the gate set to execute, and the merge policy to apply — both resolved for the deployment's current lifecycle mode — or an escalation directive (more-cautious lane or hold-for-operator) when the tripwire fires or evaluation cannot complete. The lifecycle mode in effect is part of the eligibility result and the audit record. The tripwire evaluation step is unconditional for every lane whose merge policy permits any autonomous outcome; no input — including the lifecycle mode — can suppress it.

**Record outcome** — Called after the merge decision disposes of the change. Request: run identifier, disposition, cause. Effect: appends to the LaneTrackRecord and writes the LaneDecisionRecord. Recording failure blocks the disposition (fail-closed), not the other way around.

**Evaluate earn-in** — Called periodically and after each recorded outcome. Request: deployment identifier, lane name. Response: not-eligible, or eligible-for-promotion with the supporting track-record evidence. An eligible result causes the Control Plane to raise a DecisionRequest to the Operator (per FUNC-AC-DECISION-ESCALATION); the Lane Engine never widens autonomy itself.

## System Boundaries

- Lane Engine OWNS: lane assignment, tripwire evaluation, risk-path floor evaluation, gate-set and merge-policy selection, lane track records, lane decision records.
- Lane Engine READS: LaneDefinitions and the RiskPathMap from the deployment's bound configuration pack version via the configuration subsystem; the deployment's current lifecycle mode from the deployment profile; the classifier verdict from the run state; the change's touched paths from the run's isolated branch in source control via deterministic source-control queries.
- Lane Engine IS CONSULTED BY: the Daemon Control Plane's pipeline state machine, at exactly two points — after classification (assign) and at the integration boundary (evaluate, then record).
- Lane Engine NEVER: executes gates (the Validation Service does, against the gate set the Lane Engine selected), merges (the Control Plane's integrate phase does), spawns sessions, edits configuration, changes a deployment's lifecycle mode (mode transitions are Operator decisions raised as DecisionRequests and recorded in the deployment profile), raises its own autonomy, or communicates with the Operator directly (escalations travel as DecisionRequests through the Control Plane).
- The **Compliance Gate composes over** the Lane Engine: where FUNC-AC-COMPLIANCE-GATE holds a change, the Lane Engine's eligibility result is moot — compliance evaluation is a separate, downstream-overriding check the Control Plane applies after lane evaluation, and the Lane Engine's output carries a marker that compliance has not yet been considered.
- The **earned-trust risk floor composes over** lane policy: the merge decision consults the deployment's earned-autonomy state (per FUNC-AC-FLEET) after the Lane Engine's result; a lane's permissive merge policy is inert for any risk level the deployment has not earned.
- Lane state (assignments, verdicts, records) is persisted in the Database as part of run state and deployment state, surviving daemon restarts.

## Event Flows

**Lane assignment at classification:**
1. The pipeline state machine completes the classify phase; the classifier verdict is in run state.
2. Control Plane calls the Lane Engine: assign lane.
3. Lane Engine resolves the deployment's bound pack version, evaluates each LaneDefinition's qualification against the verdict, and selects the single matching lane — or the most cautious lane on no-match/ambiguity.
4. The LaneAssignment is written to run state; subsequent phases read role routing for this lane from it.

**Merge eligibility at the integration boundary:**
1. The run reaches integrate; the change's content is final for this attempt.
2. Control Plane computes the touched paths from the run's isolated branch via deterministic source-control queries and calls evaluate merge eligibility.
3. Lane Engine applies the RiskPathMap floor (raise-only), then evaluates the tripwire: touched paths against the lane's allowed scope.
4. In scope: the engine resolves the deployment's current lifecycle mode and returns the lane's gate set and merge policy for that mode. Control Plane has the Validation Service execute the gate set; verdicts return to the merge decision, which then applies the compliance gate and the earned-autonomy state on top.
5. Out of scope: the engine returns an escalation directive; the Control Plane re-routes the change to the directed more-cautious lane's treatment or raises a DecisionRequest, recording the offending paths. Autonomous merge is impossible on this attempt.
6. The disposition is reported back via record outcome before it takes effect.

**Post-merge batch review:**
1. For lanes with a batch-review policy, the Control Plane accumulates references to autonomously merged changes.
2. At the policy's cadence, the accumulated batch is dispatched as review work through the ordinary pipeline machinery.
3. Each finding becomes a new work item or a DecisionRequest, linked to the originating change; the batch outcome is appended to the lane's track record.

**Earn-in promotion:**
1. After record outcome (and periodically), evaluate earn-in runs the lane's configured track-record predicate.
2. On eligibility, the Control Plane raises a promotion DecisionRequest carrying the evidence.
3. Only the Operator's recorded grant (per FUNC-AC-FLEET's autonomy widening) changes the deployment's earned state; the Lane Engine merely resumes reading the updated state on subsequent evaluations.

**Configuration pack change mid-run:**
1. A pack activation changes lane declarations while runs are in flight.
2. In-flight runs keep the pack version recorded in their LaneAssignment for all subsequent lane decisions; only newly classified runs read the new version.

## Error Handling

**No lane matches / ambiguous match:** Assign the deployment's most cautious lane, record the reason, continue. Never an open error, never a guess between candidates.

**Tripwire cannot be computed** (source-control query fails, touched-path set indeterminate): Treat as out-of-scope-equivalent — return an escalation directive with cause `tripwire-indeterminate`. The change cannot proceed autonomously while its actual scope is unknown.

**Lane configuration invalid at load** (malformed declaration, unknown gate-set reference, overlapping qualifications declared exclusive): The pack version fails validation at activation time and is not activated; the deployment stays on its previous bound version and the Operator is told. A validation failure discovered at evaluation time (defense in depth) resolves to the most cautious lane.

**RiskPathMap missing or unreadable:** Apply the deployment's configured default minimum to every path and record that the floor ran degraded; if no default exists, escalate to hold-for-operator. The floor never silently evaluates as "no floor."

**Track record store unavailable:** Record outcome fails closed — the disposition is blocked until the record can be written; evaluate earn-in returns not-eligible.

**Classifier verdict missing or stale at assignment:** Assign the most cautious lane with cause `verdict-unavailable`; the run proceeds under maximum caution rather than waiting indefinitely.

**Lifecycle mode unreadable or naming an undeclared phase:** Resolve every mode-variant gate set and merge policy to its most cautious declared variant and record that the mode resolution ran degraded; the mode never silently defaults to a permissive phase. A lane declaring a mode variant for a phase the deployment's configuration does not declare fails pack validation at activation time.

**Double evaluation** (integrate retried after a fix cycle): Each attempt produces a fresh TripwireVerdict against the change's current content; prior verdicts remain in the record as history. Eligibility is never carried over from a previous attempt's content.
