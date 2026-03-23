---
id: ARCH-AC-VALIDATION
type: architecture
domain: auto-claude
status: draft
version: 3
layer: 2
references: FUNC-AC-QUALITY
---

# ARCH-AC-VALIDATION — Validation Service

## Purpose

The Validation Service provides independent verification of implementations through a sequence of heterogeneous review gates, holdout scenario execution, integration review, and post-deployment testing. It also provides scheduled exploratory review of codebase areas independent of any active work item. These two review modes — assigned quality review (pipeline gate) and proactive codebase review (scheduled exploration) — share review infrastructure but differ in trigger, scope, output, and downstream consumer.

The Validation Service ensures that no implementation is promoted without passing deterministic checks, spec compliance verification, quality evaluation, and (for complex work) security review. Holdout scenarios are executed as an opaque deterministic process that the Validation Service invokes but never inspects. After all review gates and holdout validation pass, a final integration review confirms the work is ready for promotion. Proactive review findings feed technical leadership signal analysis and are explicitly excluded from executable work detection.

## System Context

The Validation Service operates within the daemon process as a logical boundary, not a separate deployment. It sits between the implementation phase (upstream) and the deployment phase (downstream) in the pipeline lifecycle.

**Upstream callers:**
- **Daemon Control Plane** — invokes the Validation Service for the review phase, holdout phase, integration review phase, deploy phase, and test phase during the assigned pipeline flow. The Control Plane owns the pipeline state machine; the Validation Service owns the verification logic.
- **Coordination Service** — invokes the Validation Service for proactive review sessions on the Reviewer Agent's scheduled cycle. The Coordination Service owns scheduling and area selection; the Validation Service owns the review session mechanics.

**Downstream dependencies:**
- **Session Runtime** — the Validation Service spawns reviewer sessions (for intelligent gates 2, 3, 4 and for proactive review) through the Session Runtime. Each session is independent, fresh-context, and cannot alter its own evaluation criteria.
- **Implementation Coordinator** — when a gate or test fails, the Validation Service delegates fix creation to the Implementation Coordinator, which spawns a fix worker.
- **Knowledge Service** — the Validation Service queries for active knowledge records (for injection into reviewer sessions) and stores observations and findings produced by review sessions.
- **Bug Diagnosis Service** — holdout failures are returned to the Daemon Control Plane, which delegates diagnosis to the Bug Diagnosis Service. The Validation Service does not interpret holdout failures.

**External processes:**
- **Scenario Runner** — an Operator-configured external command that executes holdout scenarios. The Validation Service invokes it as an opaque deterministic process and receives only identifiers and pass/fail results. Scenario content never enters the Validation Service's address space (see Holdout Structural Isolation).
- **Deployment Target** — an Operator-configured deployment command and health verification endpoint. The Validation Service triggers deployment and polls for health.
- **Test Commands** — Operator-configured test suites executed against the deployed environment.

## Data Model

### Review Mode

**ReviewMode** discriminates how a review session was triggered: `assigned` (pipeline gate — a specific work product is evaluated for pass/fail) or `proactive` (scheduled exploration — a codebase area is scanned for issues independent of any work item).

### Assigned Review (Pipeline Gate)

**ReviewGate** represents a single verification step in assigned mode. It contains: a gate type (deterministic, spec-compliance, quality, or security), a status (pending, running, passed, or failed), and an array of findings (each with a severity, location, and description). Deterministic gates have no findings on success; intelligent gates always produce structured findings.

**ReviewRound** represents a complete pass through all applicable gates in assigned mode. It contains: an ordered array of ReviewGates, the fix attempt number (starting at zero for the first pass), and a timestamp.

**GateSequence** defines which gates apply based on complexity and risk. Default mapping: simple maps to gates 1 and 2, standard maps to gates 1 through 3, complex maps to all 4 gates. Risk override: if the work request is flagged as security-sensitive, gate 4 (security) is included regardless of complexity classification. Gate selection uses the maximum of complexity-required gates and risk-required gates.

**RiskDetection** determines whether a work request is security-sensitive. Three signals are checked:
- Explicit labeling: the work request carries a security-sensitive label or tag set by the Spec Author.
- Spec content: the referenced specifications mention authentication, authorization, payment processing, credential handling, data encryption, or access control.
- Artifact location: the expected artifact locations overlap with configured security-sensitive paths (e.g., authentication modules, payment handlers, permission systems).
Any one signal is sufficient to flag the request as risk-sensitive. The Operator configures the security-sensitive path patterns and keyword lists.

**FixCycle** tracks a fix-and-re-review iteration. It contains: the review round that produced findings, the fix attempt number, a reference to the worker session that performed the fix, and the finding count for this round (total number of findings across all gates). Fix cycles are bounded by a configured maximum, by diminishing returns detection, and by graduated escalation.

**DiminishingReturnsPolicy** defines early escalation when fix cycles stop making meaningful progress. It contains: a minimum cycle count before evaluation begins (default: 2 — at least two fix cycles must complete before diminishing returns can be assessed), and an improvement threshold (configurable percentage, default: 20% — if the finding count does not decrease by at least this percentage compared to the previous cycle, progress is considered stalled). When two consecutive cycles show improvement below the threshold, the Validation Service escalates to stuck without exhausting remaining fix cycles. This prevents the system from spending resources on a structural problem that incremental fixes cannot resolve.

**GraduatedEscalationPolicy** defines accelerated escalation when the same issue recurs across fix cycles. It contains: a failure identity function (maps a finding to a canonical key based on its location, category, and description — so the same logical issue across cycles is recognized as identical), a repeat threshold (configurable, default: 2 — when the same failure identity appears in this many consecutive cycles without resolution, escalation is triggered), and an escalation mode (stuck with reason `repeated-identical-failure`). This is distinct from DiminishingReturnsPolicy: diminishing returns detects when overall progress slows (aggregate finding count), while graduated escalation detects when specific individual failures persist unchanged. Repeated identical failures indicate a structural problem that incremental fixes cannot resolve, so the system escalates faster than it would for novel failures that show partial progress.

**EvaluationRubric** defines structured dimensions for intelligent review gates. Spec compliance uses dimensions: acceptance criteria coverage, behavioral correctness, constraint adherence. Quality uses dimensions: maintainability, pattern consistency, test quality, convention alignment. Security uses dimensions: injection resistance, authentication completeness, data validation, concurrency safety. The same rubric dimensions are available to proactive review sessions (see below), though proactive sessions use them exploratorily rather than against a specific acceptance criteria set.

**StaticAnalysisPolicy** defines deterministic code quality thresholds enforced during gate 1 (automated checks). It contains: maximum cyclomatic complexity per function, maximum function length (lines), maximum artifact size (lines), forbidden type-safety escape patterns (e.g., untyped casts, suppression comments), and required formatting rules. These thresholds are configurable by the Operator and enforced deterministically — no intelligent session can override them.

**ArchitectureFitnessRule** defines a structural invariant verified during gate 1. It contains: a rule name, a description, a verification method (deterministic check or command), and the expected result. Built-in rules include: no circular dependencies between modules, no cross-boundary imports violating service ownership, and layer separation enforcement. The Operator can add project-specific rules.

### Proactive Review (Scheduled Exploration)

**ProactiveReviewScope** defines the target of a proactive review session. It contains: an array of codebase area patterns (file path globs), a scan focus (one of: general, spec-drift, security, quality-regression), and a selection rationale (why this area was chosen — e.g., least-recently-scanned, high-churn, many open findings).

**ProactiveReviewFinding** represents a single issue discovered during proactive review. It contains: a severity (critical, high, medium, low), a location (file path and line range), a category (bug, spec-drift, security-concern, quality-regression, convention-violation), a description, and an array of evidence references (specific code snippets or spec references supporting the finding). Proactive review findings are NOT verdicts — they are signal inputs for technical leadership.

**ProactiveReviewResult** represents the outcome of a proactive review session. It contains: the scope that was reviewed, an array of ProactiveReviewFindings, a scan summary (areas covered, time spent), and a timestamp. Unlike assigned review, there is no pass/fail verdict.

### Knowledge Interaction

**KnowledgeInjection** defines knowledge records provided to a reviewer session at start. It contains: an array of matching knowledge records (queried by artifact location from the Knowledge Service), the review mode (assigned or proactive), and the session type filter used for the query. For assigned review, records are filtered to the reviewed area's artifact locations. For proactive review, records are filtered to the scan scope's codebase area patterns. Injection allows reviewers to focus attention on known problem areas.

**KnowledgeWriteBack** defines knowledge records produced by a review session. It contains: the review mode, the source session identifier, and an array of observations (each with artifact patterns, description, severity, and an optional root-cause tag). The record type and lifecycle status depend on the review mode:
- Assigned review: observations are stored as record type `technical_pitfall` with lifecycle status `candidate` (requires Operator approval before injection). This ensures discovered issues during QA do not bypass the approval gate.
- Proactive review: observations are stored as record type `review_finding` with lifecycle status `active` (immediately available for technical leadership consumption). This reflects the L1 requirement that proactive findings feed the Tech Lead's signal analysis without delay.

### Work Detection Boundary

**WorkDetectionExclusion** is a policy enforced by the Coordination Service (not the Validation Service) that excludes proactive review findings from the executable work scan. The Validation Service's role is to produce findings with the correct record type (`review_finding`) so that downstream systems can distinguish them from executable work. The Coordination Service and Control Plane are responsible for honoring the exclusion. A proactive review finding becomes executable work only when: the Tech Lead proposes remediation, the Product Owner approves the priority, the Operator approves the work request, and a new issue with executable labels is created. This preserves the L0 boundary: the system never acts on self-generated findings without Operator approval.

### Trust Calibration

**WarmupState** tracks the system's trust calibration. It contains: the warmup threshold (configurable number of successful completions required), the current completion count, a graduated flag (true once the threshold is reached), a consecutive correction count (tracking how many consecutive sampled reviews required Operator corrections), and a regression threshold (configurable, default: 3 consecutive corrections triggers regression to warmup). During warmup, every work request that passes all review gates requires explicit Operator approval before promotion. After graduation, the system promotes autonomously (subject to random sampling). If the consecutive correction count reaches the regression threshold, the graduated flag is reset to false and the completion count is reset — the system must re-earn trust.

**SamplingPolicy** defines post-warmup review sampling. It contains: a sampling rate (configurable percentage of completed work requests flagged for Operator review, default 10%), a minimum sampling floor (configurable, default: 1% — the sampling rate cannot be set below this value), and a sampling method (random selection). Sampled work requests are held until the Operator reviews and approves or provides corrections. When the Operator approves without corrections, the WarmupState's consecutive correction count is reset to zero. When corrections are provided, the consecutive correction count is incremented.

### Holdout Scenario Management

**HoldoutResult** represents the outcome of holdout scenario execution. It contains: a scenario identifier and a pass/fail indicator. The Validation Service never receives or stores scenario content — only identifiers and results.

**HoldoutStructuralIsolation** defines how holdout scenarios are kept structurally inaccessible during implementation and review. The isolation mechanism has three layers:
- **Workspace exclusion:** The Session Runtime excludes the scenario storage location from the workspace environment provided to implementation and review sessions. Scenarios are not merely hidden by instruction — they are physically absent from the workspace filesystem. This is a dependency on FUNC-AC-SAFETY's containment model (see ARCH-AC-SESSION-RUNTIME for the structural enforcement mechanism).
- **Process boundary:** The scenario runner executes as a separate deterministic process invoked by the Validation Service. The runner receives a branch reference and returns structured results. No intelligent session is involved in scenario execution, so no session can observe scenario content.
- **Data boundary:** The Validation Service's holdout API accepts and returns only scenario identifiers and pass/fail results. Scenario content never enters the Validation Service's data model, logs, or error messages.

**HoldoutScenarioVersioning** defines how scenario changes are isolated from in-progress work. It contains: a scenario set version identifier (opaque to the Validation Service — managed by the scenario runner), and a version-binding rule. The version-binding rule states: when a pipeline run begins its holdout phase, it executes against the scenario set version that was current at the time the holdout command is invoked. The Operator can add, modify, or retire scenarios at any time; changes take effect on the next holdout invocation, not on any in-progress invocation. The scenario runner is responsible for maintaining version integrity — the Validation Service treats the runner as a black box and does not manage scenario versions itself. This ensures that scenario changes never affect in-progress work.

**DeploymentCheck** represents post-deployment verification. It contains: a health status (healthy, unhealthy, or timeout), an array of test results (each with a test name and pass/fail), the fix attempt number, and a timestamp.

### Integration Review

**IntegrationReviewResult** represents the outcome of a final integration review performed after all review gates and holdout validation have passed. It contains: a status (passed or failed), an array of integration findings (each with a severity, description, and affected area), and a timestamp. Integration review evaluates cross-cutting concerns that individual gate reviews may miss: consistency between the implementation and broader system behavior, interactions with recently merged work, and alignment with the overall architecture.

## API Contract

### Assigned Review

**Review** — Called by the Daemon Control Plane. Request: feature branch reference, governing spec content, complexity classification, risk-sensitive flag, max fix cycles. Response: passed (all gates clear), failed-and-fixed (passed after fix cycles, with fix count), or escalated (max fix cycles exceeded).

The review operation proceeds:
1. Query the Knowledge Service for active knowledge records matching the reviewed area's artifact locations, filtered to record types consumed by review sessions. Assemble a KnowledgeInjection context.
2. Determine the gate sequence based on complexity classification and risk-sensitive flag (see GateSequence). If risk-sensitive, include gate 4 regardless of complexity.
3. Execute gates in order. Gate 1 includes static analysis policy enforcement and architecture fitness rule verification. If any gate fails, stop the sequence. Intelligent gates (2, 3, 4) receive the KnowledgeInjection context alongside their rubric and implementation artifacts.
4. On gate failure: delegate fix creation to the Implementation Coordinator (which spawns a fix worker), then re-run all gates from gate 1.
5. Repeat until all gates pass or max fix cycles is reached.
6. After all gates pass: assemble a KnowledgeWriteBack from any observations the reviewer sessions produced. Submit to the Knowledge Service with record type `technical_pitfall` and lifecycle status `candidate`.
7. Check WarmupState. If not graduated, hold for Operator approval. If graduated, check SamplingPolicy — if sampled, hold for Operator review. Otherwise, return passed.

### Proactive Review

**ProactiveReview** — Called by the Coordination Service on a scheduled cycle. Request: codebase area patterns, scan focus, relevant knowledge records (pre-queried by the Coordination Service from the Knowledge Service). Response: a ProactiveReviewResult containing findings.

The proactive review operation proceeds:
1. Assemble the ProactiveReviewScope from the request parameters.
2. Spawn a fresh reviewer session via Session Runtime. The session receives: the codebase area to scan, the scan focus, injected knowledge records for the area, and the evaluation rubric dimensions (used exploratorily, not as acceptance criteria).
3. The reviewer independently reads artifacts within the scope and identifies issues across categories: bugs, spec drift, security concerns, quality regression, convention violations.
4. Collect structured findings from the session output. Each finding includes severity, location, category, description, and evidence references.
5. Assemble a KnowledgeWriteBack from the findings. Submit to the Knowledge Service with record type `review_finding` and lifecycle status `active`.
6. Return the ProactiveReviewResult to the Coordination Service.

The proactive review operation has no gate sequence, no fix cycles, no pass/fail verdict, and no warmup/sampling interaction. It is purely exploratory. The Coordination Service is responsible for scheduling, area selection strategy, and routing findings to technical leadership.

### Holdout

**Holdout** — Called by the Daemon Control Plane. Request: branch reference, scenario runner command (may be absent if no scenario runner is configured). Response: all-passed, skipped (no runner configured), or failed with an array of scenario identifiers that failed (never scenario content).

The holdout operation proceeds:
1. If no scenario runner is configured: return skipped. The pipeline continues without holdout validation, but a warning is logged. Holdout is strongly recommended but not mandatory — projects without scenarios yet can still use the system.
2. Execute the configured scenario runner as a deterministic process against the implementation branch. No intelligent session is involved. The scenario runner manages its own scenario set versioning — the Validation Service does not select or filter scenarios.
3. Collect structured output: scenario identifiers and pass/fail results.
4. If any scenario fails: return failure with the failed scenario identifiers to the Daemon Control Plane. The Control Plane delegates diagnosis to the Bug Diagnosis Service to determine whether the failure reflects a spec gap (needs-spec-update), an implementation defect (fix cycle), or a validation gap (needs-human). No automatic fix or label is applied before diagnosis completes.

### Integration Review

**IntegrationReview** — Called by the Daemon Control Plane after all review gates and holdout validation have passed. Request: feature branch reference, governing spec content, recently merged branches (for cross-cutting analysis). Response: passed or failed with integration findings.

The integration review operation proceeds:
1. Spawn a fresh reviewer session via Session Runtime. The session receives: the implementation diff, the governing spec content, references to recently merged work on the target branch, and the KnowledgeInjection context.
2. The reviewer evaluates: consistency between the implementation and the broader system, interactions with recently merged work (merge-order effects, shared state conflicts), and alignment with the overall architecture.
3. If the integration review passes: return success. The work is ready for promotion to warmup/sampling or autonomous promotion.
4. If the integration review fails: return failure with structured integration findings. The Daemon Control Plane enters a fix cycle (same mechanics as gate failure fix cycles).

### Deploy

**Deploy** — Called by the Daemon Control Plane. Request: branch reference, deployment command, health verification target, health verification timeout. Response: healthy, or failed with details.

The deploy operation proceeds:
1. Trigger the configured deployment process.
2. Poll the health verification target at regular intervals until healthy or timeout.
3. Return the health status.

### Test

**Test** — Called by the Daemon Control Plane. Request: test commands (automated functional tests, interactive tests if applicable), max fix attempts. Response: all-passed, failed-and-fixed (with fix count), or escalated.

The test operation proceeds:
1. Execute configured test commands against the deployed environment.
2. On failure: create a targeted fix (delegate to Implementation Coordinator), re-deploy, re-test.
3. Repeat until all tests pass or max fix attempts is reached.

## System Boundaries

- Validation Service OWNS: review gate definitions, gate sequencing logic, evaluation rubrics, static analysis policy, architecture fitness rules, warmup state, sampling policy, holdout execution orchestration (including structural isolation enforcement at the data boundary), integration review orchestration, deployment verification, test execution orchestration, proactive review session orchestration, knowledge injection assembly for review sessions, knowledge write-back production for both review modes, graduated escalation policy, diminishing returns policy.
- Validation Service CALLS: Session Runtime (to spawn reviewer sessions for assigned gates 2, 3, and 4, for integration review, and for proactive review sessions), Implementation Coordinator (to spawn fix workers when gates, integration review, or tests fail), Knowledge Service (to query matching records for injection, and to store observations and findings produced by review sessions).
- Validation Service DOES NOT have access to holdout scenario content. It invokes the scenario runner as an opaque deterministic process and receives only identifiers and pass/fail results. Structural isolation is enforced jointly with Session Runtime (workspace exclusion) and the scenario runner (process and version isolation).
- Validation Service DOES NOT own the test or deployment infrastructure — it invokes configured commands and interprets their output.
- Validation Service DOES NOT own proactive review scheduling or area selection — the Coordination Service decides when and where to scan. The Validation Service executes the review session and returns findings.
- Validation Service DOES NOT enforce the work detection boundary — it produces findings with the correct record type (`review_finding`) so downstream systems (Coordination Service, Control Plane) can distinguish them from executable work.
- Validation Service DOES NOT manage holdout scenario versions — the scenario runner is responsible for version integrity. The Validation Service treats the runner as a black box.
- Daemon Control Plane CALLS Validation Service for: the review phase, holdout phase, integration review phase, deploy phase, and test phase (all in assigned mode).
- Coordination Service CALLS Validation Service for: proactive review sessions (on the Reviewer Agent's scheduled cycle).

## Event Flows

### Assigned review flow

1. Receive the feature branch reference, spec content, and complexity classification.
2. Query Knowledge Service for active records matching the reviewed area's artifact locations. Assemble KnowledgeInjection context with records sorted by priority tier then relevance.
3. Gate 1 (deterministic): execute configured automated verification checks as a deterministic process. No intelligent session. This includes: test suite execution, static analysis policy enforcement (complexity thresholds, type safety, formatting), and architecture fitness rule verification (circular dependency detection, boundary enforcement, layer separation). Collect result signal and output. If fail: extract structured failure information, proceed to fix cycle.
4. Gate 2 (spec compliance): spawn a fresh reviewer session via Session Runtime. The reviewer receives: the implementation diff, the governing spec content (pre-loaded), a structured rubric, and the KnowledgeInjection context. The reviewer independently reads implementation artifacts and verifies every acceptance criterion. It produces structured findings and may produce observations (issues discovered beyond the rubric scope). If fail: proceed to fix cycle.
5. Gate 3 (quality, standard and complex only): spawn a fresh reviewer session. The reviewer receives: the implementation diff, pattern expectations, a quality rubric, and the KnowledgeInjection context. It evaluates maintainability, pattern consistency, test quality, and convention alignment. If fail: proceed to fix cycle.
6. Gate 4 (security, complex only or risk-sensitive): spawn a fresh reviewer session. The reviewer receives: the implementation diff, a security rubric, and the KnowledgeInjection context. It evaluates injection risks, authentication gaps, data validation, and concurrency safety. If fail: proceed to fix cycle.
7. All gates pass: collect observations from all reviewer sessions. Submit to Knowledge Service as KnowledgeWriteBack (record type: `technical_pitfall`, lifecycle status: `candidate`). These require Operator approval before becoming available for injection.
8. Proceed to holdout validation (see Holdout flow). If holdout fails, the Daemon Control Plane handles diagnosis and routing.
9. After holdout passes: proceed to integration review (see Integration review flow). If integration review fails, enter fix cycle.
10. After integration review passes: check WarmupState. If not graduated (completion count below warmup threshold), hold the result and notify the Operator for approval. If graduated, apply SamplingPolicy: if the work request is selected for sampling, hold for Operator review; otherwise return success.
11. After Operator approval (warmup or sampling): return success. If the Operator provides corrections, capture them via Knowledge Service as high-priority operator corrections. Note: WarmupState completion count is incremented only after the full pipeline completes successfully (by the Daemon Control Plane during the report phase), not after review approval — a work request that passes review but fails holdout, integration, or deployment does not count toward graduation.

### Proactive review flow

1. Receive codebase area patterns, scan focus, and pre-queried knowledge records from the Coordination Service.
2. Assemble ProactiveReviewScope: validate area patterns, confirm scan focus.
3. Spawn a fresh reviewer session via Session Runtime. The session receives: the codebase area to scan, the scan focus, the injected knowledge records, and the evaluation rubric dimensions (quality, security, spec-compliance — used exploratorily). The session has no knowledge of any active work item or pipeline state.
4. The reviewer independently reads artifacts within the scope. It identifies issues across all categories: bugs, spec drift, security concerns, quality regression, convention violations. For each finding, it provides severity, location, category, description, and evidence references.
5. Collect structured findings from the session output. Assemble ProactiveReviewResult.
6. Submit findings to Knowledge Service as KnowledgeWriteBack (record type: `review_finding`, lifecycle status: `active`). Findings are immediately available for consumption by technical leadership sessions.
7. Return ProactiveReviewResult to the Coordination Service. The Coordination Service routes findings to the Tech Lead's signal analysis. The system never dispatches proactive review findings as executable work through the pipeline gate.

### Work detection boundary enforcement

1. Proactive review findings are stored in the Knowledge Service with record type `review_finding`.
2. The Coordination Service's work detection scan queries for executable work (issues with `ready` labels, feature pipeline labels, etc.). The scan explicitly excludes `review_finding` records from the executable work set.
3. A `review_finding` transitions to executable work only through the following chain: the Tech Lead reads the finding during signal analysis, proposes remediation as a technical debt proposal, the Product Owner evaluates priority and forwards to the Operator (or rejects), the Operator approves, and a new issue with executable labels is created.
4. This chain preserves the L0 boundary: the system never acts on self-generated findings without Operator approval. The Validation Service's responsibility ends at producing correctly typed findings. The Coordination Service, Product Owner, Tech Lead, and Operator are responsible for the promotion chain.

### Fix cycle flow

1. Collect findings from the failed gate (or integration review). Record the total finding count for this cycle. For each finding, compute its failure identity (canonical key based on location, category, and description).
2. Delegate to Implementation Coordinator to spawn a fix worker with the findings as context.
3. After fix: re-run all gates from gate 1 (not from the failed gate — earlier gates must re-validate after changes). If the fix cycle was triggered by integration review failure, re-run from integration review only (gates and holdout already passed).
4. Increment fix cycle count. Check termination conditions in order:
   a. If max cycles reached: escalate to stuck.
   b. Graduated escalation check: compare each finding's failure identity against previous cycles. If any individual failure identity has appeared in the configured number of consecutive cycles (default: 2) without resolution, escalate to stuck immediately with reason `repeated-identical-failure`. This catches structural problems faster than aggregate metrics.
   c. Diminishing returns check: if the DiminishingReturnsPolicy minimum cycle count has been reached, compare the current cycle's total finding count to the previous cycle's. If improvement is below the threshold for two consecutive cycles, escalate to stuck — the system is not making meaningful progress. Log the escalation reason (diminishing returns) distinctly from max-cycles-reached and from repeated-identical-failure so the Operator can distinguish the three escalation causes.

### Holdout flow

1. Receive branch reference and scenario runner command.
2. Execute the scenario runner as a deterministic process. The runner receives the branch reference and returns structured output (scenario identifiers with pass/fail). The runner manages scenario set versioning internally — changes the Operator makes to scenarios take effect on the next invocation, not on any in-progress invocation.
3. Parse results. If all pass: return success. If any fail: return failure with failed scenario identifiers. Never expose scenario content.

### Integration review flow

1. Receive the feature branch reference, spec content, and references to recently merged branches on the target branch.
2. Spawn a fresh reviewer session via Session Runtime. The session receives: the implementation diff, the governing spec content, a summary of recently merged work, and the KnowledgeInjection context.
3. The reviewer evaluates cross-cutting concerns: consistency between the implementation and broader system behavior, interactions with recently merged work, and alignment with the overall architecture.
4. If the reviewer produces no findings: return passed. The work is ready for warmup/sampling or autonomous promotion.
5. If findings are produced: return failed with structured integration findings. The Daemon Control Plane enters a fix cycle with integration review as the trigger.

### Deployment verification flow

1. Trigger deployment via configured command.
2. Poll health verification target at configurable intervals.
3. If healthy within timeout: proceed to test phase.
4. If timeout: return deployment failure.

### Post-deployment test flow

1. Execute configured test commands against the deployed environment.
2. If all pass: return success.
3. If any fail: truncate test output (retain only the relevant failure excerpt to prevent context flooding), delegate fix creation to Implementation Coordinator, re-deploy, re-test.
4. Track fix attempts on the run state. If max attempts reached: escalate to stuck.

### Reviewer independence

Each reviewer session starts with a fresh context. It has no knowledge of the implementation process, the worker that built the code, or previous review rounds. It independently reads artifacts and verifies claims. The evaluation rubric is immutable to the session — the reviewer cannot alter its own evaluation criteria. This independence applies to both assigned and proactive review sessions. The only difference is what the session receives: assigned review sessions receive a specific implementation diff and acceptance criteria; proactive review sessions receive a codebase area and an exploratory mandate.

## Operational Constraints

These constraints are derived from L1 (FUNC-AC-QUALITY, lines 209-217) and are binding on the Validation Service architecture:

1. **Criteria immutability:** Work under review cannot alter the criteria it is judged against. Enforced by: the EvaluationRubric is immutable to the reviewer session — the session receives it as read-only input and cannot modify it.
2. **Independent verification:** Review is based on independent artifact reading and verification rather than trusting implementation claims. Enforced by: each reviewer session starts fresh with no knowledge of the implementation process or worker identity.
3. **Holdout structural isolation:** Holdout scenarios remain inaccessible during implementation and review, not merely hidden by instruction. Enforced by: HoldoutStructuralIsolation's three layers — workspace exclusion (Session Runtime), process boundary (external scenario runner), and data boundary (identifiers-only API).
4. **Graduated escalation over binary escalation:** Repeated identical failures escalate faster than novel failures. Enforced by: GraduatedEscalationPolicy, which tracks individual failure identities across cycles and escalates when the same failure recurs without resolution, independent of the aggregate DiminishingReturnsPolicy.
5. **Risk-driven review depth:** Complexity classification determines the default review depth, but risk-sensitive work still receives the review gates needed for safe delivery. Enforced by: RiskDetection and GateSequence's risk override rule — gate 4 (security) is included whenever any risk signal fires, regardless of complexity classification.
6. **Deterministic static analysis:** Static analysis thresholds are deterministic and cannot be overridden by implementation work. Enforced by: StaticAnalysisPolicy thresholds are configured by the Operator and executed as gate 1 (deterministic process, no intelligent session).
7. **Earned autonomy:** The system does not operate with full autonomy from day one — it must demonstrate quality during a warmup period before earning autonomous promotion rights. Enforced by: WarmupState, which requires explicit Operator approval for every work request until the warmup threshold is met, with regression to warmup on consecutive corrections.

## Error Handling

**Gate findings:** Enter fix cycle. Findings are structured (severity, location, description) so the fix worker receives actionable context.

**Holdout failure:** Return the failed scenario identifiers to the Daemon Control Plane. The Control Plane delegates to the Bug Diagnosis Service, which classifies using the standard Type A/B/C framework: Type A (implementation defect, targeted fix cycle), Type B (spec gap, needs-spec-update), Type C or low confidence (needs-human). The Validation Service does not interpret holdout failures — it only reports them.

**Integration review failure:** Enter fix cycle with integration review as the trigger. The fix worker receives integration findings as context. After fix, re-run from integration review only (gates and holdout already passed). Bounded by max fix cycles and subject to graduated escalation and diminishing returns policies.

**Deployment health timeout:** Retry the deployment up to a configured number of attempts. If all attempts fail: escalate to stuck.

**Test failure:** Enter targeted fix loop. Truncate verbose test output before injecting into fix context. Fix, re-deploy, re-test. Bounded by max fix attempts.

**Max fix cycles exceeded:** Escalate to stuck. The Daemon Control Plane labels the work request and notifies the operator.

**Repeated identical failure detected:** Escalate to stuck early (before max fix cycles or diminishing returns detection). The escalation includes the recurring failure identity and the number of consecutive cycles it appeared in. This is distinct from diminishing returns — it signals that a specific structural problem is not being addressed, even when aggregate finding counts may be decreasing.

**Diminishing returns detected:** Escalate to stuck early (before max fix cycles). The escalation includes the finding count trajectory across cycles so the Operator can see that progress stalled. This is distinct from max-cycles-exceeded and from repeated-identical-failure — it signals overall stagnation rather than a specific recurring problem or exhausted budget.

**Reviewer session timeout:** Treat as a gate failure. Retry the gate (the Session Runtime terminates the process; the Validation Service re-spawns a new reviewer). If retry also times out: escalate.

**Reviewer produces unstructured output:** Treat as a gate failure. Retry once with the same rubric. If the second attempt also fails to produce structured findings: escalate.

**Proactive review session failure:** Log the failure. No findings are produced for this cycle. The Coordination Service schedules the next proactive review cycle normally. A failed proactive session does not affect the pipeline or any active work items — it is an independent scheduled process.

**Knowledge injection failure:** If the Knowledge Service is unavailable when assembling injection context, the review session proceeds without injected knowledge records. A warning is logged. The review is still valid — knowledge injection improves reviewer focus but is not required for correctness.

**Knowledge write-back failure:** If the Knowledge Service is unavailable when submitting observations or findings, the write-back is queued for retry. The review result (pass/fail for assigned, findings for proactive) is returned normally. Knowledge persistence is eventually consistent — a temporary outage does not block the review workflow.
