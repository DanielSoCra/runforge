# Plan: daemon test-suite contention-timeout hardening (RC-3)

**Date:** 2026-06-23 · **Pipeline:** sparring-driven-development (claude-fallback, full-auto) · adversary = Codex GPT-5.5 high
**Class:** test-hygiene hardening (no production behavior change) — same family as merged PRs #757-759. No new L1/L2/L3 spec chain.

## CI digest (24h window: 2026-06-22 00:01 -> 2026-06-23 00:01 UTC)
- GitHub Actions: **0 hard failures.** All in-window `push`/`pull_request` CI runs green. Non-success runs are benign concurrency-cancellations, all out-of-window.
- RC-1 (fixed ports) and RC-2 (`${Date.now()}` temp paths) from #757-759: **fully resolved repo-wide.** The only fixed-port matches outside daemon are mock-fetch URL *strings*; the only `Date.now()`-temp matches are the guard's own fixtures.
- Real signal = **one reproducible flake under concurrent load.**

## Reproduction (the oracle)
`4x concurrent pnpm exec vitest run` (daemon) + `2x` (decision-index), 3 rounds = 18 suite-runs:
- **daemon: 12/12 FAILED**, always the same test, always a 5000ms timeout.
- decision-index: 6/6 passed (real-timer `concurrent-claim` tests robust under load).
- `dag-executor` loop x30 under load: 30/30 passed.
- `daemon.test.ts` **isolated at idle: 3/3 passed** (131/131, ~3.5s).

## Root cause (RC-3)
`daemon.test.ts:716` (`startDaemon > returns error when GITHUB_TOKEN is not set`) is the **first** test to call
`loadDaemon()`, which does `vi.resetModules()` + cold `import('./daemon.js')`. That cold esbuild transform/eval of the
large daemon module graph is ~250ms idle but is **starved past the 5000ms default `testTimeout`** under shared-self-hosted-runner
contention (the daemon's own `pnpm test` gate runs concurrently with branch CIs). Only the first caller pays it (the
transform is cached after); every later `loadDaemon()` test passes. CI is green because CI runs one suite, unloaded —
but the daemon's self-test gate runs under exactly this contention, so it can red the autonomous merge train.

## Fix (2 files, test/config only)
1. `packages/daemon/vitest.config.ts` — set `testTimeout: 30_000` and `hookTimeout: 30_000`. This is the principled
   fix, not masking: the test **completes** under contention (it is not hung); it is merely starved past a 5s default
   that is too tight for a dynamic-import-heavy suite on a shared runner. A genuine hang still fails at 30s. Package-wide
   so any sibling import-heavy test gets the same headroom.
2. `packages/daemon/src/test-hygiene.test.ts` — add an **RC-3** guard: assert the daemon vitest config declares
   `testTimeout` and `hookTimeout` >= 20_000, so the fix cannot silently regress to the 5s default. Plus a
   detector-fires sanity (a config missing the settings, or below threshold, is flagged).

## Considered and rejected
- **Warm the import in `beforeAll`:** relocates the cold-transform cost to a hook that *also* needs a raised
  `hookTimeout`, so it doesn't escape the contention reality — it just moves it. Adds interaction risk in a heavily
  mocked file for no net change vs. the timeout headroom. Rejected.
- **Per-test timeout (3rd arg on it()):** fragile — the cold cost lands on whichever test calls `loadDaemon()` first;
  a reorder shifts it. Package-wide config is robust to ordering.

## Verification (the real target = the oracle, not "CI green")
Re-run `4x concurrent` daemon suite x3 rounds on this branch -> **expect 0 daemon failures.** Capture in execution-log.

## Risk class
GREEN (test/config only, no production diff, oracle-verified). Eligible for auto-merge once CI green + Codex review CLEAN.
