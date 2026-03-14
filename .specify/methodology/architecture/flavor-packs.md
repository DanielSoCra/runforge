---
id: ARCH-SDD-FLAVOR-PACKS
type: architecture
domain: sdd-methodology
status: approved
version: 1
layer: 2
references: FUNC-SDD-LAYER-SEPARATION
---

# ARCH-SDD-FLAVOR-PACKS — Stack-Specific Pattern Organization

## Overview

Flavor packs provide stack-specific patterns as optional add-ons. They are pattern catalogs — reusable, project-agnostic conventions for a given stack.

## What Flavor Packs Are

Curated L3-level pattern guidance organized by concern (models, controllers, services, config). Each file uses the same *sections* as the `l3-stack-specific.md` template (Pattern, Key Decisions, Examples, Gotchas) but does NOT use spec frontmatter, IDs, or traceability entries. Flavor packs are reference material, not traceable spec artifacts.

Examples of flavor pack content:
- "We use UUID primary keys and string-backed enums in all models"
- "Cursor-based pagination for all list endpoints"
- "Exponential backoff for all retry logic"

These describe the team's conventions for a stack, not any specific project's entities.

## What Flavor Packs Are NOT

Per-entity specs. "How the Task model is implemented" is a project-specific L3 spec that lives alongside the project's L1/L2 specs, not inside a flavor pack.

| Flavor pack (generic) | Per-entity L3 spec (project-specific) |
|---|---|
| "UUID primary keys on all models" | "Task model has status, priority, and assigned_agent fields" |
| "Cursor-based pagination" | "GET /api/v1/tasks returns paginated task list" |
| "State machine via enum + methods" | "Task transitions: draft → assigned → in_progress → review → done" |

## Organization

Each flavor lives in `.specify/flavors/<stack>/`. Typical files per flavor:
- `models.md` — data layer patterns
- `controllers.md` or `endpoints.md` — API layer patterns
- `services.md` — business logic patterns
- `jobs.md` — background processing patterns
- `config.md` — configuration and infrastructure patterns

Not all files are required — include only those relevant to the stack.

## ID Prefix Convention

L3 ID prefixes are derived from the flavor directory name:
- `rails/` → `RAIL-*`
- `nestjs/` → `NEST-*`
- `python-fastapi/` → `PY-*`

New stacks choose a short, unique prefix. The prefix must be unique across all flavors in a project.

## Coexistence

Multiple flavors can coexist in one project (e.g., a Rails backend + a React frontend). Each flavor operates independently.
