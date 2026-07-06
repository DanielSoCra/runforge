---
id: ARCH-AC-DIAGNOSIS
type: architecture
domain: runforge
status: draft
version: 1
layer: 2
references: FUNC-AC-BUG-TRIAGE
---

# ARCH-AC-DIAGNOSIS — Bug Diagnosis Service

## Overview

The Bug Diagnosis Service classifies bug reports by root cause before any fix is attempted. It spawns a Diagnostician session that analyzes the bug report, the relevant implementation, and the governing specifications to produce a structured classification. The classification determines whether the bug is an implementation error (Type A), a spec gap (Type B), or an expectation mismatch (Type C), and routes each type to the appropriate resolution path.

## Data Model

**BugReport** represents the input to the diagnosis process. It contains: the work request identifier (issue number), title, body text, labels, and any referenced spec identifiers extracted from the body.

**BugDiagnosis** is the structured output of the Diagnostician session. It contains: a classification type (A, B, or C), a confidence score (a decimal between 0 and 1), an array of affected spec identifiers, an array of affected artifact locations, a suggested action description, and a reasoning narrative explaining the classification.

**ConfidenceThreshold** is a configurable value (default: 0.7) below which any diagnosis is routed to a human rather than acted upon automatically.

**BugPipelineVariant** defines the pipeline shape for Type A bug fixes. It differs from the feature pipeline in the following ways: classification is skipped (already done by the Diagnostician), decomposition is skipped (bugs are single-unit fixes), holdout validation is skipped by default (not applicable to targeted fixes) — except when the bug was triggered by a holdout failure, in which case the failing holdout scenarios are re-run after the fix to confirm resolution — and the worker uses a regression-test-first protocol (write the failing test that reproduces the bug before applying the fix).

## API Contract

**Diagnose** — Called by the Daemon Control Plane when a bug-labeled work request is detected. Request: the BugReport (issue number, title, body, labels, referenced specs), the implementation content for the affected artifacts, and the governing spec content. Response: a BugDiagnosis with classification, confidence, affected specs, affected artifacts, suggested action, and reasoning.

The diagnose operation proceeds:
1. Assemble the diagnostician prompt: bug report body, relevant implementation artifacts, governing spec content.
2. Spawn a one-shot Diagnostician session via Session Runtime with structured output validation against the diagnosis schema.
3. Receive the structured diagnosis.
4. Validate: confidence score is within range, classification type is valid, at least one affected spec or artifact is listed.
5. Route based on type and confidence.

**Route Type A** — When classification is Type A and confidence is at or above the threshold. Effect: return the diagnosis to the Daemon Control Plane with a recommendation to use the bug pipeline variant. The Daemon Control Plane creates a targeted fix run using the bug pipeline (implement with regression-test-first protocol, review, integrate, deploy, test, report).

**Route Type B** — When classification is Type B and confidence is at or above the threshold. Effect: return the routing decision to the Daemon Control Plane, which posts the structured diagnosis as a comment on the work request and applies the "needs-spec-update" label. Notify the Spec Author. The diagnosis comment includes: the classification, the affected specs, and the suggested spec changes. No fix is attempted — the implementation is correct per the spec; the spec is incomplete.

**Route Type C or low confidence** — When classification is Type C (any confidence), or when confidence on any type is below the threshold. Effect: return the routing decision to the Daemon Control Plane, which posts the structured diagnosis as a comment on the work request and applies the "needs-human" label. Notify the operator. The comment includes: the classification, confidence score, reasoning, and a note that human judgment is required.

## System Boundaries

- Bug Diagnosis Service OWNS: diagnosis logic, classification schema, confidence threshold configuration, bug pipeline variant definition, routing rules.
- Bug Diagnosis Service CALLS: Session Runtime (to spawn Diagnostician sessions with structured output).
- Daemon Control Plane CALLS Bug Diagnosis Service when a bug-labeled work request is detected during the detect phase.
- Bug Diagnosis Service ROUTES results as follows: Type A (above threshold) returns to the Daemon Control Plane with the bug pipeline variant recommendation. Type B (above threshold) returns the routing decision to the Daemon Control Plane, which applies the "needs-spec-update" label and comment. Type C or low confidence returns the routing decision to the Daemon Control Plane, which applies the "needs-human" label and comment.
- Bug Diagnosis Service DOES NOT perform fixes — it only classifies and routes. Type A fixes are executed by the Daemon Control Plane using the Implementation Coordinator through the bug pipeline variant.

## Event Flows

**Bug detection and diagnosis flow:**
1. Daemon Control Plane detects a bug-labeled work request during polling.
2. Daemon Control Plane assembles the BugReport: parses the issue body, extracts referenced spec identifiers, retrieves the affected implementation artifacts and governing spec content.
3. Daemon Control Plane calls Bug Diagnosis Service with the BugReport and context.
4. Bug Diagnosis Service assembles the diagnostician prompt and spawns a one-shot session via Session Runtime.
5. Diagnostician analyzes: compares the spec's expected behavior against the implementation's actual behavior, checks whether the reported case is covered by the spec, and evaluates whether the spec and implementation agree but the reporter's expectation differs.
6. Diagnostician produces a structured BugDiagnosis.
7. Bug Diagnosis Service validates the output and routes by type and confidence.

**Type A routing flow:**
1. Diagnosis: Type A, confidence >= threshold.
2. Return to Daemon Control Plane: classification details + bug pipeline variant recommendation.
3. Daemon Control Plane creates a run using the bug pipeline variant.
4. Bug pipeline: implement phase uses a regression-test-first Worker (write a test that reproduces the bug, verify it fails, fix the implementation, verify the test passes). Review, integrate, deploy, test, and report phases run normally. If the original diagnosis was triggered by a holdout failure, the failing holdout scenarios are re-run after the fix (before integration) to confirm the fix resolves the original failure.

**Type B routing flow:**
1. Diagnosis: Type B, confidence >= threshold.
2. Return routing decision to the Daemon Control Plane with the structured diagnosis: classification, affected specs, reasoning, suggested spec changes.
3. The Daemon Control Plane posts the diagnosis as a comment and applies the "needs-spec-update" label.
4. Notify the Spec Author via configured channels.
5. Pipeline halts. The work request awaits spec updates.
6. When the Spec Author updates the spec and relabels the work request as "ready," it re-enters the standard pipeline as a new feature implementation.

**Type C / low confidence routing flow:**
1. Diagnosis: Type C (any confidence), or any type with confidence below threshold.
2. Return routing decision to the Daemon Control Plane with the structured diagnosis: classification, confidence score, reasoning, and a note that human review is required.
3. The Daemon Control Plane posts the diagnosis as a comment and applies the "needs-human" label.
4. Notify the operator via configured channels.
5. Pipeline halts. The work request awaits operator decision.

**Feedback recording flow:**
1. After routing, the Daemon Control Plane records the diagnosis in the results ledger: issue number, classification type, confidence, and outcome.
2. Over time, the distribution of Type A/B/C classifications is visible in the results ledger for trend analysis.

## Error Handling

**Diagnostician produces invalid output:** The structured output validation rejects it. Retry the session once. If the second attempt also fails validation, route to human (label "needs-human") with a note that automatic diagnosis failed.

**Confidence below threshold on all types:** Route to human. The system never guesses when confidence is low — wrong classification wastes more resources than human review.

**Diagnostician session timeout:** The Session Runtime kills the process. Route to human with a note that diagnosis timed out.

**Diagnostician session budget exceeded:** The session self-terminates. Route to human with a note that diagnosis was interrupted.

**Referenced specs not found:** If the bug report references spec identifiers that do not exist in the traceability map, proceed with diagnosis using only the available context. Include a note in the diagnosis comment that some referenced specs were not found.
