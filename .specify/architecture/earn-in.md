---
id: ARCH-AC-EARN-IN
type: architecture
domain: runforge
status: draft
version: 1
layer: 2
references: FUNC-AC-MERGE-DECISION
---

# ARCH-AC-EARN-IN — Pre-Approved Earn-In Promotion

## Overview

Earn-In is the earning half of earned autonomy: a policy-evaluation component inside the Control Plane that lets a deployment's declared lane autonomy **widen off its own proven track record without a per-promotion Operator decision**, but only behind a set of non-configurable fail-closed floors that no profile may lower. It realizes FUNC-AC-MERGE-DECISION's v2.3 earn-in floor ruling — and, for the first crossing into unattended merging, FUNC-AC-FLEET's debut gate and demote-on-red reversibility, under FUNC-AC-VERIFIER-GATE's precondition. It never changes the pure merge decision, never merges, and never itself grants autonomy: it composes over the Lane Engine's earn-in bar, mints a widening only through the Deployment Registry's reversible autonomy-state write, and reverses that widening automatically on a later red event — so every auto-promotion is bounded, recorded, and demotable fleet-wide.

## Data Model

The **Earn-In Floors** are a fixed platform constant — a minimum required amount of clean track record, a recency window that clean record must fall within, and a red-event exclusion window — that no deployment profile, lane, or configuration pack may lower or waive. They are the mechanism the safety claim rests on; a declared bar may only make promotion harder than a floor, never easier. Their numeric values are **provisional** pending the Operator's ruling and default conservative (illustratively: at least ten clean merges, a thirty-day recency window, a thirty-day red-exclusion window); they are platform mechanism, not deployment policy.

A **Pre-Approved Earn-In Policy** is an optional per-lane declaration in a deployment's profile that rides on the lane's definition as policy data. It carries an enabled flag, a policy reference (the identifier recorded as the authorization for any widening it triggers), and the verifier-gated linkage it depends on. Its presence is the toggle that distinguishes the two behaviors on meeting a lane's earn-in bar: **absent** ⇒ the v2 default (raise a promotion decision to the Operator); **present and fully clearing the floors** ⇒ auto-widen without a per-promotion decision. It is opaque to the Lane Engine, which passes it through; Earn-In is its sole interpreter.

A **Lane Earn-In Bar** is the lane's declared required track record — the amount of clean merges and the bounce-free recency a lane must accumulate before it may widen — owned and evaluated by the Lane Engine's bar predicate. Earn-In consumes **both** the bar's eligible/not-eligible verdict **and its declared threshold values** (the required clean-merge count and recency the profile set), because the floor check needs the values themselves: the verdict alone proves the record met the bar, but only the declared values can be compared against the floors. Earn-In never redefines the bar. The bar is **necessary but not sufficient**: a lane whose bar is missing, or whose declared threshold sits below any numeric floor, fails closed identically to a lane that never met its bar — meeting a weak bar is not enough when the weak bar itself sits under a floor.

A **Promotion Track Record** is the per-(deployment, lane) accumulation of floor-relevant facts, derived entirely from recorded state and never from a declared label: the count of **clean merges** — every change that merged cleanly through the lane, whether Operator-approved under review or autonomously, so a lane accrues its record *before* it holds any autonomy (earn-in never depends on autonomy already existing) — and their **recency** (whether the clean record is current, not a dormant lane's stale, months-old merges, so an idle lane cannot clear the recency floor on a cumulative count alone); the classified bounces (scope-tripwire, failed-check, review-block, operator-send-back) that reset the bounce-free period; and a **red-event-in-window marker** — true when any red event was recorded for the lane within the floor's red-exclusion window. It composes over the Lane Engine's recorded track record and outcome stream plus the registry's autonomy history; Earn-In owns only the floor-relevant derivation (the red-window marker, the amount-and-recency computation), not the underlying track record.

A **Red Event** is a recorded signal that a lane's earned trust was misplaced: a red-risk change reaching the lane, a high-severity post-merge batch-review finding, a scope-tripwire firing on a lane that had been auto-merging, a failed production release, or a compliance breach. A red event both fires the demote-on-red trigger and sets the Promotion Track Record's red-window marker, so the same event that reverses a widening also blocks its re-promotion for the exclusion window.

A **Promotion Evaluation** is the outcome of composing the floors over the bar for one (deployment, lane): **not-eligible** (the bar is not met — no decision, no widening); **raise-promotion-decision** (the bar is met but auto-promotion does not apply — no pre-approved policy, or a floor is unmet, or the bar sits below a floor — so a per-event Operator decision is raised, carrying which floors failed as evidence); or **auto-widen** (the bar is met, a pre-approved policy is enabled, every floor clears, and the bar sits at or above every numeric floor). Any indeterminate input resolves to not-eligible or raise-promotion-decision, never to auto-widen.

A **Debut Authorization** is the record that a deployment's first crossing into pre-approved unattended merging has been witnessed by the Operator. It is not a new decision beat: it is a flag the Operator sets on the deployment's **first production-release approval**, persisted in that deployment's Release Ledger decision event (owned by the Release Lane, ARCH-AC-RELEASE), and read back by a `has-debut-authorization` query. Whether a given auto-widen is a deployment's **debut** is derived from the registry's autonomy history: the debut is the deployment's **first-ever widening to a widened state, of any authorization** — a deployment whose history holds any prior widening (an Operator per-event grant, or an earlier earn-in-policy promotion) has already had its crossing into unattended merging witnessed, so a later earn-in promotion is not the debut. Only the very first widening, when it is a mechanism-driven earn-in promotion with no contemporaneous Operator act, is gated on the recorded debut authorization. When the debut gate withholds such a promotion, it does not silently retry: it surfaces the withheld promotion to the Operator as a per-event decision (the deployment's merges keep reaching the Operator meanwhile), and the Operator's grant is recorded as an **operator-grant widening** in the autonomy history — that recorded widening is the witnessed debut. A deployment on no production-release path has no release approval to carry the flag, so its earn-in debut always fails closed this way; once the Operator's per-event grant has recorded that first operator-grant widening, the now-present prior widening record makes subsequent earn-in promotions no longer the debut, and earn-in may act — so the gate never traps such a deployment closed forever.

A **Widening Record** and the per-(deployment, risk class, lane) **Autonomy State** it appends to are owned by the Deployment Registry; Earn-In only writes through the registry's reversible widening operation, tagging the authorization as a pre-approved earn-in policy, and reads the same state back to derive debut status and to keep the mint step idempotent (a widening is minted only at the human-gated → widened crossing, never re-minted when already widened).

## API Contract

Earn-In exposes internal operations to the Control Plane's pipeline state machine and its post-merge observation path; it has no external surface of its own and communicates with the Operator only as decisions raised through the existing Decision Ledger.

**Evaluate promotion** — Called at the integration boundary after lane assignment and the verifier observation, and after each recorded run outcome. Request: deployment identifier, assigned lane, the lane's effective risk level, the lane's **declared earn-in bar (its threshold values) together with the Lane Engine's bar verdict**, the derived Promotion Track Record, the observed verifier status, and the scope-verification state. Response: a Promotion Evaluation (not-eligible, raise-promotion-decision, or auto-widen). The evaluator is pure over recorded inputs and takes no action; it never widens autonomy itself and never returns auto-widen when any floor is unmet, when the bar sits below a floor, when the lane is not verifier-gated, or for a risk level not eligible for an autonomous proceed.

**Mint widening** — Called by the Control Plane only on an auto-widen evaluation that has also cleared the debut gate. Effect: records a widening through the Deployment Registry for exactly that (deployment, risk class, lane), authorized as a pre-approved earn-in policy carrying the policy reference, and captures alongside it the floors cleared and the track record that triggered it. The mint fires only at the human-gated → widened crossing and is a no-op when the pair is already widened. It never crosses an always-escalate boundary: it is not reached for an orange, red, compliance-forced, or otherwise always-escalate class, nor for a lane without a usable verifier. Recording failure fails closed — the widening is not reported applied until it is durably recorded and reversible.

**Check debut authorization** — Called before the first pre-approved widening for a deployment. Request: deployment identifier. Response: authorized (the deployment's first production-release approval recorded the debut flag), or not-authorized (no such record, including every deployment with no production-release path). Read-only over the Release Ledger.

**Trigger demote-on-red** — Called by the post-merge / post-run observation path when a Red Event is observed for a lane. Effect: records a demotion through the Deployment Registry's reversible widening operation, returning the affected (deployment, risk class) to human-gated — which clears the class's lane-specific widenings and records the revocations — and sets the Promotion Track Record's red-window marker so re-promotion is blocked for the exclusion window. Any doubt about whether a signal is a red event resolves to demoting, never to retaining autonomy.

## System Boundaries

- Earn-In OWNS: the Earn-In Floors constant and its enforcement; the interpretation of a Pre-Approved Earn-In Policy; the floor-relevant Promotion Track Record derivation (the red-window marker and the amount-and-recency computation); the Promotion Evaluation (composing the floors over the bar); the mint step's authorization tagging and idempotence; the debut gate (the debut derivation and the has-debut-authorization read); and the demote-on-red trigger (the red-event → demotion mapping).
- Earn-In READS: the Lane Engine's earn-in bar verdict, recorded lane track record, and scope-verification (tripwire) outcomes; the observed verifier status (per FUNC-AC-VERIFIER-GATE); the Deployment Registry's autonomy state and widening history; and the Release Ledger's recorded debut authorization.
- Earn-In IS CONSULTED BY: the Control Plane's pipeline state machine at the integration boundary (evaluate, then, on a cleared auto-widen, mint before the merge decision reads autonomy state) and its post-merge / post-run observation path (demote-on-red).
- Earn-In NEVER: alters the pure merge decision (it composes as a separate mint step ahead of the decision, so the decision stays pure and untouched); merges, deploys, or executes gates; assigns lanes, evaluates the tripwire, or evaluates the bar (those are the Lane Engine's); writes autonomy state except through the registry's reversible widening operation on a well-formed authorization; raises or lowers a numeric floor; grants the debut on mechanism evidence alone; or communicates with the Operator except as decisions raised through the Decision Ledger.
- **The Verifier Gate composes ahead of** Earn-In: a lane without a usable, falsifying verifier can neither be evaluated for auto-widen nor minted; earn-in autonomy builds only on the gate, never past it.
- **The Compliance Gate and the earned-trust risk floor compose over** the merge decision independently of Earn-In: minting a widening never forces a merge — the merge decision still applies the compliance lens and every other gate on top, and a compliance-forced or unverified change never proceeds however wide the lane's autonomy.
- **Boundary vs ARCH-AC-LANE-ENGINE:** the Lane Engine owns the lane set, the bar predicate, the scope tripwire, and the recorded track record; Earn-In owns the floors that gate whether meeting that bar auto-widens, the derived red-window marker over the recorded outcomes, and the mint step. Earn-In reads the Lane Engine's verdicts; it re-owns none of its decisions.
- **Boundary vs ARCH-AC-DEPLOYMENT-REGISTRY:** the registry owns the autonomy state, the widening operation, and the append-only widening history, and holds the pre-approved policy as opaque profile data; Earn-In decides when to call the widening operation and with which authorization, and reads the history to derive debut status. The registry records and serves; Earn-In decides and never mutates state outside the registry's operation.
- **Boundary vs ARCH-AC-RELEASE:** the Release Lane owns the production-release decision and the Release Ledger; the debut-authorization flag is a field the release decision offers until the deployment has its first *approved* release, carried only by an approved decision, and persisted in its ledger decision event. Earn-In only reads that recorded flag; it neither raises the release decision nor writes the ledger.
- Earn-In holds no state of its own beyond the platform Floors constant: the track record, autonomy state, and debut authorization it reasons over are all persisted by their owning components (Lane Engine, Deployment Registry, Release Ledger) and survive daemon restarts there.

## Event Flows

**Auto-widen at the integration boundary (the mint step):**
1. A run reaches the integration boundary; the Control Plane has the assigned lane, the effective risk level, and the observed verifier status in hand.
2. The Control Plane consults Earn-In: evaluate promotion over the recorded Promotion Track Record and the lane's bar verdict.
3. On not-eligible or raise-promotion-decision, no widening is minted (on raise-promotion-decision the Control Plane raises a promotion decision to the Operator, per the v2 default). On auto-widen, flow continues.
4. The debut gate runs: if this would be the deployment's first-ever widening (no prior widening to a widened state in the registry's autonomy history), Earn-In checks debut authorization; if unauthorized, the auto-widen is withheld and the withheld promotion is surfaced as a per-event Operator decision — whose grant is recorded as an operator-grant widening, the witnessed debut — while the deployment's merges keep reaching the Operator meanwhile.
5. On a cleared debut (or a deployment that already crossed its debut), the Control Plane mints the widening through the registry with a pre-approved earn-in-policy authorization, recording the floors cleared and the triggering track record.
6. The merge decision then reads the freshly-recorded autonomy state and disposes of the change on its own merits, with the compliance lens and every other gate composing on top — the mint step widened the lane's earned state; it never itself merged.

**Debut binding on the first production release:**
1. A deployment with a pre-approved earn-in policy approaches its first production release.
2. When the Release Lane assembles a release decision for a deployment that has no prior *approved* release, it offers the debut-authorization option — so a rejected earlier release still offers it on the next, binding the debut to the first production-release *approval*, not the first proposal.
3. The Operator approves the release and, in the same approval, sets whether pre-approved unattended merging may begin; the answer is persisted in the deployment's Release Ledger decision event, and only an approved decision carries it.
4. Until an approved release records that flag, every auto-widen for the deployment fails its debut gate and its merges keep reaching the Operator, regardless of the earn-in policy; after it is recorded, the deployment's first auto-widen mints normally.

**Demote-on-red reversal:**
1. After a merge or run, the observation path detects a Red Event for a lane.
2. It fires the demote-on-red trigger: Earn-In records a demotion through the registry, returning the affected class to human-gated and clearing the class's lane widenings with per-lane revocation records.
3. The Promotion Track Record's red-window marker is set, so a subsequent evaluate promotion returns not auto-widen but a per-event path for the whole exclusion window — the lane must re-earn its record before it can auto-widen again.

**A deployment with no production-release path:**
1. Such a deployment can accumulate a clean track record and clear every mechanism floor.
2. On its would-be debut auto-widen, the debut gate finds no recorded debut authorization (there is no release approval that could carry one).
3. The auto-widen is withheld and the first-ever unattended merge reaches the Operator as an explicit per-event decision; only after that witnessed debut may the deployment's earn-in act unattended.
4. When the Operator grants that first widening per event, the registry records it as a widening; from then on the deployment's autonomy history holds a prior widening, so subsequent earn-in promotions are no longer the debut and act unattended — the witnessed per-event debut is what unlocks earn-in for a no-release-path deployment.

## Error Handling

**Bar not met, or track record unestablished:** Evaluate promotion returns not-eligible; no promotion decision is raised and no widening is minted — an uncertain or failing track record never promotes.

**A numeric floor unmet, or the declared bar below a floor:** Auto-widen is withheld and the evaluation resolves to raise-promotion-decision, carrying which floors failed; a bar below a floor fails closed exactly as a missing bar does, and any widening still requires an explicit per-event Operator decision.

**A red event within the exclusion window:** Auto-widen is withheld for the whole window even if the bar is otherwise met; the red-window marker over recorded state is authoritative and cannot be cleared by configuration.

**Verifier unusable or withheld at the mint step:** No auto-widen and no mint — a lane without a usable, falsifying verifier can neither earn nor be pre-approved into autonomous execution.

**Debut authorization absent or indeterminate:** The debut gate fails closed to a per-event Operator decision; deployment identity or debut status that cannot be determined unambiguously is treated as the debut and reaches the Operator, and renaming, cloning, or re-bundling never turns a debut widening into a later one because the derivation reads the registry's own history.

**Registry write unavailable at mint or demote:** Fail closed — a widening is not reported applied until it is durably recorded and reversible, and a demotion that cannot be recorded leaves the trigger to retry rather than reporting a reversal that did not persist.

**An always-escalate class reaches the mint step:** The mint is never taken for an orange, red, compliance-forced, or otherwise always-escalate class; if such a class is presented, the mint is refused and the change follows its always-escalate path — the pre-approval is inert outside its bounds.

**Ambiguous red-event signal:** Any doubt resolves to demoting the lane and setting the red-window marker; the trigger never retains autonomy on an uncertain signal.
