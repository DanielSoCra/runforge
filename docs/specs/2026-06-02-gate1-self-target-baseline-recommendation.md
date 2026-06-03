# Recommendation: stop one pre-existing red test from parking every self-targeted run (#3)

**Date:** 2026-06-02
**Status:** RECOMMENDATION — deferred, not implemented in this PR.
**Author:** agent (sparred with Codex / GPT-5.5).
**Decision owner:** the Operator (this is a behaviour-changing relaxation of review strictness — needs human sign-off).

## Why this is only a recommendation, not code

The companion PR (`fix/daemon-stuck-escalation`) ships three **no-regret** fixes that
together remove the "Unknown error" stuck failure mode and make the fix loop converge:

- **#2** — `pipeline.ts` now synthesises a diagnostic `FailureRecord` + `lastError`
  for any phase that routes to `stuck` via a non-`failure` event (today: `escalated`,
  and the `per-run-budget-exceeded` global path), so the terminal result is never empty.
- **#1b** — the `review` handler records the real failing-gate finding(s) on
  `run.lastFailure` on escalation, so the surfaced error is the actual blocking reason
  (e.g. the failed `gate1` command output) instead of "Unknown error".
- **#4** — accumulated review findings (`run.reviewFindings`) are threaded into
  `coordinator.implement(...)` (both the simple and the decompose paths), so a
  re-implement attempt is no longer blind to what the reviewer flagged.

Those three make a stuck run **diagnosable and convergent**. They do **not** change
merge strictness. #3 *does* change merge strictness — so per the user's explicit
instruction ("If codex thinks it's too risky to auto-decide, implement #1b/#2/#4 and
write #3 up as a recommendation instead") it is written up here for a human decision
rather than shipped under task pressure in the same PR.

## The root cause #3 addresses

`auto-claude.config.json` configures the FIRST review gate ("gate1", deterministic) as:

```json
"gate1Commands": ["pnpm --filter @auto-claude/daemon run test"]
```

That runs auto-claude's **entire own** test suite (~2,460 tests). When the daemon
works on a **self-targeted** issue (an issue in its own repo), gate1 runs the whole
suite. A **single** pre-existing red or flaky test — unrelated to the change — makes
gate1 fail. review re-runs implement blind, exhausts `maxFixCycles`, and the run is
parked as `stuck`. This is the #1 driver of self-targeted stuck runs.

(For *other-repo* issues this is not a problem in the same way — gate1 runs that
repo's suite, which is the intended behaviour.)

## Options considered (Codex ranking: A > B > C)

- **(a) BASELINE delta** — run gate1 once *before* implement; after implement, only
  *new* failures (green-at-baseline, red-now) fail the gate. Pre-existing reds are
  non-blocking.
- **(b) DIFF-SCOPED** — run only the tests related to changed files (e.g. vitest
  related/changed-files mode).
- **(c) PRE-EXISTING-RED NON-BLOCKING** — keep the full suite, but if the suite was
  already red on the base branch (one cheap pre-implement run), downgrade gate1
  failures to warnings for this run.

### Codex's assessment of slip risk

- **(a)** can miss a regression that *mutates* an already-red test if you compare only
  test names — mitigated by comparing failure *fingerprints* (file + test name +
  normalised assertion/location/message), treating *changed* fingerprints as blocking.
- **(b)** can miss integration regressions outside the changed-file test graph — too
  risky for daemon/review behaviour.
- **(c)** worst safety profile: on a red baseline, any new regression becomes
  non-blocking.

### Codex's preferred design: "A+" (full-suite baseline delta, fail-closed)

1. Capture the gate1 baseline **once** before the first implement attempt.
2. Store failing-test **fingerprints** (file + test name + normalised error).
3. After implement, run gate1 again.
   - post passes → pass.
   - baseline was green → current strict behaviour (fail on any red).
   - baseline was red → fail only on **new or changed** fingerprints.
   - output unparseable → **fail closed**.
   - new failures appear → rerun once; only **persistent** new/changed failures block (flake guard).
4. **Do not** refresh the baseline across fix cycles (else the daemon can normalise its own regression).

## Recommended rollout (lowest blast radius first)

Codex's final call when weighing blast radius against the already-shipped no-regret
fixes: **ship #1b/#2/#4 now; phase #3 as follow-up.** Rationale (verbatim intent):
*"under task pressure, do not mix observability/convergence fixes with a safety-policy
relaxation unless the current bug is impossible to resolve without it."* With #1b/#2/#4
in place the bug is now diagnosable and convergent, so #3 is no longer a hard blocker —
it is an efficiency/UX improvement for self-targeted runs.

**Phase 1 (minimal, still safe):** one-time exit-code baseline.
- Run gate1 once before the first implement. If the whole suite is **already red**
  on the base branch, mark gate1 as **tainted** for this run and downgrade its
  failures to *warning* findings (non-blocking), captured once and reused across all
  fix cycles. If baseline is **green**, behave exactly as today (strict).
- No output parsing, no fingerprinting — just exit code.
- **Residual risk:** a regression introduced into an already-red suite slips past
  gate1. But the suite is already red so it cannot merge cleanly anyway, and the
  downstream `holdout`/`integrate`/`deploy`/`test` phases still run. Report the
  tainted-baseline status prominently on the run so a human sees it.

**Phase 2 (full A+):** add per-test failure fingerprinting + fail-closed parsing +
single flake-retry, baseline captured once and reused across fix cycles. This is the
correct long-term design but carries the most new machinery (vitest-output parsing,
a `RunState` schema field for the baseline, fail-closed handling) and should land as
its own reviewed PR.

## Test strategy for whichever phase is chosen (TDD)

- baseline `[A]`, post `[A]` ⇒ pass (with a warning finding).
- baseline `[A]`, post `[A,B]` ⇒ fail on `B`.
- baseline `[A:fp1]`, post `[A:fp2]` ⇒ fail (changed fingerprint) — Phase 2 only.
- baseline green, post red ⇒ fail exactly as today.
- unparseable baseline/post ⇒ fail closed — Phase 2 only.
- transient new `B` disappears on one retry ⇒ non-blocking — Phase 2 only.
- persistent new `B` after retry ⇒ blocking.
- baseline captured **once** and reused through all `maxFixCycles`.

## Cost note

A baseline adds one extra full-suite run per self-targeted run. With subscription
auth the `$` cost is ~0; only wall-clock time increases — still far cheaper than four
blind fix cycles plus escalation. (`$0 cost` in daemon logs is normal under
subscription auth and is **not** a failure signal.)
