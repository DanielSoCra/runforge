---
id: FUNC-SDD-HOLDOUT-TESTING
type: functional
domain: sdd-methodology
status: approved
version: 1
layer: 1
---

# FUNC-SDD-HOLDOUT-TESTING — Why Holdout Scenarios Exist

## Problem Statement

When AI agents write both code and tests, they can game the test suite by weakening assertions or testing implementation details rather than behavior. Independent validation requires tests that agents cannot modify. Code is not trusted because it is readable — it is trusted because it passes independent harnesses.

## Actors

- **Spec Author** — writes holdout scenarios that capture critical user journeys
- **Builder** — implements code without access to holdout scenarios
- **Independent Validator** — verifies outcomes using protected holdout scenarios

## Behavior

**Scenario: Builder isolation**
- Given a protected holdout scenario set exists
- When a Builder implements a feature
- Then the Builder cannot read or modify the scenarios

**Scenario: Spec sufficiency validation**
- Given built code
- When the Independent Validator runs holdout scenarios
- Then passing scenarios confirm the specs were sufficient to produce correct behavior

**Scenario: Failure diagnosis**
- Given a failing holdout scenario
- When the team investigates
- Then the team determines whether the failure reflects a spec gap, an implementation defect, or another validation gap

## Success Criteria

- Scenarios validate specs, not code
- Scenarios are kept in a protected location inaccessible to Builders
- Builders are never allowed to modify the protected scenario set

## Constraints

- Holdout testing is a trust mechanism — it works because the test author and code author are independent
- If the same builder writes both scenarios and code, the holdout property is violated
- Scenarios describe observable behavior from the user's perspective, not implementation details
