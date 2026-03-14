---
id: ARCH-SDD-LAYER-CONTRACT
type: architecture
domain: sdd-methodology
status: approved
version: 1
layer: 2
references: FUNC-SDD-LAYER-SEPARATION
---

# ARCH-SDD-LAYER-CONTRACT — Layer Contents and Rules

## Overview

Defines what each layer contains, what it must not contain, and how layers reference each other. This is the structural backbone of SDD.

## Layer Definitions

### L1 — Functional (WHY)

Business behavior from the user's perspective.

**Sections:** Problem Statement, Actors, Behavior (Given/When/Then), Success Criteria, Constraints.

**Rules:**
- Contains zero technology references — no system names, no data models, no APIs
- A product manager or stakeholder should be able to read and validate every L1 spec
- Uses role names (e.g., "User", "Admin"), not system names

### L2 — Architecture (HOW)

System design that achieves L1 requirements.

**Sections:** Overview, Data Model, API Contract, System Boundaries, Event Flows, Error Handling.

**Rules:**
- Uses system names only: "Backend", "Agent Service", "Frontend", "File Storage", "Job Queue", "WebSocket"
- Never uses framework names (Rails, Django, FastAPI, NestJS, etc.)
- Data models describe entities, attributes, and relationships in plain language — not ORM syntax
- API contracts describe endpoints, request/response shapes, and status codes

### L3 — Stack-Specific (WHAT)

Implementation patterns for the chosen stack.

**Sections:** Pattern (named pattern + why), Key Decisions (library choices with rationale), Examples (3-5 line code snippets), Gotchas (things to watch out for).

**Rules:**
- Framework-specific — this is the one place where "Rails", "NestJS", "FastAPI" belong
- Short and practical — patterns, not complete implementations
- Disposable — once code is built, the code is the source of truth

## Frontmatter Contract

Every spec has YAML frontmatter validated by `.specify/schema.json`.

| Field | L1 | L2 | L3 | Scenario |
|-------|----|----|----|----|
| id | FUNC-* | ARCH-* | {STACK}-* | SC-* |
| type | functional | architecture | stack-specific | scenario |
| layer | 1 | 2 | 3 | — |
| references | forbidden | required (→ L1) | required (→ L2) | — |
| stack | forbidden | forbidden | required | — |
| code_paths | forbidden | forbidden | required | — |
| test_paths | forbidden | forbidden | required | — |
| priority | — | — | — | required |
| covers | — | — | — | required |

## Reference Direction

References always point upward (child → parent):
- L2 `references` its parent L1 spec
- L3 `references` its parent L2 spec
- L1 has no `references` field (it is the root)
- Downward links (parent → children) are maintained in `traceability.yml`, not in frontmatter

## Language-Agnostic Enforcement

L1 and L2 specs must not contain framework-specific terms. Agents should reject specs containing terms from this blocklist:

**Frameworks:** Rails, ActiveRecord, Active Storage, Solid Queue, Action Cable, Django, FastAPI, NestJS, Express, Spring, Laravel, Flask

**ORMs:** Prisma, TypeORM, Sequelize, SQLAlchemy

**ORM syntax:** belongs_to, has_many, has_one, @Injectable, @Controller, @Entity

**Frontend:** React, Vue, Angular, Next.js, Nuxt, Astro (when used as implementation references, not as system names)

This list is configurable per project.

**Exception:** Methodology specs (`.specify/methodology/`) may reference framework names when defining this blocklist itself, describing flavor pack conventions, or providing examples of what belongs in L3. The blocklist applies to *project* L1/L2 specs, not to the methodology's own self-describing documentation.
