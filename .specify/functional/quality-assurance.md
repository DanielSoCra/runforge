---
id: FUNC-AC-QUALITY
type: functional
domain: auto-claude
status: draft
version: 1
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
- Then it triggers diagnosis to determine whether the failure reflects a spec gap, an implementation defect, or a validation gap before further action is taken, and routes specification issues to the Spec Author

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
