---
id: FUNC-AC-QUALITY
type: functional
domain: runforge
status: draft
version: 4
layer: 1
---

# FUNC-AC-QUALITY — Quality Assurance and Validation

## Problem Statement

Autonomous implementers cannot be trusted to self-certify their work. An implementation that passes its own tests may still violate the spec, introduce security vulnerabilities, or deviate from established patterns. Trust requires independent verification across multiple dimensions, structured evaluation criteria that the implementer cannot influence, and holdout scenarios that the implementer has never seen.

## Actors

- **Operator** — reviews escalated issues
- **Spec Author** — receives cases where the specification must be clarified or extended

## Behavior

**Scenario: Heterogeneous review gates**
- Given a completed implementation
- When the system begins quality assurance
- Then it runs a sequence of distinct assurance stages: automated checks first, then spec compliance review, then implementation quality review, then security review when needed

**Scenario: Automated checks**
- Given an implementation is ready for review
- When quality assurance begins
- Then automated verification checks run before human-like review begins

**Scenario: Spec compliance review**
- Given automated checks have passed
- When spec compliance review begins
- Then the system verifies every acceptance criterion independently rather than trusting the implementation report

**Scenario: Implementation quality review**
- Given spec compliance review has passed
- When implementation quality review begins
- Then the system evaluates maintainability, patterns, test quality, and architectural consistency

**Scenario: Security review**
- Given implementation quality review has passed and the work is complex or security-sensitive
- When security review begins
- Then the system evaluates injection risks, authentication gaps, data validation, and race conditions

**Scenario: Gate failure and fix cycle**
- Given any gate finds issues
- When the system processes the findings
- Then the issues are fixed and all assurance stages re-run from the beginning — up to a configured maximum number of fix cycles, after which the system escalates to the Operator

**Scenario: Simple work review**
- Given a work request classified as simple
- When the system begins quality assurance
- Then only automated checks and spec compliance review run by default

**Scenario: High-risk work review**
- Given a work request affects security-sensitive behavior
- When the system begins quality assurance
- Then security review runs even if the work was classified as simple or standard

**Scenario: Structured evaluation rubric**
- Given the system is assessing an implementation
- When it evaluates quality
- Then it uses structured rubric dimensions (spec compliance, test quality, pattern consistency, security, convention alignment) — not unstructured prose

**Scenario: Reviewer independence**
- Given the system begins an independent assessment
- When it examines the implementation
- Then it evaluates the implementation independently and does not rely on the implementer's account of what was built

**Scenario: Holdout validation**
- Given all review gates have passed
- When holdout validation runs
- Then it executes scenarios that were not available during implementation or review, reporting outcomes without exposing scenario content

**Scenario: Holdout failure**
- Given a holdout scenario fails
- When the system processes the failure
- Then it triggers diagnosis to determine whether the failure reflects a spec gap (Type B), an implementation defect (Type A), or an expectation mismatch (Type C) before further action is taken, and routes specification issues to the Spec Author

**Scenario: Integration review**
- Given all review gates and holdout validation have passed
- When the system prepares to promote the work
- Then it performs a final integration review before the work moves forward

**Scenario: Pre-production verification**
- Given new work has been promoted to a pre-production environment
- When the system verifies that environment
- Then it polls for health confirmation within a configured timeout

**Scenario: Post-deployment testing**
- Given the pre-production environment is healthy after delivery
- When the system runs post-deployment tests (automated functional tests, and interactive tests if applicable)
- Then it captures results and proceeds if all pass

**Scenario: Post-deployment failure and fix loop**
- Given post-deployment tests fail
- When the system processes the failure
- Then it creates a targeted fix, re-deploys, and re-tests — up to a configured maximum number of attempts, after which it escalates

**Scenario: Test output truncation**
- Given test output is verbose
- When the system prepares failure context for a follow-up fix
- Then it truncates the output to only the relevant failure excerpt to prevent context flooding

**Scenario: Diminishing returns awareness**
- Given the system has already attempted multiple fix cycles on the same issue
- When the marginal improvement per cycle decreases
- Then the system escalates sooner rather than exhausting all configured fix cycles — speed and cost matter alongside completeness

**Scenario: Graduated escalation**
- Given repeated failures on the same issue
- When the failure count crosses a threshold
- Then the system escalates rather than continuing to spend resources on a structural problem

### Static Analysis

**Scenario: Static analysis as a hard gate**
- Given an implementation is ready for review
- When automated checks run
- Then they enforce configurable thresholds for complexity (maximum per-function complexity, maximum function length, maximum artifact size), strict type safety (no untyped escape hatches), and formatting — violations fail the gate before any review begins

**Scenario: Architecture fitness functions**
- Given the system performs automated checks
- When it evaluates structural rules
- Then it verifies that no circular dependencies exist between modules, service boundaries are respected (no cross-boundary imports), and layer separation is maintained — structural drift is caught deterministically, not by review

### Trust Calibration

**Scenario: Quality assurance feeds the earned-trust decision but never grants autonomy**
- Given a completed work request that has passed all applicable review gates
- When the system considers whether the work may proceed without the Operator
- Then quality assurance never by itself grants autonomous promotion; whether the work may proceed is the earned-trust decision — held per deployment, per risk class, and per lane (see FUNC-AC-MERGE-DECISION) and gated by the verifier precondition (see FUNC-AC-VERIFIER-GATE) — and quality assurance only contributes the demonstrated-quality track record those decisions consume; no count of completed work here widens autonomy for any risk class or lane

**Scenario: A deployment has earned zero autonomous action at switch-on**
- Given a deployment that has just been brought online
- When any completed work passes all review gates
- Then it is held for the Operator regardless of risk class or lane — a deployment earns zero autonomous action at switch-on, and this is widened only by the earned-trust decision (see FUNC-AC-MERGE-DECISION), never relaxed by a count of completed work

**Scenario: A broken autonomy substrate withholds autonomy across all lanes**
- Given a signal that the foundation autonomous action depends on is unsound — the wiring of the independent verifiers, the boundary that keeps privileges and work identity correct, the durable record that keeps promotions and rollbacks reversible and auditable, or the configuration shared across lanes
- When any work would otherwise be eligible to proceed without the Operator
- Then the system withholds autonomous promotion across every lane and risk class until the foundation is shown sound again, and records the reason — this is a single global signal that can only remove or withhold autonomy, never grant it

**Scenario: A lane is warmup-eligible only if its verifier can demonstrably fail**
- Given a lane whose work is demonstrating quality toward earned autonomy
- When the system establishes whether that lane may participate in warmup at all
- Then the lane is warmup-eligible only if its verifier can be shown to return a failing verdict on bad outcomes (see FUNC-AC-VERIFIER-GATE); until that is proven, the lane is treated as green-only — it may demonstrate quality on the lowest-risk work alone and accrues no track record toward any higher risk class

**Scenario: Periodic random sampling after autonomy is earned**
- Given a deployment that has earned autonomous promotion for a risk class and lane (see FUNC-AC-MERGE-DECISION)
- When work of that class completes all review gates
- Then a configurable percentage of completed work is flagged for Operator review — catching systematic blind spots that all review gates may share

**Scenario: Sampling feedback**
- Given the Operator reviews a sampled work request and finds issues
- When corrections are applied
- Then the corrections feed back into the learning system with elevated priority (see FUNC-AC-LEARNING)

**Scenario: Sampled corrections withdraw earned autonomy**
- Given a deployment that has earned autonomous promotion for a risk class
- When a configurable number of consecutive sampled reviews reveal corrections from the Operator
- Then the system withdraws that earned autonomy and reverts the risk class to mandatory Operator approval until quality is re-demonstrated — autonomy withdrawn this way is restored only by re-earning it (see FUNC-AC-MERGE-DECISION)

**Scenario: Minimum sampling floor**
- Given the Operator configures the sampling percentage
- When the configured value is below a minimum floor
- Then the system enforces the minimum floor — post-earning human oversight cannot be fully disabled

### Holdout Scenario Management

**Scenario: Operator maintains holdout scenarios**
- Given the system uses holdout validation as a trust mechanism
- When the Operator creates or updates holdout scenarios
- Then the scenarios are stored externally and executed via a configured command that returns structured results

**Scenario: Holdout scenarios are structurally inaccessible**
- Given holdout scenarios exist for a repository
- When autonomous work executes (implementation or review)
- Then the scenarios are structurally excluded from the work environment — not merely hidden by instruction but inaccessible at the workspace level (see FUNC-AC-SAFETY)

**Scenario: Holdout scenario evolution**
- Given the system has been operating for some time
- When the Operator reviews holdout effectiveness
- Then they can add, modify, or retire scenarios without affecting in-progress work — changes apply to the next validation cycle

### Review Modes

**Scenario: Assigned quality review**
- Given a work item has completed implementation
- When the pipeline submits it for quality review
- Then the reviewer receives relevant findings for the reviewed area (injected from the knowledge store)
- And reviews the specific implementation against its spec, acceptance criteria, and quality standards
- And produces a pass/fail verdict with structured feedback
- And writes discovered issues as candidate observations pending Operator approval before they become permanent knowledge

**Scenario: Proactive codebase review**
- Given the proactive review agent's scheduled cycle triggers
- When it scans a codebase area
- Then it identifies issues (bugs, spec drift, security concerns, quality regression) independently of any active work item
- And records findings that feed the Tech Lead's signal analysis
- And the system never dispatches proactive review work through the pipeline gate — the two modes are independent

**Scenario: Proactive review work detection boundary**
- Given the proactive review agent has created a finding
- When the work detection system scans for executable work
- Then it excludes untriaged review findings from the executable scan
- And findings follow the triage lifecycle: Tech Lead triages (approve/reject/promote/defer) → PO recommends or rejects → Operator confirms → finding becomes executable work
- And findings labeled `auto-fix-approved` by the Operator bypass the triage lifecycle entirely

## Success Criteria

- Every implementation passes all applicable review gates before proceeding
- Holdout scenarios are never available during implementation or review — isolation is what makes validation trustworthy
- Holdout failures trigger diagnosis instead of being auto-classified or auto-fixed
- First implementations become reference standards for consistency (see FUNC-AC-LEARNING)
- Quality assurance never grants autonomous promotion by itself; autonomy is earned per deployment, per risk class, and per lane behind a usable verifier (see FUNC-AC-MERGE-DECISION and FUNC-AC-VERIFIER-GATE), and the only global trust signal quality assurance holds can withhold autonomy but never grant it

## Constraints

- Work under review cannot alter the criteria it is judged against
- Review is based on independent artifact reading and verification rather than trusting implementation claims
- Holdout scenarios remain inaccessible during implementation and review, not merely hidden by instruction
- Escalation is graduated, not binary — repeated identical failures escalate faster than novel failures
- Complexity classification determines the default review depth, but risk-sensitive work still receives the review gates needed for safe delivery
- Static analysis thresholds are deterministic and cannot be overridden by implementation work
- The system does not operate with full autonomy from day one, and quality assurance never by itself grants it: autonomous promotion is earned per deployment, per risk class, and per lane behind a usable verifier (see FUNC-AC-MERGE-DECISION and FUNC-AC-VERIFIER-GATE) — there is no global count of completed work that, once reached, lets work proceed across risk classes
- Quality assurance holds exactly one global trust signal and it is subtractive only: a deployment earns zero autonomous action at switch-on, and when the foundation autonomous action depends on (the verifier wiring, the privilege-and-identity boundary, the promotion-and-rollback audit record, the cross-lane configuration) is unsound, the signal withholds autonomy across all lanes and risk classes; this signal can only withhold or withdraw autonomy, never grant it
- A lane builds a warmup track record toward any risk class above the lowest only if its verifier can be shown to fail on bad outcomes; until proven, it is treated as green-only and accrues no track record toward higher risk classes
- Human oversight after autonomy is earned cannot be fully disabled: the sampling percentage has an enforced minimum floor, and a sustained run of sampled corrections withdraws earned autonomy until it is re-earned
