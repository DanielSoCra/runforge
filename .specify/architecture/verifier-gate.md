---
id: ARCH-AC-VERIFIER-GATE
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-VERIFIER-GATE
---

# ARCH-AC-VERIFIER-GATE — Verifier Gate

## Overview

The Verifier Gate realizes FUNC-AC-VERIFIER-GATE's *no verifier, no autonomous action* rule as a precondition-evaluation component inside the Daemon Control Plane. Each lane declares a **verifier** — an oracle that can falsify "this work is correct" — as part of its lane declaration; the gate establishes, before any other gate is consulted, whether the lane carries a usable, falsifying verifier and therefore whether autonomous execution is even permitted for it. The gate can only ever WITHHOLD autonomy: a verifier-gated lane is handed on to the rest of the platform's gates unchanged, while a lane with no usable verifier is routed to assist-and-escalate and can never reach autonomous execution by any later gate, configuration, or learned behavior. It composes with the Lane Engine (ARCH-AC-LANE-ENGINE) by sitting ahead of it: if the gate withholds autonomy, the Lane Engine's eligibility result is moot. The gate never executes, merges, deploys, edits configuration, alters the verifier declaration, or communicates with the Operator directly.

## Data Model

A **VerifierDeclaration** is one lane's statement of its verifier, read from the deployment's active configuration pack as part of the lane declaration the Lane Engine already loads. It records: the kind of oracle (illustrative kinds — an automated test suite, an integration or end-to-end check, a deployable-and-checkable result, a deterministic check, or any independent check that bears on whether the work is right); a reference to how that oracle is invoked and how its verdict is observed; and the domain-agnostic fact that this kind of oracle can return a *failing* verdict on incorrect work. A lane may also carry **no** VerifierDeclaration at all — the absent case, which is the default and is treated as "this lane is not verifier-gated." A VerifierDeclaration is policy data; the gate validates only that what is declared is shape-valid and, at evaluation time, that it is a *falsifying* oracle — it never trusts a self-asserted "this is a verifier" flag.

A **VerifierStatus** is the current, observed usability of a declared verifier at evaluation time. It records: whether the verifier is present (declared at all), whether it is reachable and runnable now, whether it has been shown able to return a failing verdict (falsifying), and the timestamp the status was observed. A status of present-but-unreachable, present-but-unrunnable, or present-but-non-falsifying is, for the gate's purposes, equivalent to absent. The status is observed, never asserted by the lane itself.

A **VerifierGateVerdict** is the recorded outcome of one gate evaluation for one lane on one run. It contains: the run identifier; the lane name; the VerifierDeclaration consulted (or its absence); the VerifierStatus observed; the verdict — *verifier-gated* (autonomous execution is permitted to proceed to the other gates) or *assist-and-escalate* (autonomy is withheld); the recorded reason whenever autonomy is withheld (no-verifier, verifier-unusable, verifier-non-falsifying, or evaluation-indeterminate); and a timestamp. A VerifierGateVerdict is written durably before any downstream gate consumes it, and it carries a marker that it is a precondition outcome only — it never authorizes a merge, it only declares whether autonomy may be sought at all.

A **VerifierGatePolicy** is the platform's own, non-configurable statement of this precondition. Unlike a LaneDefinition or a deployment profile, it is **not** read from a configuration pack, a deployment profile, or any lane setting — it is engine-owned, a sibling of the scope tripwire. It has no fields a deployment can set; it exists in the data model only to make explicit that no pack, profile, or lane declaration can disable, weaken, or bypass the gate, and that any doubt resolves to assist-and-escalate.

## API Contract

The Verifier Gate exposes one operation to the Daemon Control Plane's pipeline state machine; it has no external surface of its own and no operation that can grant, widen, or record autonomy.

**Evaluate verifier gate** — Called for a lane being considered for autonomous execution, *before* the Lane Engine's assign and evaluate operations are consulted for any autonomous outcome. Request: run identifier, lane name, the lane's VerifierDeclaration (or its absence) from the bound configuration pack version, and the observed VerifierStatus. Response: a VerifierGateVerdict of either *verifier-gated* — meaning the lane may proceed to every other gate the platform applies — or *assist-and-escalate* — meaning autonomy is withheld and the run is routed to draft-and-surface, with a recorded reason. The operation never errors open: an indeterminate evaluation (status cannot be observed, declaration cannot be read, falsifiability cannot be established) is itself a valid, recorded *assist-and-escalate* verdict with reason `evaluation-indeterminate`. There is no operation to override, suppress, or configure the gate, and no operation that returns "autonomy granted" — the gate's permissive verdict only *declines to withhold*; granting passage past any other gate is never within its contract.

## System Boundaries

- Verifier Gate OWNS: the verifier precondition evaluation, the falsifiability determination, the VerifierGateVerdict, and the fail-safe routing of verifier-less or doubtful lanes to assist-and-escalate.
- Verifier Gate READS: the lane's VerifierDeclaration (or its absence) from the deployment's bound configuration pack version via the same configuration subsystem the Lane Engine uses; the observed VerifierStatus of that verifier from the platform's verifier-observation plumbing; the lane name and run identifier from run state.
- Verifier Gate IS CONSULTED BY: the Daemon Control Plane's pipeline state machine, at one point — before any autonomous outcome is sought for a lane, ahead of the Lane Engine's assign/evaluate and ahead of every other gate.
- Verifier Gate NEVER: executes a verifier (the platform's verifier-observation plumbing does, and reports a VerifierStatus), merges, deploys, runs gates, spawns sessions, edits configuration, authors or edits the verifier declaration or any specification or the vision, raises or widens any lane's autonomy, or communicates with the Operator directly (a withheld lane's work travels to the Operator as ordinary assist-and-escalate work through the Control Plane).
- The Verifier Gate **composes ahead of** the Lane Engine (ARCH-AC-LANE-ENGINE): the Lane Engine's lane assignment, tripwire, risk-path floor, and merge-eligibility result are all *moot* for autonomous purposes when the gate's verdict is assist-and-escalate. The gate adds a precondition; it never removes one and never substitutes for the tripwire, the merge decision, the compliance lens, or the earned-trust ramp, all of which still apply on top of a verifier-gated lane.
- The Verifier Gate **bounds** earned and pre-approved autonomy: the earn-in evaluation and the Operator-grant path (per FUNC-AC-MERGE-DECISION and FUNC-AC-FLEET) can widen autonomy only for a lane the gate finds verifier-gated; a verifier-less lane is unreachable by any promotion, and an auto-promotion that would cross this boundary does not occur. Learned predictability of Operator approval (per FUNC-AC-OPERATOR-LEARNING) can reduce how often other things are asked but can never make a verifier-less lane verifier-gated.
- The Verifier Gate's precondition is engine-owned and **non-configurable**: it is not represented in any configuration pack, deployment profile, or lane setting that a deployment can write, and so cannot be disabled, weakened, or bypassed — a sibling of the scope tripwire.
- VerifierGateVerdicts are persisted as part of run state, surviving daemon restarts, so a lane's withheld-autonomy reason is auditable.

## Event Flows

**Verifier gate before autonomous execution:**
1. The pipeline state machine reaches the point where a lane would be considered for any autonomous outcome (ahead of the Lane Engine's assign/evaluate for autonomous purposes).
2. The Control Plane resolves the lane's VerifierDeclaration from the bound configuration pack version and obtains the observed VerifierStatus from the verifier-observation plumbing, then calls evaluate verifier gate.
3. The gate establishes falsifiability: a declared verifier counts only if it is present, runnable, and able to return a failing verdict on incorrect work; a declaration that is absent, unreachable, unrunnable, or non-falsifying does not make the lane verifier-gated.
4. Verifier-gated: the gate returns *verifier-gated*; the Control Plane proceeds to consult the Lane Engine (assignment, tripwire, risk-path floor, merge policy) and then the compliance lens and earned-trust ramp on top — every other gate still applies.
5. Assist-and-escalate: the gate returns *assist-and-escalate* with a recorded reason; the Control Plane routes the run to draft-and-surface — the lane may draft work and raise decisions to the Operator, but no later gate, configuration, or earned state can produce an autonomous outcome on this run.
6. The VerifierGateVerdict is written to run state before any downstream gate consumes it.

**A verifier that becomes unusable mid-life:**
1. A lane was verifier-gated and acting autonomously; the verifier-observation plumbing later reports the verifier unreachable, unrunnable, or shown not to falsify correctness.
2. The next gate evaluation observes the degraded VerifierStatus and returns *assist-and-escalate* with reason `verifier-unusable`, recorded with the observation timestamp.
3. The lane reverts to assist-and-escalate until a usable, falsifying verifier is restored; autonomy is never retained on the strength of a verifier the lane no longer has.

**Earned or pre-approved widening is bounded by the gate:**
1. The Lane Engine's earn-in evaluation or an Operator-grant path proposes widening a lane's autonomy.
2. The widening applies only if the gate finds the lane verifier-gated; for a verifier-less lane the proposed widening does not occur, and an auto-promotion that would cross the boundary is declined and recorded.

**Configuration change cannot reach the gate:**
1. A configuration pack activation, deployment-profile edit, or lane-setting change attempts to relax verification expectations.
2. The gate's precondition is engine-owned and reads no such setting; the gate's behavior is unchanged, and a verifier-less lane remains assist-and-escalate regardless of how permissive the new configuration is.

## Error Handling

**No verifier declared:** The lane is not verifier-gated. Return *assist-and-escalate* with reason `no-verifier`. This is the default, not an error — a lane that declares nothing draft-and-surfaces.

**Verifier declared but unusable** (unreachable, unrunnable, or shown non-falsifying): Treat as equivalent to absent. Return *assist-and-escalate* with reason `verifier-unusable` (or `verifier-non-falsifying` when a declared oracle is established not to return failing verdicts on incorrect work). A lane never keeps autonomy on a verifier it cannot run or that cannot fail.

**Verifier status indeterminate** (the observation cannot be made, or the declaration cannot be read from the bound pack version): Return *assist-and-escalate* with reason `evaluation-indeterminate`. Any doubt resolves to withholding autonomy; the gate never errors open and never guesses a verifier into existence.

**Falsifiability cannot be established:** A named oracle that cannot be shown able to return a failing verdict on incorrect work does not make the lane verifier-gated; return *assist-and-escalate* with reason `verifier-non-falsifying`. A check that cannot fail, or that does not bear on correctness, is treated as no verifier.

**Attempted configuration override of the gate:** There is no configuration surface to override; an activation or profile edit that purports to disable, weaken, or bypass the gate has no effect on the gate's behavior. The precondition is engine-owned and the verdict for a verifier-less lane stays *assist-and-escalate*.

**Verdict cannot be recorded:** Recording fails closed — the lane is treated as *assist-and-escalate* until the VerifierGateVerdict can be written; autonomy is never sought on an unrecorded precondition outcome.
