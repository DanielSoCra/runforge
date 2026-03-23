---
id: FUNC-AC-QUALITY
type: functional
domain: auto-claude
status: draft
version: 3
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

**Scenario: Warmup period**
- Given the system has completed fewer than a configurable number of work requests (the warmup threshold)
- When a work request passes all review gates
- Then it still requires explicit Operator approval before promotion — the system earns autonomous promotion rights by demonstrating quality during warmup, not by default

**Scenario: Warmup graduation**
- Given the system has completed the warmup threshold of work requests with Operator approval
- When the next work request passes all review gates
- Then it proceeds without mandatory Operator approval — the warmup period is complete

**Scenario: Periodic random sampling**
- Given the system has graduated from warmup
- When work requests complete all review gates
- Then a configurable percentage of completed work is flagged for Operator review — catching systematic blind spots that all review gates may share

**Scenario: Sampling feedback**
- Given the Operator reviews a sampled work request and finds issues
- When corrections are applied
- Then the corrections feed back into the learning system with elevated priority (see FUNC-AC-LEARNING)

**Scenario: Warmup regression**
- Given the system has graduated from warmup
- When a configurable number of consecutive sampled reviews reveal corrections from the Operator
- Then the system reverts to warmup mode — requiring mandatory Operator approval again until quality is re-demonstrated

**Scenario: Minimum sampling floor**
- Given the Operator configures the sampling percentage
- When the configured value is below a minimum floor
- Then the system enforces the minimum floor — post-warmup human oversight cannot be fully disabled

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
- Then it excludes review findings from the executable scan
- And findings only become executable work when the Tech Lead proposes remediation, the PO approves, the operator approves, and a new work request is created with executable labels

## Success Criteria

- Every implementation passes all applicable review gates before proceeding
- Holdout scenarios are never available during implementation or review — isolation is what makes validation trustworthy
- Holdout failures trigger diagnosis instead of being auto-classified or auto-fixed
- First implementations become reference standards for consistency (see FUNC-AC-LEARNING)

## Constraints

- Work under review cannot alter the criteria it is judged against
- Review is based on independent artifact reading and verification rather than trusting implementation claims
- Holdout scenarios remain inaccessible during implementation and review, not merely hidden by instruction
- Escalation is graduated, not binary — repeated identical failures escalate faster than novel failures
- Complexity classification determines the default review depth, but risk-sensitive work still receives the review gates needed for safe delivery
- Static analysis thresholds are deterministic and cannot be overridden by implementation work
- The system does not operate with full autonomy from day one — it must demonstrate quality during a warmup period before earning autonomous promotion rights
