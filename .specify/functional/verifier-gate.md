---
id: FUNC-AC-VERIFIER-GATE
type: functional
domain: runforge
status: approved
version: 1
layer: 1
---

# FUNC-AC-VERIFIER-GATE — Verifier-Gated Autonomy

> **Spec history (v1, 2026-06-14):** Written to enact L0-AC-VISION v6's **verifier-gated-autonomy** boundary (Delta H). v6 named the boundary and deferred its enforcing L1 to implementation; this spec is that enforcing L1. It generalizes the merge-time rule "no verification, no merge" (owned by FUNC-AC-MERGE-DECISION) to an execution-time rule across every lane and domain: *no verifier, no autonomous action*. The full direction and reasoning live in `docs/superpowers/specs/2026-06-14-cockpit-as-operations-os-design.md`. This spec is language-agnostic and domain-agnostic by construction: it governs software-delivery lanes and non-software lanes (operations, knowledge-work, client-delivery, business-development) identically.

## Problem Statement

The platform's whole trust machinery — earned-trust merge, the risk-class ramp, "no verification means no eligibility to merge" — rests on a hidden assumption: that the work can be independently checked. For software changes that assumption holds, because there is an oracle — tests, an end-to-end run, a deployable diff — that can say "this is wrong." As the platform widens to steer all of the Operator's work, most of that work has no such oracle. A drafted email, a triaged inbox, a researched recommendation: nothing automatically falsifies "this is correct."

Without a rule about this, a lane with no way to be checked faces only bad options. If it acts autonomously anyway, the platform manufactures confidence it has not earned — work ships unverified under the banner of automation, which is exactly the harm the trust machinery exists to prevent. If instead every such action is sent to the Operator, the inbox floods with the very routine work the platform was built to absorb, and the Operator's attention — the scarce resource — is spent worse than before.

What is missing is a single precondition that decides, per lane, whether autonomous execution is even permitted: a lane may act on its own only if it declares a **verifier** — an oracle that can falsify "this work is correct." A lane that declares no verifier is never trusted to execute on its own; it may still help, but only by drafting and surfacing, with the Operator deciding. This is the same principle as "no verification, no merge," lifted from the merge decision to the act of autonomous execution itself, so it holds in every domain the platform steers — not only where the work happens to be code.

A no-oracle lane is therefore assist-and-escalate by default. It is not assist-only forever: such a lane can earn the verifier-gated state by acquiring an engineered, deterministic oracle built for its domain — but only an oracle that can return a real failing verdict on the work's **outcome**, proven able to fail before the lane is ever trusted to act. The danger this guards against is not the obviously-unverifiable lane; it is the lane that dresses a weak check in the appearance of an oracle — a check that confirms the work's shape (its format, a banned-phrase scan, a completed checklist, arithmetic on the figures it was handed, that an approval was recorded) while never touching whether the outcome is right. Admitting such a shell would build autonomy on a verifier that cannot meaningfully fail, and every lane owner is pulled toward defining a check loose enough to let their lane automate — eroding the boundary from inside. The same trap applies to a probabilistic judgment that rates the work and emits a confidence or an opinion rather than a verdict that can mechanically fail: structured confidence around the work is not the same as a check that can falsify it. So the gate's own "must be able to fail" test is applied to the outcome itself, and a lane earns the verifier-gated state only by demonstrating, at qualification, that its oracle truly rejects bad outcomes.

## Actors

- **Operator** — declares each lane and whether it carries a verifier, grants a lane its autonomy, and is the one to whom a verifier-less lane's work is surfaced for decision
- **Control Plane** — establishes, before permitting any autonomous execution on a lane, that the lane declares a usable verifier; routes a verifier-less lane to assist-and-escalate; and holds this precondition ahead of, and composing with, every other gate
- **Worker** — the autonomous run carrying a lane's work; it executes on its own only on a verifier-gated lane, and on a verifier-less lane it drafts and surfaces rather than acting

## Behavior

### The gate

**Scenario: A verifier-gated lane may act autonomously**
- Given a lane declares a verifier — an oracle that can falsify "this work is correct," such as an automated test suite, an integration or end-to-end check, a deployable-and-checkable result, or any deterministic or independent check
- When the lane's work is otherwise eligible to proceed without the Operator
- Then autonomous execution is permitted for that lane, subject to every other gate the platform applies

**Scenario: A lane with no verifier is assist-and-escalate only**
- Given a lane declares no verifier
- When its work is ready
- Then the lane never executes autonomously: it may draft work, surface decisions, and act only on the Operator's recorded approval — its output always reaches the Operator before it takes effect, in every domain

**Scenario: A declared verifier must be able to fail on the work's outcome**
- Given a lane names something as its verifier
- When the platform establishes whether the lane is verifier-gated
- Then only a check that can actually return a failing verdict on the correctness of the work's **outcome** counts — not a check that merely inspects the shape around the work (its format, the presence of required fields, a completed checklist, arithmetic on stated figures, or that an approval was recorded); a check that cannot fail, that bears only on the work's structure rather than whether the outcome is right, or that emits a confidence score, a likelihood, or a graded opinion instead of a verdict that can mechanically fail does not make a lane verifier-gated, and the lane is treated as having no verifier

**Scenario: A probabilistic judgment does not qualify as the verifier**
- Given a lane names, as its verifier, a judgment that scores or rates the work's quality and emits a confidence, a probability, or an opinion rather than a hard pass-or-fail verdict on the outcome
- When the platform establishes whether the lane is verifier-gated
- Then that judgment never qualifies as the verifier on its own, however well-calibrated it appears — a judgment that produces structured confidence around the work is not an oracle that can falsify the work, and the lane is treated as having no verifier

**Scenario: A lane earns the verifier-gated state only by passing a seeded-failure qualification**
- Given a lane with no inherent oracle proposes to reach the verifier-gated state by way of an engineered, deterministic check built for its domain
- When the platform qualifies that lane
- Then the engineered check qualifies only if it (a) names at least one high-severity, judgment-level failure mode of the outcome — not a merely structural defect — and (b) is shown, by a blind evaluation against held-out work seeded with such failures at qualification time, to reject every seeded high-severity failure and to autonomously pass nothing the Operator has marked must-not-execute; a check that lets any seeded high-severity failure through, or that passes any must-not-execute artifact, does not qualify and the lane remains assist-and-escalate

**Scenario: A qualified engineered verifier is re-validated against drift**
- Given a lane was qualified for the verifier-gated state by an engineered check
- When time passes and the domain's correct behavior may have shifted — preference, risk tolerance, context, or voice
- Then the engineered check is re-validated against a fresh seeded-failure evaluation on a recurring cadence, and a check that no longer rejects every seeded high-severity failure drops the lane to assist-and-escalate until it is re-qualified — a once-valid engineered verifier is never trusted indefinitely on the strength of a past qualification

**Scenario: The gate precedes and composes with the other gates**
- Given a lane is being considered for autonomous execution
- When the platform evaluates it
- Then the verifier precondition is established first: if it is not met, no earned autonomy, lane policy, risk level, or other gate can permit autonomous execution; if it is met, the work still passes every other gate (the scope verification, the merge decision, the compliance lens, the earned-trust ramp) before it proceeds — the verifier-gate adds a precondition, it never removes one

### Fail-safe and non-configurable

**Scenario: A verifier that becomes unusable drops the lane to assist-only**
- Given a lane was verifier-gated and acting autonomously
- When its verifier becomes unavailable, can no longer be run, or is shown not to falsify correctness
- Then the lane reverts to assist-and-escalate until a usable verifier is restored, and the reversion is recorded with its reason — the lane never keeps autonomy on the strength of a verifier it no longer has

**Scenario: The gate cannot be configured away**
- Given any deployment profile, lane declaration, or configuration, however permissive
- When a lane without a usable verifier is considered for autonomous execution
- Then no configuration can grant it autonomous execution — the verifier precondition is the platform's own and cannot be disabled, weakened, or bypassed by any profile, pack, or lane setting

**Scenario: Learning cannot grant a verifier-less lane autonomy**
- Given the platform has learned that a verifier-less lane's output is consistently approved by the Operator
- When that lane's work is ready
- Then it still does not execute autonomously: however predictable its approval, a lane with no verifier remains assist-and-escalate — the learn-from-the-operator loop can reduce how often other things are asked, but it can never cross this boundary

### Earned autonomy builds only on the gate

**Scenario: Only a verifier-gated lane can earn or be pre-approved for wider autonomy**
- Given a lane is a candidate for widening its autonomy — whether by an Operator decision or by a pre-approved earn-in policy that auto-promotes on a met track record (per FUNC-AC-MERGE-DECISION)
- When the widening is considered
- Then it applies only if the lane is verifier-gated; a verifier-less lane can neither earn nor be pre-approved into autonomous execution, and any auto-promotion that would cross this boundary does not occur

## Success Criteria

- No lane, in any domain, ever executes autonomously unless it declares a verifier that can falsify the correctness of its work's outcome; a lane without one is always assist-and-escalate, drafting and surfacing but never acting on its own
- A named "verifier" that cannot return a failing verdict on an incorrect outcome never makes a lane verifier-gated — a check that bears only on the work's shape (format, required fields, a completed checklist, arithmetic on stated figures, recorded approval) rather than on whether the outcome is right does not qualify
- A judgment that emits a confidence score, a likelihood, or a graded opinion rather than a hard failing verdict on the outcome never qualifies as the verifier on its own
- A no-oracle lane reaches the verifier-gated state only by an engineered oracle that passes a blind seeded-failure qualification — rejecting every seeded high-severity, judgment-level failure and autonomously passing nothing marked must-not-execute — and that qualification is re-validated on a cadence so a once-valid oracle that drifts drops the lane back to assist-and-escalate
- The verifier precondition is established before any other gate and never substitutes for them; a verifier-gated lane still passes scope verification, the merge decision, the compliance lens, and the earned-trust ramp
- A lane whose verifier becomes unusable reverts to assist-and-escalate, with the reversion recorded — autonomy is never retained on a verifier the lane no longer has
- No configuration, profile, lane declaration, or learned behavior can grant a verifier-less lane autonomous execution
- Wider autonomy — earned or pre-approved — is reachable only by verifier-gated lanes; a verifier-less lane can never be promoted into autonomous execution

## Constraints

- **No verifier, no autonomous action** is inviolable and applies across every domain and lane-type the platform steers — software delivery is one case, not the rule; the gate reads identically for operations, knowledge-work, client-delivery, and business-development lanes
- A **verifier is an oracle that can return a real failing verdict on the work's outcome**: a deterministic check, an automated test or end-to-end run, a deployable-and-checkable result, or an engineered check that bears on whether the outcome is right. A check is **not** a verifier if it cannot fail; if it bears only on the shape around the work (its format, the presence of required fields, a completed checklist, arithmetic on figures it was handed, that an approval was recorded) rather than on whether the outcome is correct; or if it emits a confidence score, a likelihood, or a graded opinion instead of a hard pass-or-fail verdict — structured confidence around the work is not the ability to falsify it. A probabilistic or model-based judgment of quality, on its own, never qualifies as the verifier
- A no-oracle lane is **assist-and-escalate by default** and earns the verifier-gated state only through an **engineered oracle that passes a seeded-failure qualification**: the oracle must name at least one high-severity, judgment-level failure mode of the outcome and be shown, by a blind evaluation against work seeded with such failures at qualification time, to reject every seeded high-severity failure and to autonomously pass nothing the Operator has marked must-not-execute. This qualification is **re-validated on a recurring cadence** to counter drift in the domain's correct behavior; an oracle that stops rejecting seeded high-severity failures drops its lane to assist-and-escalate until re-qualified. No general earn-path program is built ahead of a concrete lane that needs to qualify — the qualification is established per lane, when a lane is actually a candidate
- The gate is **a precondition that composes, never a substitute**: it sits ahead of and alongside the scope verification, the merge decision (FUNC-AC-MERGE-DECISION), the compliance lens (FUNC-AC-COMPLIANCE-GATE), and the earned-trust ramp (FUNC-AC-FLEET); it can only withhold autonomy, never grant a change passage past another gate
- The gate is **non-configurable**, a sibling of the scope tripwire: no deployment profile, config pack, lane declaration, or learned behavior can disable, weaken, or bypass it
- The gate is **fail-safe**: any doubt about whether a lane has a usable, falsifying verifier resolves to assist-and-escalate, never to autonomous execution; a lost or degraded verifier drops the lane to assist-only with the reason recorded
- The gate **bounds earned and pre-approved autonomy**: no lane reaches autonomous execution — by Operator grant or by pre-approved earn-in auto-promotion — unless it is verifier-gated
- This capability **decides only whether a lane may execute autonomously**; it never itself executes, merges, deploys, alters a pipeline phase, or authors or edits any specification or the vision
