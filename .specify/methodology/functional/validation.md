---
id: FUNC-SDD-VALIDATION
type: functional
domain: sdd-methodology
status: approved
version: 1
layer: 1
---

# FUNC-SDD-VALIDATION — Why Validation at Every Layer Matters

## Problem Statement

Spec quality determines output quality. Garbage specs produce garbage code regardless of how capable the AI model is. Without validation at each layer, errors compound as they propagate downward through layers. Each layer must be independently validatable by the appropriate reviewer.

## Actors

- **Stakeholder** — validates L1 specs (business intent)
- **Architect** — validates L2 specs (system design)
- **Builder** — validates L3 specs (pattern conformance)
- **Validation Engine** — automated structural checks (schema validation, blocklist enforcement)

## Behavior

**Scenario: L1 stakeholder validation**
- Given an L1 spec
- When a Stakeholder reviews it
- Then they can confirm it captures their business intent without technical knowledge

**Scenario: L2 architecture validation**
- Given an L2 spec
- When an Architect reviews it
- Then they can confirm the system design achieves the L1 requirements without framework-specific assumptions

**Scenario: L3 conformance validation**
- Given an L3 spec
- When the Validation Engine checks it
- Then it confirms the spec uses only patterns and short examples, not complete implementations

**Scenario: Schema validation**
- Given a spec at any layer
- When its frontmatter is checked against schema.json
- Then the schema validates required fields, allowed fields, and layer-specific constraints

## Success Criteria

- Each layer is independently validatable
- L1 by humans (business), L2 by humans (architecture), L3 by automated conformance + humans (patterns)
- Schema validation catches structural errors before content review

## Constraints

- Validation is continuous — specs evolve as understanding deepens
- A spec is never "done" — it is "approved at this version"
- Automated validation (schema, blocklist) supplements but does not replace human review
