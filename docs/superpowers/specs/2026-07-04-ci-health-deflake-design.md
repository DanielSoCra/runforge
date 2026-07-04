# CI Health Deflake — 2026-07-04 (design)

Three surgical fixes for the two flake classes and one visibility gap found in the
2026-07-03 24h CI window (36 runs: 27 success, 6 failure — all flakes, 3 cancelled).
One PR per fix. No product-code changes.

Evidence base: runs 28629487554, 28645073274, 28650116308, 28664591047,
28671567980, 28673901729 (failures); 28664593431, 28664595700 (cancelled main
runs). Root causes verified from `gh run view --log-failed` output.

## Goal

1. Eliminate the daemon real-PG "tick2 second-poll" flake class (4/6 failures).
2. Eliminate the operator-surface answer-flow E2E flake class (2/6 failures),
   completing what #828 started.
3. Guarantee every trunk commit gets a completed CI verdict (2 cancelled main
   runs on 2026-07-03 left the trunk tip unverified while a flake-failure on a
   superseded commit stood as main's latest status).

## Current state

### Fix 1 target — daemon.test.ts real-PG replay tests

`packages/daemon/src/control-plane/daemon.test.ts`, describe
`parked-run resume scan > decision-index enabled mode (real writer over real
Postgres)` (skipIf(!REAL_PG); REAL_PG = `AUTO_CLAUDE_TEST_DATABASE_URL` set):

- `records the answer BEFORE save and drives the ledger to resumed AFTER save
  (crash-safe ordering)` (~L3878) and
- `records the answer once when the resume tick sees the label twice
  (answered-once)` (~L3939)

both fire tick2 as a single `vi.advanceTimersByTimeAsync(30000)` +
`vi.advanceTimersByTimeAsync(0)` and then wait passively via `settleRealUntil`
on the answer-spy count (`n > seen`, labels `* tick2 second-poll answer
re-call`). Failure signature (4× on 2026-07-03): `settleRealUntil: '<label>'
not satisfied within 8000ms; last=1`.

Mechanism (documented in the file's own `advancePollsUntil` doc-comment,
L620–648): `RepoManager.startPoll` guards re-entrancy with `pollInProgress`; a
fake-timer interval fire landing while tick1's `onPoll` still drains REAL async
(postgres-js round-trips, fire-and-forget re-enter, trailing scans) is
swallowed and never re-fired — `settleRealUntil` (which deliberately never
advances fake timers) then waits forever. #839 (d38aaf2, merged 2026-07-03
19:05) added a per-run in-flight guard to `resumeParkedRuns` — a SECOND swallow
path for a tick2 that lands while run #100's resume chain is still in flight.
#814 already converted the DOUBLE-DELIVERY test to the re-firing
`advancePollsUntil` helper for exactly this reason; these two tests were left
on the old single-fire shape.

Guard infrastructure that exists today:
- `packages/daemon/src/test-hygiene.test.ts` — repo-wide anti-flake detectors
  (RC-1 ports, RC-2 temp paths, RC-3 cold-import timeout floor, RC-4
  fixed-budget drains in real-PG describes), built on a line-preserving
  `blankStringsAndComments` sanitizer. Detectors are exported functions with
  synthetic-case self-tests.
- `packages/daemon/src/cockpit-settle-deflake.gate.test.ts` — immovable gate:
  label-anchored positive checks, incl. a `double-delivery multi-tick re-fire
  gate` asserting the DOUBLE-DELIVERY test uses `advancePollsUntil` for its
  tick-2 re-read.

### Fix 2 target — operator-surface answer-flow E2E

`packages/dashboard/e2e/operator-surface.spec.ts:40` `answering a decision
posts through the real daemon and the row leaves`: after clicking Approve, line
50 expects `getByText(/answered/i)` visible. Failed 2× on main (00:06, 07:19,
both retries, `element(s) not found`) — both BEFORE #828 (c08f068, 13:45)
landed warm-up + budget raises.

What #828 did: `e2e/global-setup.mjs` warms `/steering` and
`/api/decisions/pending` (GET); `playwright.config.ts` expect 10s→15s, test
30s→45s, CI retries 1→2.

Residual gap: the answer flow's first `POST /api/decisions/answer` still
compiles that route on first hit (`next dev`), inside the timed expect window.
Hydration is NOT the suspect — in the failing runs the Answer dialog opened via
client JS (line 45–46) before the failing assert. The spec also has no
network-level anchor: when the badge doesn't appear there is no signal whether
the POST failed, hung, or never fired.

Harness facts (verified): `e2e/real-daemon.mjs` `/reset` fully re-seeds the
read model and clears recorded state; the spec's `test.beforeEach` POSTs it
before every test and retry. The proxy route validates JSON, then forwards via
`daemonFetch`; an unknown decision id yields a daemon 404 passed through
verbatim; no state is mutated for a nonexistent id.

### Fix 3 target — ci.yml concurrency

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

The comment declares "NEVER on main: every trunk commit must complete its own
CI". But `cancel-in-progress: false` only protects the RUNNING run. GitHub
allows at most ONE PENDING run per concurrency group: a newer run entering the
group CANCELS the queued one (pending-slot replacement). Observed 2026-07-03
13:45: 3-commit merge train → run for commit 1 completed (flake-failed), runs
for commits 2 and 3 (incl. the #828 deflake tip) CANCELLED — trunk tip had no
verdict. `scripts/check-ci-workflows.mjs` (the RC-1 workflow guard, with tests
in `scripts/check-ci-workflows.test.mjs`) has no opinion on concurrency today.

## Chosen designs

### Fix 1 — convert tick2 waits to `advancePollsUntil` + guard the pattern

PR `codex/ci-deflake-daemon-tick2-build`:

1. In both tests, replace the tick2 block

   ```ts
   await vi.advanceTimersByTimeAsync(30000);
   await vi.advanceTimersByTimeAsync(0);
   await settleRealUntil(() => answerSpy.mock.calls.length, (n) => n > seen, {
     label: '<label>',
   });
   ```

   with

   ```ts
   await advancePollsUntil(() => answerSpy.mock.calls.length, (n) => n > seen, {
     label: '<label>',
     pollPeriodMs: 30000,
   });
   ```

   Labels stay verbatim (`crash-safe ordering tick2 second-poll answer
   re-call`, `answered-once tick2 second-poll answer re-call`) — the gate test
   anchors on them. Tick1 waits are untouched (a first tick has nothing
   in-flight to swallow it).

   Safety argument (why re-firing extra ticks cannot break the assertions —
   confirmed by adversary review): both tests are replay/idempotency tests;
   each extra tick re-runs the daemon's own idempotency guards. Crash-safe
   ordering asserts on FIRST `answer` invocation order vs FIRST resume-save
   invocation order (`invocationCallOrder[0]` vs `findIndex`), which later
   calls cannot move. Answered-once's terminal wait asserts the row is out of
   `pending()` — extra replays land on a terminal row by design (that is the
   scenario under test).

2. `test-hygiene.test.ts`: add exported detector
   `findSecondTickPassiveWaitViolations(src, file)` — inside a
   `describe.skipIf(!REAL_PG)` region, per `it` body: count ONLY non-zero
   `vi.advanceTimersByTimeAsync(<nonzero>)` calls as poll fires —
   `advanceTimersByTimeAsync(0)` is a microtask flush belonging to the
   preceding fire and MUST NOT count (adversary round 1: counting it would
   false-positive existing legitimate single-poll tests, e.g. the reconcile
   tests near daemon.test.ts:4020/4066). A poll fire that is second-or-later
   in its `it` body and is followed by a passive `settleRealUntil(` before any
   further poll fire / `advancePollsUntil(` is a violation; escape hatch
   comment marker `second-tick-ok:` for future legitimate cases (e.g. a
   predicate satisfiable by tick1's effect alone). Reuses
   `blankStringsAndComments`. Synthetic-case self-test: fires on the old shape
   of these two tests; does NOT fire on one non-zero advance plus `(0)`
   flushes; marker respected; plain describes ignored; and the REAL converted
   daemon.test.ts is clean with zero markers. During implementation, run the
   detector over all packages: any hit besides the two converted tests is
   examined — convert it (genuinely multi-tick) or mark it with
   `second-tick-ok:` + a one-line justification.

3. `cockpit-settle-deflake.gate.test.ts`: extend the multi-tick re-fire gate —
   both converted labels must be bound to `advancePollsUntil` calls (same
   label-anchored positive-check shape as the DOUBLE-DELIVERY check).

Rejected: raising `timeoutMs` (a swallowed tick never lands — budget size is
irrelevant); firing N blind extra ticks (arbitrary; advancePollsUntil is the
established, self-documenting shape); exposing an `onPollSettled` daemon hook
(product-code blast radius for a test-only problem).

### Fix 2 — warm the answer POST route + network-anchor the assertion

PR `codex/ci-deflake-e2e-answer-build`:

1. `e2e/global-setup.mjs`: after the two GET warms, add a best-effort
   `warmAnswerRoute()`: `POST /api/decisions/answer` with valid JSON body
   `{ decision_id: '__route_warmup__', chosen_option: 'approve' }`,
   `Content-Type: application/json`. Valid-JSON-for-nonexistent-id (adversary
   correction) exercises the full path — route compile + `daemonFetch` +
   daemon 404 — and mutates nothing; response code is irrelevant, errors
   swallowed like the existing `warm()`. Tests re-seed via `/reset` in
   `beforeEach` anyway.

2. `operator-surface.spec.ts` answer test: create the response promise BEFORE
   the click, then assert on it:

   ```ts
   const [answerResponse] = await Promise.all([
     page.waitForResponse(
       (res) =>
         res.url().includes('/api/decisions/answer') &&
         res.request().method() === 'POST',
     ),
     page.getByRole('button', { name: 'Approve' }).first().click(),
   ]);
   expect(answerResponse.ok()).toBe(true);
   await expect(page.getByText(/answered/i).first()).toBeVisible();
   ```

   (Predicate form with an explicit POST-method check — keeps the diagnostic
   precise if a GET ever hits a similarly-named path.)

   The badge assert stays (it is the L3 optimistic-confirm behavior under
   test); the network anchor turns "badge missing" from a mystery into a
   attributable failure (POST non-ok vs UI regression) and consumes none of
   the visibility budget while the POST is in flight.

Rejected: further budget raises (masks); making the badge persistent in
product code (violates the L3 "disable + confirm; row leaves on the next
fetch" rule; product change for a test concern); dropping the badge assert
(loses the optimistic-confirm coverage).

### Fix 3 — per-sha concurrency group on main + guard the invariant

PR `codex/ci-main-concurrency-build`:

1. `.github/workflows/ci.yml`:

   ```yaml
   concurrency:
     group: ci-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}
     cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
   ```

   Main push runs get a group of their own (no shared pending slot → nothing
   to replace-cancel); branches/PRs keep the shared per-ref group with
   supersede-cancellation. `github.sha` is always non-empty on push. The
   runner is a single serial self-hosted mac — main runs already queue at the
   runner level, so per-sha groups add no real concurrency. Update the comment
   to name the pending-slot-replacement semantics.

2. `scripts/check-ci-workflows.mjs`: new check — any workflow triggering on
   push to main that declares a top-level `concurrency:` block must use a
   group expression that (a) discriminates by `github.sha` CONDITIONALLY on
   main (the `github.ref == 'refs/heads/main' && github.sha` discriminator,
   whitespace-flexible match) AND (b) retains a ref-based fallback for
   non-main refs (`|| github.ref`). An UNCONDITIONAL `github.sha` group (e.g.
   `group: ci-${{ github.sha }}`) is ALSO a violation — it would protect main
   but silently break branch/PR supersede-cancellation (adversary round 1:
   a naive "contains github.sha" scan false-passes this regression).
   Line-based scan in the file's established style (block-scalar and comment
   skipping reused); clear error naming the 2026-07-03 pending-slot incident.
   Scope: top-level `concurrency:` of push-to-main workflows only; job-level
   concurrency is out of scope (documented in the check's comment).
   `scripts/check-ci-workflows.test.mjs`: good case (conditional per-sha main
   group + ref fallback); bad cases: plain `ci-${{ github.ref }}` group,
   unconditional `github.sha` group, the discriminator appearing only in a
   comment or inside a block scalar (must still fail / not false-pass);
   non-main-push and no-concurrency workflows ignored.

Rejected: GitHub merge queue (changes the whole autonomous merge flow for a
queue-slot bug); dedicated main-only workflow file (duplication); accepting
the gap (an autonomous merge gate reads trunk CI verdicts — silent unverified
trunk commits are poison for it).

## Integration details

- **Fix 1 + #839 interaction:** with the per-run in-flight guard, a tick2 that
  lands mid-resume skips the run and logs; `advancePollsUntil` keeps re-firing
  until the answer re-call lands after guard release. The predicate reads the
  spy count, an early in-poll signal. Downstream asserts differ per test and
  are unchanged: answered-once waits on the durable terminal state
  (`settleRealUntil` on `pending()` excluding #100); crash-safe ordering
  asserts invocation order of FIRST answer vs FIRST resume-save and then reads
  `pending()` directly — safe because its tick1 wait (`reenteredPipeline`)
  already proved the full resume chain ran, and the answer re-call predicate
  proves tick2 progressed past answer.
- **Fix 1 detector scope:** codex scan + conductor grep confirm only the two
  named tests have the single-fire-tick2 shape today; the detector must be
  clean on the converted file with zero markers.
- **Fix 2 auth:** e2e webServer runs with the local auth bypass (admin
  session); if the warm-up POST is ever rejected by auth it still compiled the
  route — warm-up asserts nothing by design.
- **Fix 2 waitForResponse scope:** URL glob `**/api/decisions/answer` matches
  the proxy route exactly; the harness posts no other traffic to it.
- **Fix 3 guard false-positive risk:** the check must only fire for workflows
  with BOTH a push-to-main trigger AND a top-level concurrency group lacking a
  main-sha discriminator; workflow_dispatch-only or PR-only workflows are out
  of scope. ci.yml is currently the only workflow file.
- **Traceability:** governing specs: fix 1 → daemon test_paths
  (STACK-AC-OPERATIONAL-SAFETY et al.); fix 2 →
  STACK-AC-OPERATOR-SURFACE-CLIENT; fix 3 → STACK-AC-CONVENTIONS (ci.yml +
  check-ci-workflows.mjs already in its code_paths). Fixes 1 and 3 touch only
  files already listed in traceability.yml. Fix 2 introduces ONE new file —
  the acceptance-gate test
  `packages/dashboard/answer-flow-hardening.gate.test.ts` (authored at
  the implementation stage's GATE step, per the plan's gate-ownership
  section) — which is registered under STACK-AC-OPERATOR-SURFACE-CLIENT
  test_paths in the same branch that adds it (fix-2's branch only; the
  registration must not ride the shared docs into the other PRs).

## File topology

| PR | Branch | Files |
|---|---|---|
| 1 | `codex/ci-deflake-daemon-tick2-build` | `packages/daemon/src/control-plane/daemon.test.ts`, `packages/daemon/src/test-hygiene.test.ts`, `packages/daemon/src/cockpit-settle-deflake.gate.test.ts` |
| 2 | `codex/ci-deflake-e2e-answer-build` | `packages/dashboard/e2e/global-setup.mjs`, `packages/dashboard/e2e/operator-surface.spec.ts`; PR additionally carries the gate-authored `packages/dashboard/answer-flow-hardening.gate.test.ts` + its `.specify/traceability.yml` registration (implementer-untouchable) |
| 3 | `codex/ci-main-concurrency-build` | `.github/workflows/ci.yml`, `scripts/check-ci-workflows.mjs`, `scripts/check-ci-workflows.test.mjs` |

## Test strategy

- **Fix 1:** `AUTO_CLAUDE_TEST_DATABASE_URL` MUST be set (docker
  `postgres:18-alpine`, mirroring ci.yml) — without it the real-PG suite skips
  and a green run is hollow. Run `pnpm --filter @auto-claude/daemon test` with
  it; additionally run the converted tests 3× to sample flake resistance.
  Detector self-tests run in the same suite.
- **Fix 2:** `pnpm --filter @auto-claude/dashboard e2e --project=desktop`
  locally (webServer + real-daemon harness are self-contained).
- **Fix 3:** `node --test scripts/check-ci-workflows.test.mjs` (or the repo's
  invocation) + run `node scripts/check-ci-workflows.mjs` against the edited
  ci.yml (must pass) and against a synthetic regressed copy (must fail — test
  covers this). YAML validity via the guard job on the PR itself.
- All 3 PRs: full `pnpm lint && pnpm typecheck && pnpm test` before push; CI
  on the PR is the final oracle.

## Risks

- **Fix 1:** re-fired ticks could in principle surface OTHER latent
  idempotency bugs (that is signal, not flake — the daemon's guards are the
  subject under test). `advancePollsUntil`'s 8s deadline stays; under extreme
  load the re-fire loop keeps landing ticks so the deadline is now load-
  tolerant.
- **Fix 2:** a `waitForResponse` that never matches fails at the test timeout
  (45s) instead of the expect budget (15s) — acceptable: it fails with a
  clearer signal, and only when the POST genuinely never completed.
- **Fix 3:** rapid merge trains now run CI once per trunk commit (no
  supersede-skip). On the serial runner a 3-commit train costs ~3×13min of
  queue — the price of the documented invariant; acceptable at current merge
  volume (11 PRs was the busiest day on record; guard job keeps each run
  bounded at 25min).

## Follow-ups (out of scope)

- Flake-visibility probe (#792 draft) — this initiative's failure evidence
  strengthens its case; not touched here.
- Dashboard lint warnings (✖ 5 warnings on every CI run) — cosmetic noise.
- #714 item 2 (residual `stash failed` merge transient) — pending repro.

## Migration plan

None — test/e2e/workflow-guard changes only; no schema, no API, no data.

## Open questions for the Operator

None blocking. Fix 3 trades runner minutes for per-commit trunk verdicts at
main-merge-train time; the workflow comment already declared that intent, so
this is enactment, not a new policy decision.
