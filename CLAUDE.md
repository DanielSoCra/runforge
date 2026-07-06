# Claude Code Instructions

All rules in `AGENTS.md` apply. This file adds Claude Code-specific behavior.

## Additional Rules

- Before editing any file, check `.specify/traceability.yml` for which spec governs it.
- When implementing a spec, read layers in order: L3 (patterns) -> L2 (architecture) -> L1 (business context) -> L0 (vision).
- When a spec is ambiguous, read UP the layer chain before guessing.
- After implementing L3 work, verify it aligns with L2 (architecture), L1 (functional behavior), and L0 (vision and boundaries). If any layer contradicts your implementation, the higher layer wins.
- Always run the affected spec's `test_paths` after making changes.
- Always update `traceability.yml` when creating new files.
- When creating or reviewing specs, use the appropriate skill: `l1-spec-guardian` (FUNC-*), `l2-spec-guardian` (ARCH-*), `l3-spec-guardian` (stack-specific).
- Before implementing any new feature, verify that L1, L2, and L3 specs exist in `.specify/` and are linked in `traceability.yml`. If they are missing, write them first using the spec guardian skills before touching any code.
- New features follow this sequence: brainstorm (`superpowers:brainstorming`) → write specs L1→L2→L3 (using guardian skills) → implementation plan (`superpowers:writing-plans`) → implementation. No implementation task is valid without a complete spec chain.

## Autonomous Operating Mode

This repo is runforge itself — an autonomous-by-design system. Per L0-AC-VISION and FUNC-AC-PIPELINE, the Operator's role is L1 spec authoring + production-release approval. **Everything below that is autonomous**, including:

- Pushing to any feature branch (`codex/*`, `feature/*`, etc.)
- Opening PRs against `main` for visibility
- Closing issues, applying labels, posting comments via `gh`
- Writing missing L3 specs via `l3-spec-guardian` when a stuck issue's only blocker is a missing L3 file
- Retrying stuck items with different approaches rather than logging "correct conservative escalation"
- Merging the daemon's autonomous-loop output to `origin/main` via PR-gated merges (per the risk-class gate)

**Branch model (single trunk, ratified 2026-05-29):** `main` is the trunk. The legacy `dev` integration branch is **retired** — autonomous work flows feature-branch → PR → `main`, gated by the risk-class / review gates (GREEN/YELLOW auto-merge once proven; ORANGE/RED → Operator decision). There is no `dev`. **"Production" is a deploy/release event from `main`** (tag/release + deploy), which remains the Operator-approved gate — *not* a branch merge.

**Do not** treat these as destructive shared-state operations requiring human confirmation. The harness exists precisely so they happen unattended. The only operations that genuinely need the Operator's approval are: (a) L1 spec content decisions, (b) **production releases (deploy from `main`)**, (c) destructive ops outside the pipeline's normal mutation set (force-push, branch deletion of unmerged work, etc.).

If a generic "ask before destructive shared-state op" instinct conflicts with the above, the L0/L1 specs and this section override the default.
