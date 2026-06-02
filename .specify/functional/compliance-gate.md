---
id: FUNC-AC-COMPLIANCE-GATE
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-COMPLIANCE-GATE — Deployment-Configurable Compliance Gate

## Problem Statement

The platform runs many deployments, and some of them are regulated: their codebases carry paths where a change can expose protected personal data, miscompute regulated billing, weaken an access boundary, or cross a safety line. For those deployments there is a duty — sometimes a legal one, always a trust one — that no such change reaches the shared mainline (where the deployment's changes are integrated) without the deployment's required compliance sign-off.

Today the platform has reviewer roles that can read a change with a compliance lens and report what they find, but their findings are advice only. Nothing stops a change that touches a regulated-sensitive path from merging while a required compliance review is missing, incomplete, or has objected. As the platform widens its own autonomy — letting low-risk changes earn their way to autonomous merge — that advisory posture becomes the gap through which a non-compliant change ships unattended. The earned-trust ramp is exactly what makes an unenforced compliance lane dangerous: the more the platform merges on its own, the more a path that *should* have stopped at a human is one that now slides through.

Compounding the problem, deployments differ in what they must check. One deployment must satisfy several regulatory lenses at once (privacy, regulated billing, a device-boundary judgment, a sector certification); another needs only general data-protection; a third needs none at all. A single fixed compliance check is wrong for all three — too heavy for the content website, too light for the regulated platform. The platform needs a compliance gate that **blocks the merge by construction** when a change touches a deployment's regulated-sensitive paths and the deployment's required compliance reviews have not all passed — where *which* reviews are required is a property of the deployment, not the platform. The gate must fail safe: if it cannot prove the required reviews passed, it must hold the change for a human, never let it through.

## Actors

- **Operator** — the human who configures a deployment's compliance requirements, and the only one who may decide a blocked change: approve it to proceed, send it back, or, where the deployment permits, override with an explicit, recorded reason
- **Control Plane** — determines whether a change touches a deployment's regulated-sensitive paths, requires the deployment's compliance reviews when it does, holds the merge until every required review has passed, and routes a blocked change to the Operator as a decision
- **Compliance Reviewer** — one or more deployment-configured reviewer roles (for example a privacy lens, a regulated-billing lens, a safety-boundary lens, a sector-certification lens), each of which examines a change through its regulatory lens and returns a clear verdict: pass, or block-with-reason
- **Worker** — the autonomous run that produced the change and is waiting to merge; it cannot merge a gated change until the gate clears

## Behavior

**Scenario: Regulated-sensitive change is detected and held**
- Given a deployment whose profile marks certain paths as regulated-sensitive (protected data, regulated billing, access boundaries, safety paths)
- When a change touches one or more of those paths
- Then the change is marked as requiring compliance review and is held back from the shared mainline until the deployment's required compliance reviews have all passed

**Scenario: Required reviews are drawn from the deployment's compliance review set**
- Given a deployment that has configured a compliance review set in its profile
- When a regulated-sensitive change is detected
- Then exactly the lenses the deployment requires for the paths that change touched are demanded — a deployment with several lenses requires all that apply; a deployment with a lighter set requires fewer; a deployment with none requires none

**Scenario: All required reviews pass — the gate clears**
- Given a held change whose required compliance reviews are all outstanding
- When every required Compliance Reviewer returns a pass verdict
- Then the compliance gate clears and the change becomes eligible to proceed toward the shared mainline on the same terms as any other change

**Scenario: A required review blocks — the change does not merge**
- Given a held change with required compliance reviews
- When any required Compliance Reviewer returns a block-with-reason verdict
- Then the change is not merged, the blocking reason is attached to it, and the change is surfaced to the Operator as a decision

**Scenario: A required review is missing or unfinished — fail closed**
- Given a regulated-sensitive change with one or more required reviews
- When a required review has not been performed, has not completed, or its verdict cannot be established
- Then the gate treats the change as not cleared and holds it for the Operator, rather than allowing it to proceed

**Scenario: Regulated-sensitive paths force a human decision regardless of risk class**
- Given the platform's earned-trust ramp would otherwise allow a change to merge autonomously
- When that change touches the deployment's regulated-sensitive paths
- Then autonomous merge is withheld and the change is forced to a human decision — the compliance gate is the first line of that ramp and cannot be earned away

**Scenario: Operator approves a blocked change**
- Given a change blocked at the compliance gate is surfaced to the Operator with the question, the blocking reason(s), and the available choices
- When the Operator approves it to proceed
- Then the approval is recorded against the change and it is released to continue toward the shared mainline

**Scenario: Operator sends a blocked change back**
- Given a change blocked at the compliance gate
- When the Operator decides it should not proceed as-is
- Then the change is returned for rework rather than merged, with the Operator's reason recorded

**Scenario: Operator override is explicit and recorded**
- Given a deployment whose profile permits an Operator override of a compliance block
- When the Operator overrides a blocking verdict
- Then the override requires an explicit reason, the override and its reason are recorded as part of the change's compliance record, and the change proceeds only on that recorded decision

**Scenario: A deployment requiring no compliance review is not gated**
- Given a deployment whose profile configures no compliance review set
- When any change is produced for it
- Then the compliance gate adds no hold — the change proceeds on the platform's other gates alone

**Scenario: The change's compliance record is auditable**
- Given a change passed through the compliance gate
- When its history is later examined
- Then it shows which regulated-sensitive paths it touched, which reviews were required, each verdict and its reason, and any Operator decision or override — enough to reconstruct why the change was allowed or stopped

## Success Criteria

- No change that touches a deployment's regulated-sensitive paths reaches the shared mainline without that deployment's required compliance reviews having all passed, or an explicit recorded Operator decision
- The required reviews for any change are exactly those the deployment's profile demands for the paths the change touched — neither the platform's fixed set nor a heavier set than the deployment configured
- A change touching regulated-sensitive paths is never merged autonomously, irrespective of how much autonomy the deployment has earned for its risk classes
- When a required review is missing, unfinished, or indeterminate, the change is held for a human — the gate never resolves ambiguity in favor of merging
- Every blocked change reaches the Operator as a self-contained decision carrying the blocking reason and the consequences
- A deployment configured with no compliance requirement is never delayed by this gate
- Each gated change carries an auditable compliance record sufficient to reconstruct the decision after the fact

## Constraints

- The gate is **fail-closed**: the default outcome on any uncertainty — unknown verdict, unavailable reviewer, unrecognized path, incomplete configuration — is to hold the change for a human, never to release it.
- The compliance review set is a **per-deployment property** held in the deployment's profile, not a platform-wide fixed list; the same platform behavior yields a full set for a high-regulation deployment, a light set for a low-regulation one, and none for an unregulated one.
- Regulated-sensitive paths — at minimum those touching protected data, regulated billing, access boundaries, and safety lines — are detected from the deployment's profile, and detection forcing the required review happens **by construction**: the gate must not depend on a reviewer remembering to look or on a change being voluntarily flagged.
- The compliance gate is an **enforced gate, not advice**: a blocking verdict prevents the merge; it does not merely annotate it. This holds even when every other check the platform runs has passed.
- A compliance block can only be cleared by all required reviews passing or by an explicit, recorded Operator decision; the platform never clears a compliance block on its own, and never auto-promotes a regulated-sensitive change to autonomous merge.
- An Operator override, where a deployment permits one, must be explicit, reasoned, and recorded; a deployment may configure that certain lenses or path classes are non-overridable.
- The gate decides only whether a change may proceed toward the shared mainline on compliance grounds; it never merges, never deploys, never edits a specification, and never alters another pipeline phase.
- Whether a change touched a regulated-sensitive path, the required verdicts, and any Operator decision must be durably recorded before the change is allowed to proceed, so the compliance record is complete and reconstructable.
