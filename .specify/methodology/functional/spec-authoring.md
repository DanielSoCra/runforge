---
id: FUNC-SDD-SPEC-AUTHORING
type: functional
domain: sdd-methodology
status: approved
version: 1
layer: 1
---

# FUNC-SDD-SPEC-AUTHORING — Why We Write Specs Before Code

## Problem Statement

In AI-assisted development, the bottleneck has shifted from writing code to precisely describing what should exist. Without explicit specifications, AI agents produce plausible but misaligned output, requiring costly rework. The spec is the primary artifact; code is compiled output.

## Actors

- **Spec Author** — writes specifications that capture business intent and system design
- **Builder** — human or AI agent that implements code from specs
- **Stakeholder** — validates that specs capture their intent

## Behavior

**Scenario: Spec before code**
- Given a new feature or change request
- When the Spec Author begins work
- Then they write a spec before any code is written

**Scenario: Independent reproducibility**
- Given a spec
- When two independent Builders implement it
- Then they produce functionally equivalent systems

**Scenario: Stakeholder validation**
- Given a spec
- When the Stakeholder reads it
- Then they can validate whether it captures their intent without understanding implementation details

## Success Criteria

- Every code file traces to a governing spec
- No code exists without a spec
- Specs are the source of truth until code is built

## Constraints

- Specs describe decisions, not implementations
- A spec that contains copy-paste code has failed its purpose
- A spec is trustworthy when it is precise enough that independent builders produce equivalent results
