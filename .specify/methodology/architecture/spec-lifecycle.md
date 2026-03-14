---
id: ARCH-SDD-SPEC-LIFECYCLE
type: architecture
domain: sdd-methodology
status: approved
version: 1
layer: 2
references: FUNC-SDD-VALIDATION
---

# ARCH-SDD-SPEC-LIFECYCLE — Spec Creation, Evolution, and Retirement

## Overview

Defines how specs are created, evolved, and retired. Specs are living documents that evolve as understanding deepens.

## Status Flow

```
draft → approved → deprecated
```

No other statuses. No "in progress" or "review" — a spec is either a draft being worked on, approved for implementation, or deprecated and replaced.

## Versioning

Integer `version` field in frontmatter. Incremented on material changes (not typo fixes). Version 1 is the first version. There is no version 0.

## Creating a Spec

1. Use the appropriate template from `.specify/templates/`
2. Assign an ID following the `{LAYER_PREFIX}-{DOMAIN_KEY}` convention
3. Set status to `draft`, version to `1`
4. Add an entry to `traceability.yml`

## Evolving a Spec

1. Increment the `version` field
2. If the change affects downstream specs or code, check `traceability.yml` to identify impacts
3. Material changes to approved specs should be reviewed before re-approval

## Deprecating a Spec

1. Set status to `deprecated`
2. Add `deprecated_by` field with the replacement spec's ID
3. Add `deprecation_reason` field explaining why
4. Never delete spec files — deprecated specs serve as historical record

## Reading Order

**For implementation (building):** L3 → L2 → L1
Start with the most specific guidance (stack patterns), then understand the system design (architecture), then the business reason (functional).

**For understanding (onboarding, debugging):** L1 → L2 → L3
Start with why this exists (business), then how it works (architecture), then what patterns are used (stack-specific).
