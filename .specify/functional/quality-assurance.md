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

- **Spec Compliance Reviewer** — verifies acceptance criteria are met (intelligent, not human)
- **Quality Reviewer** — evaluates implementation quality, patterns, test coverage (intelligent, not human)
- **Security Reviewer** — evaluates security and edge cases for complex work (intelligent, not human)
- **Validation Engine** — runs holdout scenarios (deterministic, not intelligent)
- **Operator** — reviews escalated issues

## Behavior

**Scenario: Heterogeneous review gates**
- Given a completed implementation on a unified branch
- When the system begins quality assurance
- Then it runs a sequence of different review gates, not identical rounds: deterministic checks first, then spec compliance, then implementation quality, then security (complex work only)

**Scenario: Deterministic gate (gate 1)**
- Given the unified branch is ready for review
- When gate 1 runs
- Then it executes automated verification checks — no intelligent session needed

**Scenario: Spec compliance gate (gate 2)**
- Given gate 1 has passed
- When gate 2 runs
- Then a fresh Spec Compliance Reviewer verifies every acceptance criterion from the spec is met, reading artifacts independently — never trusting the implementer's report

**Scenario: Implementation quality gate (gate 3)**
- Given gate 2 has passed
- When gate 3 runs
- Then a fresh Quality Reviewer evaluates maintainability, patterns, test quality, and architectural consistency

**Scenario: Security gate (gate 4, complex work only)**
- Given gate 3 has passed and the work was classified as complex
- When gate 4 runs
- Then a fresh Security Reviewer evaluates injection risks, authentication gaps, data validation, and race conditions

**Scenario: Gate failure and fix cycle**
- Given any gate finds issues
- When the system processes the findings
- Then a Worker fixes the issues and all gates re-run from gate 1 — up to a configured maximum number of fix cycles, after which the system escalates to the Operator

**Scenario: Simple work review**
- Given a work request classified as simple
- When the system begins quality assurance
- Then only gates 1 and 2 run

**Scenario: Structured evaluation rubric**
- Given a Reviewer is assessing an implementation
- When it evaluates quality
- Then it uses structured rubric dimensions (spec compliance, test quality, pattern consistency, security, convention alignment) — not unstructured prose

**Scenario: Reviewer independence**
- Given a Reviewer begins its assessment
- When it examines the implementation
- Then it starts with a fresh context, no knowledge of the implementation process, and independently verifies all claims

**Scenario: Holdout validation**
- Given all review gates have passed
- When the Validation Engine runs holdout scenarios
- Then it executes scenarios that no intelligent actor has ever seen, reporting only pass/fail counts and scenario identifiers — never scenario content

**Scenario: Holdout failure**
- Given a holdout scenario fails
- When the system processes the failure
- Then it escalates to the Spec Author as a spec gap — it never attempts to "fix" holdout failures, because they indicate the spec is incomplete, not that the implementation is wrong

**Scenario: Graduated escalation**
- Given repeated failures on the same issue
- When the failure count crosses a threshold
- Then the system escalates rather than continuing to spend resources on a structural problem

## Success Criteria

- Every implementation passes all applicable review gates before proceeding
- Reviewers never have access to holdout scenarios — isolation is what makes validation trustworthy
- Holdout failures are correctly classified as spec gaps, not implementation bugs
- First implementations become reference standards for consistency (see FUNC-AC-LEARNING)

## Constraints

- Evaluation rubrics are immutable to the executing Worker — the Worker cannot alter its own evaluation criteria
- Reviewers explicitly distrust the implementer — independent artifact reading, independent verification
- Holdout scenarios are structurally inaccessible to all intelligent actors, not merely prompt-instructed
- Escalation is graduated, not binary — repeated identical failures escalate faster than novel failures
