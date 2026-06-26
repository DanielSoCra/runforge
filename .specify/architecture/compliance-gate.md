---
id: ARCH-AC-COMPLIANCE-GATE
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-COMPLIANCE-GATE
---

# ARCH-AC-COMPLIANCE-GATE — Compliance Gate Evaluation

## Overview

The compliance gate evaluates whether a change may proceed toward the shared mainline by checking whether it touches any regulated-sensitive paths declared in the deployment's profile and, if so, whether every required compliance review has passed. It is a pure, deterministic evaluator: it reads the deployment profile, the change's touched paths, and the recorded review verdicts, and returns a clear proceed / hold / blocked decision with a durable compliance record. The gate never merges, never edits, and never clears a block on its own — it only decides whether the change may continue on compliance grounds.

## Data Model

A **ComplianceProfile** is the subset of a deployment profile that governs compliance: a list of regulated-sensitive path patterns and the set of required compliance reviewers for each pattern. It is data, not code; the gate reads it at evaluation time.

A **ComplianceReviewVerdict** is one recorded review outcome: the reviewer role id, the verdict (`pass` or `block`), the reason, and the timestamp. Only `pass` verdicts clear a required review; missing, unfinished, or indeterminate verdicts are treated as not passed.

A **ComplianceEvaluation** is the gate's output for one change: the touched regulated-sensitive paths, the required reviewers derived from those paths, the verdicts found for each required reviewer, the overall status (`proceed`, `hold`, or `blocked`), and the reasons for any non-proceed status. This record is auditable and reconstructable.

## API Contract

**Evaluate compliance** — Called by the merge-decision machinery before allowing a change to proceed. Request: the deployment's ComplianceProfile, the set of paths the change touches, and the map of recorded ComplianceReviewVerdicts keyed by reviewer role id. Response: a ComplianceEvaluation. The evaluator is pure: no I/O, no clock, no mutable state.

## System Boundaries

- Compliance gate OWNS: parsing the ComplianceProfile, matching touched paths against regulated-sensitive patterns, deriving the required reviewer set, comparing required reviewers against recorded verdicts, and producing the ComplianceEvaluation.
- Compliance gate IS CONSULTED BY: the merge-decision layer (FUNC-AC-MERGE-DECISION) and the integration machinery that advances a change toward the shared mainline.
- Compliance gate CONSUMES: the deployment profile's compliance section, the change's touched paths, and the durable review-verdict records.
- Compliance gate NEVER: merges, deploys, edits code or specs, or clears a block autonomously. It never resolves ambiguity in favor of proceeding.

## Decision Rules

1. If the ComplianceProfile declares no regulated-sensitive paths, the change proceeds with no required reviews.
2. If the change touches no regulated-sensitive paths, the change proceeds with no required reviews.
3. If the change touches regulated-sensitive paths, the gate collects the union of required reviewers for all matched paths.
4. For each required reviewer, the gate checks for a recorded `pass` verdict. A `block` verdict, a missing verdict, or an indeterminate verdict means that reviewer has not cleared.
5. If all required reviewers have passed, the evaluation status is `proceed`.
6. If any required reviewer has returned `block`, the evaluation status is `blocked`.
7. If no required reviewer has blocked but at least one required review is missing or unfinished, the evaluation status is `hold`.
8. The evaluation record includes the matched paths, the required reviewer set, the verdicts found, and the reasons for the status.

## Error Handling

- A malformed or missing ComplianceProfile is treated as no compliance requirements (proceed), because the gate cannot invent requirements for a deployment that has not declared them. A missing profile is not the same as an empty profile in intent, but fail-closed at the profile level would block all unconfigured deployments; the safer platform behavior is to proceed and log that no profile was found.
- An unrecognized path pattern is treated as a non-matching pattern; it never matches by default.
- A verdict with an unknown reviewer role id is ignored unless that reviewer is required.
