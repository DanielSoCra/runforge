---
id: FUNC-AC-BUG-TRIAGE
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-BUG-TRIAGE — Bug Diagnosis and Feedback Loop

## Problem Statement

In a spec-driven system, a bug is not simply "a wrong implementation." It is an epistemological failure — a breakdown in the translation of intent (spec) to artifact (implementation). Treating all bugs as implementation errors causes the system to "fix" an implementation that is correct per its spec, masking the real issue: an incomplete specification. Proper diagnosis requires classifying bugs by root cause and routing each type to the appropriate resolution path.

## Actors

- **Reporter** — surfaces behavior that appears incorrect
- **Spec Author** — receives spec gap diagnoses, updates specifications
- **Operator** — receives escalations for expectation mismatches

## Behavior

**Scenario: Diagnosis before fix**
- Given a bug report enters the system
- When the system begins processing
- Then the system analyzes the error report, the implementation, and the governing specifications before any fix is attempted

**Scenario: Structured classification output**
- Given the system has analyzed a bug
- When it produces its diagnosis
- Then the output includes: classification type (A/B/C), confidence score, affected specifications, and suggested resolution path

**Scenario: Low confidence routing**
- Given the diagnosis confidence score is below the required confidence threshold
- When the system evaluates the diagnosis
- Then it routes to the Operator rather than guessing — wrong classification wastes more resources than human review

**Scenario: Type A — Implementation bug**
- Given the spec clearly describes expected behavior but the implementation deviates
- When the system classifies this as Type A
- Then the system routes to a targeted fix: write a regression test that reproduces the bug, then fix the implementation to make it pass

**Scenario: Type A fix workflow**
- Given a Type A bug has been classified
- When the targeted fix begins
- Then it uses a regression-test-first workflow and treats the work as one focused fix rather than decomposing it further

**Scenario: Type B — Spec gap**
- Given the implementation matches exactly what the spec describes, but the spec doesn't cover the reported case
- When the system classifies this as Type B
- Then the system escalates to the Spec Author with a structured diagnosis and suggested spec changes — it does NOT attempt to modify the implementation

**Scenario: Type B re-entry**
- Given the Spec Author has updated the spec to address a Type B gap
- When the updated work request re-enters the system
- Then it is processed through the standard pipeline as a new feature implementation

**Scenario: Type C — Expectation mismatch**
- Given both the spec and the implementation are correct, but the reporter expected different behavior
- When the system classifies this as Type C
- Then the system escalates to the Operator — this requires rethinking the business requirement, not modifying the implementation or the specs

**Scenario: Feedback loop visibility**
- Given Type B bugs have been classified over time
- When the system records classifications over time
- Then the Operator can view trend metrics showing the distribution of bug types across time periods

## Success Criteria

- Every bug is classified before any fix is attempted
- Type A bugs are fixed with a regression test that proves the bug existed
- Type B bugs result in spec improvements, never implementation workarounds
- The ratio of Type B bugs decreases over time as specifications mature

## Constraints

- The system never guesses at low confidence — routing to human is always preferable to a wrong classification
- Holdout failures and bug reports may reveal spec gaps, implementation defects, or expectation mismatches; diagnosis determines which
- Bug fixes always start with a regression test — the test proves the bug exists before any fix is attempted
- The system never "fixes" a Type B bug by changing the implementation — the implementation is correct per the spec
