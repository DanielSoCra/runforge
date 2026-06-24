# Plan: RC-3 CI-flake hardening

**Design:** `docs/superpowers/specs/2026-06-24-rc3-flake-hardening-design.md`
**Branches:** PR-A `codex/rc3-dashboard-floor-and-guard-build` · PR-B `codex/rc3-daemon-rootcause-build` (both off `origin/main` @ 9eb0f0e)

## PR-A — dashboard floor + generalized guard (test/config only; merge if green)

### Task A1 — Dashboard RC-3 floor
- **File:** `packages/dashboard/vitest.config.ts`
- Add `testTimeout: 30_000` and `hookTimeout: 30_000` inside `test: { … }`, with an RC-3 comment referencing `daemon/vitest.config.ts` and the guard.
- **Verify:** `pnpm --filter @auto-claude/dashboard test` green.

### Task A2 — Generalize the RC-3 guard (TDD; codex-hardened)
- **File:** `packages/daemon/src/test-hygiene.test.ts`
- **RED first:** add a self-test proving `usesColdImportPattern` fires on `resetModules()`+`import(` and not otherwise; keep the existing `findTimeoutHardeningViolations` below-floor self-tests.
- Add `usesColdImportPattern(src): boolean` — true iff source (comments stripped via existing `stripComments`) contains `resetModules()` AND `import(`. **Err toward inclusion** — no specifier classification (a needless floor is harmless; a missed floor is the bug).
- Widen `listTestFiles()` to match `.test.ts` **and** `.test.tsx` (finding 1).
- Add `packageDirOf(testFilePath)` — nearest ancestor under `packages/` containing a `vitest.config.ts`.
- Replace the daemon-only precise-eval `it(...)` with a general one: scan all test files; collect flagged package dirs; assert the set is non-empty and ⊇ {`daemon`,`dashboard`} (non-vacuous). For each flagged package: dynamic-import its `vitest.config.ts` → effective `test` → `findTimeoutHardeningViolations`. **On import/eval throw → push a hard violation (fail-closed), NO textual fallback** (finding 2). Aggregate; expect `[]`.
- Keep RC-1/RC-2 checks + their self-tests intact.
- **Verify:** `pnpm --filter @auto-claude/daemon test -- test-hygiene` green; new self-tests fire (not no-ops); confirm the flagged set is exactly {daemon, dashboard} today.

### Task A3 — PR-A verification gate
- `pnpm --filter @auto-claude/dashboard test` + `pnpm --filter @auto-claude/daemon test` green.
- 4× concurrent daemon oracle green.
- codex-on-diff (`main..HEAD`) → CLEAN (focus: detector false-negatives, cross-package eval safety, textual-fallback strength).

## PR-B — daemon root-cause refactor (production; LEAVE OPEN)

### Task B1 — Extract daemon counters (TDD where practical)
- **File:** `packages/daemon/src/control-plane/daemon.ts` (read STACK-AC-CONTROL-PLANE first — done).
- Replace `let dailyRunCount`/`let dailyRunCountResetDate` (146–147) with one holder object; update the 3 sites (read at ~1470; reset/increment at ~2603–2607).
- Add `export function __resetDailyRunStateForTests(): void` resetting the holder to count 0 / today.

### Task B2 — Drop the cold re-import
- **File:** `packages/daemon/src/control-plane/daemon.test.ts`
- Change `loadDaemon()` to import `./daemon.js` once (module-cached) + call `__resetDailyRunStateForTests()` per call; remove the per-call `vi.resetModules()`.
- Do NOT touch the 131 call sites otherwise (they keep `await loadDaemon()`).
- **Audit (codex Minor):** grep `daemon.test.ts` for `vi.doMock`/`vi.unmock` — if present, caching the import could change re-evaluation semantics; handle before proceeding. (Expected: none — only hoisted `vi.mock`.)
- **Guard test (codex Minor):** add a meta-assertion that `loadDaemon`'s source does NOT call `resetModules()` (locks in the root-cause fix so it can't silently regress).

### Task B3 — PR-B verification gate (hard exit)
- Full daemon suite green (all 229 files), AND 4× concurrent daemon oracle green (real RC-3 reproduction).
- codex-on-diff → CLEAN (focus: any test relying on fresh state beyond the 2 counters; mock-identity stability without resetModules).
- Decide mask: relax to default or keep 30s as defense-in-depth (document either way).
- **If any test breaks and can't be cleanly fixed within this scope → abandon PR-B, document as a follow-up in the execution log, ship only PR-A.**

## Phase 8 — PRs + CI
- Push both branches; PR-A and PR-B with bodies linking the spec+plan and a test plan checklist.
- Watch CI green on both.

## Merge (user override of skill default)
- PR-A: merge if CI green + codex-clean.
- PR-B: leave open for Operator review.

## Phase 9 — Verify + execution log
- Re-run the 4× daemon oracle on merged `main` (post PR-A) — confirm still green.
- `docs/superpowers/plans/2026-06-24-rc3-flake-hardening.execution-log.md`: actual oracle outputs, codex round summaries, PR URLs, merge/leave-open outcome, mask decision. Follow-up PR for the log (leave open).
