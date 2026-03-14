# Agent Instructions

Universal rules for any AI agent working in this repository.

## Rules

1. **Check traceability first.** Before editing any file, check `.specify/traceability.yml` for which spec governs it.

2. **Read before editing.** Never edit code governed by a spec without reading the spec first.

3. **Methodology is protected.** Never modify `.specify/methodology/` without explicit human approval.

4. **Scenarios are off-limits.** Never read or modify `.specify/scenarios/`. These are holdout tests — builder isolation is what makes them trustworthy. Only the Validation Engine accesses them.

5. **Reading order depends on intent.**
   - For implementing: L3 -> L2 -> L1 (patterns -> architecture -> business context)
   - For understanding: L1 -> L2 -> L3 (business -> architecture -> patterns)

6. **Read up, never guess.** When a spec is ambiguous, read UP the layer chain (L3 -> L2 -> L1) before making assumptions.

7. **Maintain traceability.** Update `traceability.yml` when creating new files governed by specs.

8. **L1 and L2 must be language-agnostic.** Use system names only: Backend, Agent Service, Frontend, File Storage, Job Queue, WebSocket. Reject any spec containing terms from this blocklist:
   - **Frameworks:** Rails, ActiveRecord, Active Storage, Solid Queue, Action Cable, Django, FastAPI, NestJS, Express, Spring, Laravel, Flask
   - **ORMs:** Prisma, TypeORM, Sequelize, SQLAlchemy
   - **ORM syntax:** belongs_to, has_many, has_one, @Injectable, @Controller, @Entity
   - **Frontend frameworks** (when used as implementation references): React, Vue, Angular, Next.js, Nuxt, Astro
   - This list is configurable per project. Exception: methodology specs (`.specify/methodology/`) may reference framework names when defining the blocklist itself or describing flavor packs.

9. **L3 contains patterns, not implementations.** L3 specs include named patterns, library choices, and short examples (3-5 lines). Never complete implementations.

10. **Specs are never deleted.** Deprecate specs by adding `deprecated_by` and `deprecation_reason` to their frontmatter. Never remove a spec file.
