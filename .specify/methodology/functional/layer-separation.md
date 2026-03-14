---
id: FUNC-SDD-LAYER-SEPARATION
type: functional
domain: sdd-methodology
status: approved
version: 1
layer: 1
---

# FUNC-SDD-LAYER-SEPARATION — Why Three Layers Exist

## Problem Statement

Without explicit layer separation, specs drift toward pre-written code. Framework-specific details leak into business logic descriptions, making specs non-portable and tightly coupled to implementation choices. Three layers enforce abstraction boundaries that keep each concern isolated.

The model follows Sinek's Golden Circle: WHY (business purpose) → HOW (system design) → WHAT (stack patterns).

## Actors

- **Spec Author** — writes specs at the appropriate layer
- **Builder** — reads specs from the relevant layer for their task
- **Architect** — ensures layer boundaries are maintained

## Behavior

**Scenario: Layer serves the right reader**
- Given a specification system with three layers
- When each layer is written
- Then L1 serves stakeholders/product, L2 serves architects, L3 serves builders

**Scenario: Portability across stacks**
- Given L1 and L2 specs
- When the project switches frameworks
- Then zero L1 and L2 specs require changes

**Scenario: L3 disposability**
- Given an L3 spec
- When the code it describes is built and running
- Then the L3 spec becomes disposable — the code is now the source of truth

**Scenario: Standalone completeness**
- Given a spec at any layer
- When it is read in isolation
- Then it provides a complete picture at that abstraction level

## Success Criteria

- L1 contains zero technology references
- L2 uses system names only ("Backend", not "Rails")
- L3 contains patterns + short examples, not complete implementations

## Constraints

- L1 (WHY) is the most durable and important layer; L3 (WHAT) is the most disposable
- This is counterintuitive: "what" sounds important, but in SDD the business intent (why) outlasts any implementation choice (what)
- Without explicit separation, specs naturally drift toward code (the Example-Project lesson)
