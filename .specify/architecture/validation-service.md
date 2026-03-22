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

**GateSequence** defines which gates apply based on complexity and risk. Default mapping: simple → gates 1 and 2, standard → gates 1 through 3, complex → all 4 gates. Risk override: if the work request is flagged as security-sensitive, gate 4 (security) is included regardless of complexity classification. Gate selection uses the maximum of complexity-required gates and risk-required gates.

**RiskDetection** determines whether a work request is security-sensitive. Three signals are checked:
- Explicit labeling: the work request carries a security-sensitive label or tag set by the Spec Author.
- Spec content: the referenced specifications mention authentication, authorization, payment processing, credential handling, data encryption, or access control.
- Artifact location: the expected artifact locations overlap with configured security-sensitive paths (e.g., authentication modules, payment handlers, permission systems).
Any one signal is sufficient to flag the request as risk-sensitive. The Operator configures the security-sensitive path patterns and keyword lists.

**FixCycle** tracks a fix-and-re-review iteration. It contains: the review round that produced findings, the fix attempt number, a reference to the worker session that performed the fix, and the finding count for this round (total number of findings across all gates). Fix cycles are bounded by a configured maximum and by diminishing returns detection.

**DiminishingReturnsPolicy** defines early escalation when fix cycles stop making meaningful progress. It contains: a minimum cycle count before evaluation begins (default: 2 — at least two fix cycles must complete before diminishing returns can be assessed), and an improvement threshold (configurable percentage, default: 20% — if the finding count does not decrease by at least this percentage compared to the previous cycle, progress is considered stalled). When two consecutive cycles show improvement below the threshold, the Validation Service escalates to stuck without exhausting remaining fix cycles. This prevents the system from spending resources on a structural problem that incremental fixes cannot resolve.

**HoldoutResult** represents the outcome of holdout scenario execution. It contains: a scenario identifier and a pass/fail indicator. The Validation Service never receives or stores scenario content — only identifiers and results.

**DeploymentCheck** represents post-deployment verification. It contains: a health status (healthy, unhealthy, or timeout), an array of test results (each with a test name and pass/fail), the fix attempt number, and a timestamp.

**EvaluationRubric** defines structured dimensions for intelligent review gates. Spec compliance uses dimensions: acceptance criteria coverage, behavioral correctness, constraint adherence. Quality uses dimensions: maintainability, pattern consistency, test quality, convention alignment. Security uses dimensions: injection resistance, authentication completeness, data validation, concurrency safety.

**StaticAnalysisPolicy** defines deterministic code quality thresholds enforced during gate 1 (automated checks). It contains: maximum cyclomatic complexity per function, maximum function length (lines), maximum artifact size (lines), forbidden type-safety escape patterns (e.g., untyped casts, suppression comments), and required formatting rules. These thresholds are configurable by the Operator and enforced deterministically — no intelligent session can override them.

**ArchitectureFitnessRule** defines a structural invariant verified during gate 1. It contains: a rule name, a description, a verification method (deterministic check or command), and the expected result. Built-in rules include: no circular dependencies between modules, no cross-boundary imports violating service ownership, and layer separation enforcement. The Operator can add project-specific rules.

**WarmupState** tracks the system's trust calibration. It contains: the warmup threshold (configurable number of successful completions required), the current completion count, a graduated flag (true once the threshold is reached), a consecutive correction count (tracking how many consecutive sampled reviews required Operator corrections), and a regression threshold (configurable, default: 3 consecutive corrections triggers regression to warmup). During warmup, every work request that passes all review gates requires explicit Operator approval before promotion. After graduation, the system promotes autonomously (subject to random sampling). If the consecutive correction count reaches the regression threshold, the graduated flag is reset to false and the completion count is reset — the system must re-earn trust.

**SamplingPolicy** defines post-warmup review sampling. It contains: a sampling rate (configurable percentage of completed work requests flagged for Operator review, default 10%), a minimum sampling floor (configurable, default: 1% — the sampling rate cannot be set below this value), and a sampling method (random selection). Sampled work requests are held until the Operator reviews and approves or provides corrections. When the Operator approves without corrections, the WarmupState's consecutive correction count is reset to zero. When corrections are provided, the consecutive correction count is incremented.

## API Contract

**Review** — Called by the Daemon Control Plane. Request: feature branch reference, governing spec content, complexity classification, risk-sensitive flag, max fix cycles. Response: passed (all gates clear), failed-and-fixed (passed after fix cycles, with fix count), or escalated (max fix cycles exceeded).

The review operation proceeds:
1. Determine the gate sequence based on complexity classification and risk-sensitive flag (see GateSequence). If risk-sensitive, include gate 4 regardless of complexity.
2. Execute gates in order. Gate 1 includes static analysis policy enforcement and architecture fitness rule verification. If any gate fails, stop the sequence.
3. On gate failure: delegate fix creation to the Implementation Coordinator (which spawns a fix worker), then re-run all gates from gate 1.
4. Repeat until all gates pass or max fix cycles is reached.
5. If all gates pass: check WarmupState. If not graduated, hold for Operator approval. If graduated, check SamplingPolicy — if sampled, hold for Operator review. Otherwise, return passed.

**Holdout** — Called by the Daemon Control Plane. Request: branch reference, scenario runner command (may be absent if no scenario runner is configured). Response: all-passed, skipped (no runner configured), or failed with an array of scenario identifiers that failed (never scenario content).

The holdout operation proceeds:
1. If no scenario runner is configured: return skipped. The pipeline continues without holdout validation, but a warning is logged. Holdout is strongly recommended but not mandatory — projects without scenarios yet can still use the system.
2. Execute the configured scenario runner as a deterministic process against the implementation branch. No intelligent session is involved.
3. Collect structured output: scenario identifiers and pass/fail results.
4. If any scenario fails: return failure with the failed scenario identifiers to the Daemon Control Plane. The Control Plane delegates diagnosis to the Bug Diagnosis Service to determine whether the failure reflects a spec gap (→ needs-spec-update), an implementation defect (→ fix cycle), or a validation gap (→ needs-human). No automatic fix or label is applied before diagnosis completes.

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

- Validation Service OWNS: review gate definitions, gate sequencing logic, evaluation rubrics, static analysis policy, architecture fitness rules, warmup state, sampling policy, holdout execution orchestration, deployment verification, test execution orchestration.
- Validation Service CALLS: Session Runtime (to spawn Reviewer sessions for gates 2, 3, and 4), Implementation Coordinator (to spawn fix workers when gates or tests fail).
- Validation Service DOES NOT have access to holdout scenario content. It invokes the scenario runner as an opaque deterministic process and receives only identifiers and pass/fail results.
- Validation Service DOES NOT own the test or deployment infrastructure — it invokes configured commands and interprets their output.
- Daemon Control Plane CALLS Validation Service for: the review phase, holdout phase, deploy phase, and test phase.

## Event Flows

**Review flow:**
1. Receive the feature branch reference, spec content, and complexity classification.
2. Gate 1 (deterministic): execute configured automated verification checks as a deterministic process. No intelligent session. This includes: test suite execution, static analysis policy enforcement (complexity thresholds, type safety, formatting), and architecture fitness rule verification (circular dependency detection, boundary enforcement, layer separation). Collect result signal and output. If fail: extract structured failure information, proceed to fix cycle.
3. Gate 2 (spec compliance): spawn a fresh Reviewer session via Session Runtime. The reviewer receives: the implementation diff, the governing spec content (pre-loaded), and a structured rubric. The reviewer independently reads implementation artifacts and verifies every acceptance criterion. It produces structured findings. If fail: proceed to fix cycle.
4. Gate 3 (quality, standard and complex only): spawn a fresh Reviewer session. The reviewer receives: the implementation diff, pattern expectations, and a quality rubric. It evaluates maintainability, pattern consistency, test quality, and convention alignment. If fail: proceed to fix cycle.
5. Gate 4 (security, complex only): spawn a fresh Reviewer session. The reviewer receives: the implementation diff and a security rubric. It evaluates injection risks, authentication gaps, data validation, and concurrency safety. If fail: proceed to fix cycle.
6. All gates pass: check WarmupState. If not graduated (completion count below warmup threshold), hold the result and notify the Operator for approval. If graduated, apply SamplingPolicy: if the work request is selected for sampling, hold for Operator review; otherwise return success.
7. After Operator approval (warmup or sampling): return success. If the Operator provides corrections, capture them via Knowledge Service as high-priority observations. Note: WarmupState completion count is incremented only after the full pipeline completes successfully (by the Daemon Control Plane during the report phase), not after review approval — a work request that passes review but fails holdout, integration, or deployment does not count toward graduation.

**Fix cycle flow:**
1. Collect findings from the failed gate. Record the total finding count for this cycle.
2. Delegate to Implementation Coordinator to spawn a fix worker with the findings as context.
3. After fix: re-run all gates from gate 1 (not from the failed gate — earlier gates must re-validate after changes).
4. Increment fix cycle count. Check termination conditions in order:
   a. If max cycles reached: escalate to stuck.
   b. If the DiminishingReturnsPolicy minimum cycle count has been reached: compare the current cycle's finding count to the previous cycle's. If improvement is below the threshold for two consecutive cycles, escalate to stuck — the system is not making meaningful progress. Log the escalation reason (diminishing returns) distinctly from max-cycles-reached so the Operator can distinguish structural problems from complex-but-tractable ones.

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

**Holdout failure:** Return the failed scenario identifiers to the Daemon Control Plane. The Control Plane delegates to the Bug Diagnosis Service, which classifies using the standard Type A/B/C framework: Type A (implementation defect → targeted fix cycle), Type B (spec gap → needs-spec-update), Type C or low confidence (→ needs-human). The Validation Service does not interpret holdout failures — it only reports them.

**Deployment health timeout:** Retry the deployment up to a configured number of attempts. If all attempts fail: escalate to stuck.

**Test failure:** Enter targeted fix loop. Truncate verbose test output before injecting into fix context. Fix, re-deploy, re-test. Bounded by max fix attempts.

**Max fix cycles exceeded:** Escalate to stuck. The Daemon Control Plane labels the work request and notifies the operator.

**Diminishing returns detected:** Escalate to stuck early (before max fix cycles). The escalation includes the finding count trajectory across cycles so the Operator can see that progress stalled. This is distinct from max-cycles-exceeded — it signals a structural problem rather than exhausted budget.

**Reviewer session timeout:** Treat as a gate failure. Retry the gate (the Session Runtime terminates the process; the Validation Service re-spawns a new reviewer). If retry also times out: escalate.

**Reviewer produces unstructured output:** Treat as a gate failure. Retry once with the same rubric. If the second attempt also fails to produce structured findings: escalate.
