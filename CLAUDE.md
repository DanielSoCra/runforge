# Claude Code Instructions

All rules in `AGENTS.md` apply. This file adds Claude Code-specific behavior.

## Additional Rules

- Before editing any file, check `.specify/traceability.yml` for which spec governs it.
- When implementing a spec, read layers in order: L3 (patterns) -> L2 (architecture) -> L1 (business context).
- When a spec is ambiguous, read UP the layer chain before guessing.
- Always run the affected spec's `test_paths` after making changes.
- Always update `traceability.yml` when creating new files.
- Use spec templates in `.specify/templates/` when creating new specs.
