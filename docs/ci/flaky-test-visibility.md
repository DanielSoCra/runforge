# CI flaky-test visibility (non-masking)

**Status:** proposed — open for Operator review (design-sensitive: anti-masking).

## Problem

CI has no flaky-test signal. When a test fails nondeterministically, the run goes
red exactly like a real regression. There is no record of *which* failures are
flaky, so:

- The autonomous pipeline can't safely distinguish "retry this, it's flaky" from
  "this is a real failure, escalate."
- The daily CI-health digest has to infer flakiness by hand, correlating
  fail-then-pass across separate runs (e.g. the gap6 run that failed then passed
  and merged on a retry — invisible after the fact).

## Design

A `Flaky-test probe` step in `ci.yml` that runs **only when the `Test` step itself
failed** (gated on `steps.test.outcome == 'failure'`, so a lint/typecheck failure
never triggers a misleading test re-run). It re-runs `pnpm test` **once** and
classifies:

| Gating `pnpm test` | Isolated re-run | Verdict |
|--------------------|-----------------|---------|
| failed             | **passed**      | **flaky** → `::warning::` + `flake-report` artifact |
| failed             | failed          | **deterministic** → real failure, fix it |

The `Test` step tees the first failing run to `flake-gating.log`; the probe writes
the isolated re-run to `flake-reprobe.log`. The upload step stores both logs plus
`flake-verdict.txt` as the `flake-report` artifact.

## The non-masking guarantee

**A red build stays red.** The job has already failed at the `Test` step before the
probe runs; the probe is an `if: failure()` *informational* step and never alters
job status (it `exit 0`s so a flaky verdict isn't itself noise). We add
*information*, never *leniency*. This is deliberately **not** vitest's `retry: N`,
which turns red→green when a test passes on retry — that is masking, and is
rejected here.

## Tradeoffs / edge cases

- **Cost:** on a red *Test* build the suite runs a second time (~the suite's
  duration). Only red Test builds pay it, which should be rare. The cheaper
  surgical alternative — parse the vitest JSON reporter to re-run only the failed
  *files* — is left as a follow-up (needs per-package JSON aggregation across the
  `pnpm -r test` monorepo fan-out).
- **Double-unlucky flake:** a flake that fails the gating run *and* the re-run is
  labeled `deterministic`. That's the conservative direction — we never label a
  real failure as ignorable-flaky; worst case a flake is under-reported, not a
  regression waved through.

## Operator decisions (why this is left open, not merged)

1. Accept the full-suite re-probe cost, or hold for the surgical (failed-files-only)
   version first?
2. Should a downstream consumer (the daemon / operator loop) be allowed to
   *auto-retry* a failure classified `flaky` by this probe — and if so, with what
   cap? That edges toward auto-masking and is exactly the policy call to make
   deliberately, not by default.
