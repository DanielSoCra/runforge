---
id: ARCH-AC-VALIDATION
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-QUALITY
---

# ARCH-AC-VALIDATION — Validation Service

## Overview

The Validation Service provides independent verification of implementations through a sequence of heterogeneous review gates, holdout scenario execution, and post-deployment testing. It ensures that no implementation is promoted without passing deterministic checks, spec compliance verification, quality evaluation, and (for complex work) security review. Holdout scenarios are executed as an opaque deterministic process that the Validation Service invokes but never inspects.

## Data Model

**ReviewGate** represents a single verification step. It contains: a gate type (deterministic, spec-compliance, quality, or security), a status (pending, running, passed, or failed), and an array of findings (each with a severity, location, and description). Deterministic gates have no findings on success; intelligent gates always produce structured findings.

**ReviewRound** represents a complete pass through all applicable gates. It contains: an ordered array of ReviewGates, the fix attempt number (starting at zero for the first pass), and a timestamp.

**GateSequence** defines which gates apply based on complexity and risk. Default mapping: simple → gates 1 and 2, standard → gates 1 through 3, complex → all 4 gates. Risk override: if the work request is flagged as security-sensitive (based on spec content, affected artifact locations, or explicit labeling), gate 4 (security) is included regardless of complexity classification. Gate selection uses the maximum of complexity-required gates and risk-required gates.

**FixCycle** tracks a fix-and-re-review iteration. It contains: the review round that produced findings, the fix attempt number, and a reference to the worker session that performed the fix. Fix cycles are bounded by a configured maximum.

**HoldoutResult** represents the outcome of holdout scenario execution. It contains: a scenario identifier and a pass/fail indicator. The Validation Service never receives or stores scenario content — only identifiers and results.

**DeploymentCheck** represents post-deployment verification. It contains: a health status (healthy, unhealthy, or timeout), an array of test results (each with a test name and pass/fail), the fix attempt number, and a timestamp.

**EvaluationRubric** defines structured dimensions for intelligent review gates. Spec compliance uses dimensions: acceptance criteria coverage, behavioral correctness, constraint adherence. Quality uses dimensions: maintainability, pattern consistency, test quality, convention alignment. Security uses dimensions: injection resistance, authentication completeness, data validation, concurrency safety.

## API Contract

**Review** — Called by the Daemon Control Plane. Request: feature branch reference, governing spec content, complexity classification, risk-sensitive flag, max fix cycles. Response: passed (all gates clear), failed-and-fixed (passed after fix cycles, with fix count), or escalated (max fix cycles exceeded).

The review operation proceeds:
1. Determine the gate sequence based on complexity classification and risk-sensitive flag (see GateSequence). If risk-sensitive, include gate 4 regardless of complexity.
2. Execute gates in order. If any gate fails, stop the sequence.
3. On gate failure: delegate fix creation to the Implementation Coordinator (which spawns a fix worker), then re-run all gates from gate 1.
4. Repeat until all gates pass or max fix cycles is reached.

**Holdout** — Called by the Daemon Control Plane. Request: branch reference, scenario runner command. Response: all-passed, or failed with an array of scenario identifiers that failed (never scenario content).

The holdout operation proceeds:
1. Execute the configured scenario runner as a deterministic process against the implementation branch. No intelligent session is involved.
2. Collect structured output: scenario identifiers and pass/fail results.
3. If any scenario fails: return failure with the failed scenario identifiers to the Daemon Control Plane. The Control Plane delegates diagnosis to the Bug Diagnosis Service to determine whether the failure reflects a spec gap (→ needs-spec-update), an implementation defect (→ fix cycle), or a validation gap (→ needs-human). No automatic fix or label is applied before diagnosis completes.

**Deploy** — Called by the Daemon Control Plane. Request: branch reference, deployment command, health verification target, health verification timeout. Response: healthy, or failed with details.

The deploy operation proceeds:
1. Trigger the configured deployment process.
2. Poll the health verification target at regular intervals until healthy or timeout.
3. Return the health status.

**Test** — Called by the Daemon Control Plane. Request: test commands (automated functional tests, interactive tests if applicable), max fix attempts. Response: all-passed, failed-and-fixed (with fix count), or escalated.

The test operation proceeds:
1. Execute configured test commands against the deployed environment.
2. On failure: create a targeted fix (delegate to Implementation Coordinator), re-deploy, re-test.
3. Repeat until all tests pass or max fix attempts is reached.

## System Boundaries

- Validation Service OWNS: review gate definitions, gate sequencing logic, evaluation rubrics, holdout execution orchestration, deployment verification, test execution orchestration.
- Validation Service CALLS: Session Runtime (to spawn Reviewer sessions for gates 2, 3, and 4), Implementation Coordinator (to spawn fix workers when gates or tests fail).
- Validation Service DOES NOT have access to holdout scenario content. It invokes the scenario runner as an opaque deterministic process and receives only identifiers and pass/fail results.
- Validation Service DOES NOT own the test or deployment infrastructure — it invokes configured commands and interprets their output.
- Daemon Control Plane CALLS Validation Service for: the review phase, holdout phase, deploy phase, and test phase.

## Event Flows

**Review flow:**
1. Receive the feature branch reference, spec content, and complexity classification.
2. Gate 1 (deterministic): execute configured automated verification checks as a deterministic process. No intelligent session. Collect result signal and output. If fail: extract structured failure information, proceed to fix cycle.
3. Gate 2 (spec compliance): spawn a fresh Reviewer session via Session Runtime. The reviewer receives: the implementation diff, the governing spec content (pre-loaded), and a structured rubric. The reviewer independently reads implementation artifacts and verifies every acceptance criterion. It produces structured findings. If fail: proceed to fix cycle.
4. Gate 3 (quality, standard and complex only): spawn a fresh Reviewer session. The reviewer receives: the implementation diff, pattern expectations, and a quality rubric. It evaluates maintainability, pattern consistency, test quality, and convention alignment. If fail: proceed to fix cycle.
5. Gate 4 (security, complex only): spawn a fresh Reviewer session. The reviewer receives: the implementation diff and a security rubric. It evaluates injection risks, authentication gaps, data validation, and concurrency safety. If fail: proceed to fix cycle.
6. All gates pass: return success.

**Fix cycle flow:**
1. Collect findings from the failed gate.
2. Delegate to Implementation Coordinator to spawn a fix worker with the findings as context.
3. After fix: re-run all gates from gate 1 (not from the failed gate — earlier gates must re-validate after changes).
4. Increment fix cycle count. If max cycles reached: escalate to stuck.

**Holdout flow:**
1. Receive branch reference and scenario runner command.
2. Execute the scenario runner as a deterministic process. The runner receives the branch reference and returns structured output (scenario identifiers with pass/fail).
3. Parse results. If all pass: return success. If any fail: return failure with failed scenario identifiers. Never expose scenario content.

**Deployment verification flow:**
1. Trigger deployment via configured command.
2. Poll health verification target at configurable intervals.
3. If healthy within timeout: proceed to test phase.
4. If timeout: return deployment failure.

**Post-deployment test flow:**
1. Execute configured test commands against the deployed environment.
2. If all pass: return success.
3. If any fail: truncate test output (retain only the relevant failure excerpt to prevent context flooding), delegate fix creation to Implementation Coordinator, re-deploy, re-test.
4. Track fix attempts on the run state. If max attempts reached: escalate to stuck.

**Reviewer independence:**
Each reviewer session starts with a fresh context. It has no knowledge of the implementation process, the worker that built the code, or previous review rounds. It independently reads artifacts and verifies claims. The evaluation rubric is immutable to the session — the reviewer cannot alter its own evaluation criteria.

## Error Handling

**Gate findings:** Enter fix cycle. Findings are structured (severity, location, description) so the fix worker receives actionable context.

**Holdout failure:** Return the failed scenario identifiers to the Daemon Control Plane. The Control Plane delegates to the Bug Diagnosis Service for classification: spec gap (→ needs-spec-update), implementation defect (→ targeted fix cycle), or validation gap (→ needs-human). The Validation Service does not interpret holdout failures — it only reports them.

**Deployment health timeout:** Retry the deployment up to a configured number of attempts. If all attempts fail: escalate to stuck.

**Test failure:** Enter targeted fix loop. Truncate verbose test output before injecting into fix context. Fix, re-deploy, re-test. Bounded by max fix attempts.

**Max fix cycles exceeded:** Escalate to stuck. The Daemon Control Plane labels the work request and notifies the operator.

**Reviewer session timeout:** Treat as a gate failure. Retry the gate (the Session Runtime terminates the process; the Validation Service re-spawns a new reviewer). If retry also times out: escalate.

**Reviewer produces unstructured output:** Treat as a gate failure. Retry once with the same rubric. If the second attempt also fails to produce structured findings: escalate.
