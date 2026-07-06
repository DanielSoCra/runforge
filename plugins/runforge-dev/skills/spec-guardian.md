# Spec Guardian Patterns

When creating or reviewing specs, use the appropriate skill:
- `l1-spec-guardian` for FUNC-* (L1 functional specs)
- `l2-spec-guardian` for ARCH-* (L2 architecture specs)
- `l3-spec-guardian` for STACK-* (L3 stack specs)

L1: business WHY only — no technology, human actors, Given/When/Then scenarios.
L2: system HOW — system names only, plain-language data model, six required sections.
L3: pattern guide — named pattern + rationale, 3–5 line snippet, one concern per spec.

This repo holds two parallel L0 trees as of 2026-05-01:
- `L0-AC-VISION` (`.specify/L0-ac-vision.md`) — runforge subsystem; 14 `FUNC-AC-*` L1s.
- `L0-CONCIERGE-VISION` (`.specify/L0-vision.md`) — concierge product; `FUNC-CONCIERGE-*` family L1s.

When authoring or reviewing a new spec, identify which L0 it falls under from `.specify/traceability.yml`; both trees coexist as siblings (no L0-to-L0 `parent:` field). Spec IDs must be 3-segment (`PREFIX-A-B`) for the daemon spec-ref regex (`process-single.ts:94`) to extract them from issue bodies.
