# Design: RC-3 CI-flake hardening (dashboard gap + guard generalization + daemon root-cause)

**Date:** 2026-06-24 · **Pipeline:** sparring-driven-development (claude-fallback binding, full-auto) · adversary = Codex GPT-5.5 high

## Problem (from the 24h CI digest)

GitHub Actions CI is green for the last 24h (0 hard failures). The only in-window flake signal is **RC-3**, fixed *within the window* by PR #770 (merged 2026-06-23 00:39 UTC) — a **masking** fix that raised `testTimeout`/`hookTimeout` to 30s in `packages/daemon/vitest.config.ts`.

**One systemic root cause** underlies the whole flake family: tests contend for a shared, finite resource, and N concurrent test processes on the single self-hosted runner collide. Three manifestations:

- **RC-1** shared TCP ports → `EADDRINUSE` — ✅ root-caused (#757) + monorepo-wide hygiene guard (#759).
- **RC-2** shared temp paths (`${Date.now()}`) → collision/`ENOENT` — ✅ root-caused (#758) + guard.
- **RC-3** shared CPU/esbuild-transform throughput: a cold `vi.resetModules()` + dynamic `import()` of a large module graph is starved past the timeout under contention — ⚠️ **masked on the daemon only**, **unguarded on the dashboard**.

**Empirical oracle (run 2026-06-24):** 4× concurrent daemon suite → 229 files / 3152 tests green ×4; 3× full monorepo → green ×3. So the mask holds locally; the items below are **latent** patterns, not currently-red tests. This is hardening, not a red-test fix.

### The gap

`vi.resetModules()` + dynamic `import()` (the RC-3 pattern) is used in **13 dashboard test files** (vs the daemon's 4), but `packages/dashboard/vitest.config.ts` has **no timeout floor** — it runs at the 5s vitest default. The RC-3 regression guard in `packages/daemon/src/test-hygiene.test.ts` only evaluates `daemon/vitest.config.ts`, so the dashboard gap is invisible to it.

## Goals

1. Close the dashboard RC-3 gap.
2. Make the RC-3 guard catch the gap on **any** package, not just the daemon — preventing future drift.
3. Retire the daemon mask by removing the cold re-import at its root (separate, higher-risk PR, left open for Operator review).

## Non-goals

- Changing CI infra (runner count, job-level concurrency mutex). The systemic contention is real but the fix here is at the test layer, matching the proven #757–759 approach.
- Touching RC-1/RC-2 (already root-caused + guarded).
- Any production behavior change. Fixes 1–2 are test/config only; Fix 3 is a behavior-preserving refactor.

## Design

### Fix 1 — Dashboard RC-3 floor (PR-A, low-risk, test/config only)

Add `testTimeout`/`hookTimeout` ≥ 30s to `packages/dashboard/vitest.config.ts`, mirroring the daemon fix exactly, with an RC-3 comment that cross-references the daemon config and the guard. The dashboard's `defineConfig({ test: {...} })` already exists; add the two keys inside `test`.

### Fix 2 — Generalize the RC-3 guard (PR-A, low-risk, meta-test only)

Today `test-hygiene.test.ts` has one daemon-specific test that imports `../vitest.config.ts` and asserts the floor. Generalize to:

1. **Detect which packages use the RC-3 cold-import pattern.** Add a detector: a test file "uses the cold-import pattern" if (comments stripped) it contains `resetModules()` **and** a dynamic `import(`. Map each such test file to its owning package directory (nearest ancestor under `packages/` containing a `vitest.config.ts`).
2. **For each flagged package, assert its config meets the floor** via the existing `findTimeoutHardeningViolations`.

**Mechanism — codex-hardened (review 2026-06-24: 0 Critical, 3 Important, all folded here).**

- **Pure eval, fail-closed — NO textual fallback.** Dynamically import each *flagged* package's `vitest.config.ts`, resolve the effective `test` object, and assert the floor. **If the import/eval throws, that is a hard violation** ("could not evaluate `<pkg>/vitest.config.ts` to verify the RC-3 floor"), never a silent skip or a weak text match. This kills the original Important finding that a textual fallback false-passes on commented / dead-object / spread-overridden / below-floor timeouts. *De-risked empirically (2026-06-24): a throwaway probe eval'd every package config from inside the daemon vitest process — `dashboard` (with `@vitejs/plugin-react`) eval'd cleanly and reported `testTimeout=undefined` (the gap). So fail-closed-on-throw never fires for the two flagged packages today; it is purely a guard against a future un-loadable config.*
- **Err toward inclusion in detection.** Any `resetModules()` + dynamic `import(` flags the package — no attempt to classify the import specifier as local vs `node:`/bare/aliased. Rationale: a *needless* floor is harmless (a higher timeout only delays the failure of a genuinely-hung test; it never breaks a passing one), whereas a *missed* floor is exactly the RC-3 bug. So over-detection is the safe direction and the import-classification ambiguity codex raised stops mattering. (Verified: only `daemon` + `dashboard` match today; both are real local re-imports.)
- **Scan `.test.ts` AND `.test.tsx`.** The dashboard has 29 `.test.tsx` files; the existing `listTestFiles()` only matched `.test.ts`, so the repo-wide guard was narrower than vitest's own collection. Widen it (also strengthens the RC-1/RC-2 scan).
- Replace the daemon-specific precise-eval `it(...)` with the general loop; keep a sanity assertion that the flagged set is non-empty and includes `daemon` + `dashboard` (so the guard can't go vacuous). Extend the self-tests to prove the detector fires on `resetModules`+`import(` and the floor check fires below the floor.

> Shared-base-config alternative (every package extends one plugin-free base holding the floor) was considered and deferred: cleaner long-term but more invasive, and the probe proved per-config eval is reliable, so it buys nothing now. Parked as a follow-up if config drift grows.

### Fix 3 — Daemon root-cause: drop the cold re-import (PR-B, higher-risk, LEFT OPEN for review)

`daemon.test.ts`'s `loadDaemon()` does `vi.resetModules()` + `import('./daemon.js')` at **131 call sites**. The *only stated* reason (per the in-code comment) is daemon.ts's two module-level counters: `dailyRunCount` and `dailyRunCountResetDate` (lines 146–147), mutated in the daily-reset block (lines 2603–2607).

**Refactor (behavior-preserving):**

1. In `daemon.ts`, move the two counters into a single module-level mutable holder object (e.g. `const dailyRunState = { count: 0, resetDate: <today> }`), update the three read/write sites accordingly, and add a test-only reset export (e.g. `export function __resetDailyRunStateForTests(): void`). The daily-run-limit behavior described in `control-plane.md` is unchanged — this is a pure internal-state refactor (the spec mandates *daily cost* state on DaemonState; the run *count* is an implementation detail).
2. In `daemon.test.ts`, change `loadDaemon()` to import `./daemon.js` **once** (module-cached) and call `__resetDailyRunStateForTests()` per call instead of `vi.resetModules()`. This removes all 131 cold re-imports.
3. **Once the cold re-import is gone, the 30s mask is no longer load-bearing.** Keep it as defense-in-depth OR relax it — decided after the adversary review and the oracle result. The RC-3 guard floor stays (other packages still re-import).

**Risk & exit:** the isolation risk is that some test relies on fresh module-level state in a *transitively-imported, unmocked* module — not just the two counters. ~40 imports are `vi.mock()`'d (state reset via `beforeEach`/`afterEach` `restoreAllMocks` + explicit `vi.fn()` clears), so the exposure is the unmocked remainder. **Exit criterion:** the full daemon suite + the 4× concurrent oracle must be green and codex-on-diff CLEAN. **If the refactor breaks any test's isolation, do NOT ship a broken PR — document Fix 3 as a recommended follow-up in the execution log and ship only PR-A.**

## PR / merge plan (honoring the user's explicit override of the skill's "never merge")

- **PR-A** = Fix 1 + Fix 2 (coupled: the generalized guard requires the dashboard floor to exist or it fails). Test/config only, no production code. **Merge if CI is green and codex-clean** (user authorized "merge if confident").
- **PR-B** = Fix 3 alone. Touches spec-governed `daemon.ts`. **Leave open for Operator review** regardless of green (user said "else leave them open").

## Verification

- PR-A: `test-hygiene.test.ts` passes (incl. extended self-tests); dashboard suite green; 4× daemon oracle green; full `pnpm -r test`/lint/typecheck/build green in CI.
- PR-B: full daemon suite green; 4× concurrent daemon oracle green (the real RC-3 reproduction); confirm `loadDaemon()` no longer calls `resetModules()`.
- Execution log captures actual oracle outputs + the merge/leave-open outcome.
