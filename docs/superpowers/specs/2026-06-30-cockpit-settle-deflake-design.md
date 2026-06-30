# Design: Deterministic settle for the real-Postgres resume suites (CI deflake)

- **Date:** 2026-06-30
- **Status:** spec (codex-reviewed)
- **Topic:** `cockpit-settle-deflake`
- **Authors:** CONDUCTOR (Claude) + ADVERSARY (codex GPT-5.5)

## Goal

Make the `packages/daemon` real-Postgres resume tests **deterministic regardless of CI
runner CPU load**, and **guard against the fixed-budget-drain anti-pattern recurring**.
A test must not pass-or-fail based on how many localhost Postgres round-trips happen to
fit inside a fixed wall-clock budget.

## Current state (the flake)

CI run `28373930107` (2026-06-29) failed attempt 1, passed attempt 2 (GitHub auto-retry
masked it). Two tests in `packages/daemon/src/control-plane/daemon.test.ts`, suite
`parked-run resume scan › cockpit answer consumer (Slice 2)`:

- `HAPPY PATH: cockpit approve … re-enters the SAME run` — `statusOf(decisionId)` expected
  `'resumed'`, got `'source_written'` (daemon.test.ts:4093).
- `DOUBLE-DELIVERY: … re-enters EXACTLY ONCE` — expected 1 re-entry, got 2
  (daemon.test.ts:4144).

### Root cause

The post-answer ledger chain `advanceToResumed`
(`packages/daemon/src/control-plane/decision-escalation/ledger.ts:135`) is **two
sequential real-timer Postgres effects**:

```
answered_pending_source_write --write_response--> source_written --requeue/resume--> resumed
```

The suite fakes **only** the `setInterval` poll loop (and `Date`); the postgres-js writer
runs on **real** `setTimeout`/`setImmediate` + sockets (daemon.test.ts:4032-4036). Tests
bridge the gap with `settleRealAsync(turns = 60)` — a **fixed ~300 ms wall-clock budget**
(`60 × setTimeout(5ms)`, daemon.test.ts:579). Under the shared self-hosted runner's CPU
contention (the documented RC-3 floor) the ~10 sequential localhost PG round-trips of the
resume chain overrun 300 ms, so:

- the second effect (`→ resumed`) has not landed when the assertion reads `statusOf`
  → sees the intermediate `source_written`;
- in DOUBLE-DELIVERY the idempotency guard (`status === 'resumed'`, checked by the resume
  consumer to skip already-consumed answers) is not yet durable when the next poll tick
  fires → the run re-enters a second time.

This is the same class as RC-1/2/3: a **fixed resource budget** that is adequate at idle
and insufficient under concurrent load on the shared runner.

## Chosen design — A: condition-polling settle helper (scoped)

Add a `settleRealUntil(predicate, opts)` helper alongside `settleRealAsync` and migrate the
real-Postgres **positive resume-completion waits** to it. The deterministic contract becomes:
*the fake timer advance starts the poll tick; real-time polling then waits until the durable
effect the test asserts is observable* — never a fixed time budget.

```ts
// Drains real async until `predicate(state)` holds, or throws after timeoutMs with the
// last-seen state. Uses performance.now() because Date is faked in these suites; advances
// NO fake timers (that would inject extra poll ticks and mask the very bug we fix).
// Checks the deadline BEFORE sleeping so the diagnostic fires tight (codex minor 1).
async function settleRealUntil<T>(
  read: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: { label: string; timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 8_000; // per-call; well under the 30s testTimeout
  const intervalMs = opts.intervalMs ?? 15;
  const deadline = performance.now() + timeoutMs;
  let last = await read();
  while (!predicate(last)) {
    if (performance.now() >= deadline) {
      throw new Error(
        `settleRealUntil: '${opts.label}' not satisfied within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    await Promise.resolve();
    last = await read();
  }
  return last;
}
```

**Per-call timeout, not per-test** (codex minor 2): default `8_000ms` so that even a test
with 2–3 sequential waits throws the legible `settleRealUntil` diagnostic *before* vitest's
opaque 30 s `testTimeout` kills the test. A healthy wait returns in <1 s; the budget only
matters on a genuine hang, where a fast, labelled failure beats a slow opaque one.

### Why not the alternatives

- **B (bump the fixed budget 60→300):** still a fixed budget — only moves the flake
  threshold under heavier load. Same RC-3 smell. Rejected.
- **C (production `onResumeSettled` seam):** the daemon already `await`s `answer()` and
  `advanceToResumed()` internally; the nondeterminism lives entirely in the **harness**
  compressing a faked 30 s tick into wall-clock ms. A predicate over the **public ledger
  state** (`statusOf`) preserves the behavior under test without a production test seam.
  Rejected (no production code change).
- **D (drive the chain synchronously in the test):** bypasses the poll-loop + real-timer
  path, changing what the test exercises. Rejected.
- **E (`vitest retry`):** masks the flake instead of fixing it. Rejected.

## Integration details

0. **Predicate = the LAST observable (the pipeline re-entry), which dominates `resumed`.**
   Tracing `resumeParkedRuns` (daemon.ts): the order is `answer` → `saveRunState` (2730) →
   `removeLabel` (2742) → **`advanceToResumed` → `resumed` (2763)** → **`reenterPipeline`
   (2772)**, and `reenterPipeline` itself `await`s `readAgencyConfig` (3004) *before* it calls
   `runPipeline` (3045). So the **pipeline re-entry is the last effect of a successful resume**
   — strictly after `answer`, `saveRunState`, `removeLabel`, and `resumed`. A
   `statusOf === 'resumed'`-only predicate (codex's first suggestion) can return in the window
   after `resumed` is durable but before `runPipeline` is observed, re-introducing a smaller
   race on the re-entry / `saveRunState` / `removeLabel` assertions.
   **Default predicate (uniform): wait until the pipeline re-entry for the issue is observed**
   — `mockRunPipeline.mock.calls.some(c => c[0]?.issueNumber === N)`. Because re-entry is last,
   this single condition guarantees *every* earlier positive effect the tests assert
   (`resumedSave` defined, `statusOf === 'resumed'`, `removeLabel('ready')`, crash-safe
   ordering). The integrate path uses the same `reenterPipeline`/`runPipeline`, so the
   predicate is identical there. The existing `expect(statusOf).toBe('resumed')` assertions
   are **kept** (now guaranteed) — they also act as an ordering guard: a future reorder that
   broke "resumed before re-entry" would *fail* these tests, not silently flake them.
   **Missing-row exception:** the "ledger row MISSING (answer no-ops; index never blocks
   resume)" test has no `resumed` row to wait on — it uses the same re-entry predicate (the
   requeue still re-enters), which is exactly the "wait on the asserted side effect" codex
   asks for (Important 2).

   **EDGE-TRIGGERED repeated waits (codex r2 Important 1).** The re-entry predicate is
   *level-triggered*: once `mockRunPipeline` has a call for the issue it stays satisfied
   forever, so a *second* `settleRealUntil(re-entry)` in a **two-tick** test returns instantly
   without proving the second poll ran — silently weakening the very replay/exactly-once tests
   that need two ticks. Every repeated wait must therefore key off a **fresh, per-poll
   observable**, captured *before* advancing the next tick:
   - **Cockpit l2-gate path** (DOUBLE-DELIVERY): the second poll re-reads `statusOf` (the
     idempotency guard at `daemon.ts:2544`, which lives **only** in the cockpit branch
     `!hasApproved && !hasRejected`). Edge = `statusSpy.mock.calls.length > seen`.
   - **Legacy `l2-approved` path** (`decision-index enabled mode` two-tick tests: crash-safe
     ordering, answered-once): there is **no** `statusOf` guard on this branch — the legacy
     path calls `ledger.answer(decisionId, choice)` **unconditionally every poll**
     (`daemon.ts:2618`; `answer()` is answered-once at the ledger, but the daemon still *calls*
     it). Edge = `answerSpy.mock.calls.length > seen` (spy `manager.ledger().answer`).
   - The re-entry/`findParkedRuns` counters are *not* reliable edges here: `findParkedRuns`
     incrementing proves a poll *started*, not that it *processed the run to its guard*.
   - **`activeIssues` dependency** (don't drop the inter-tick microtask flush): the poll skips a
     run that is still active (`daemon.ts:2432 if (activeIssues.has(run.issueNumber)) continue`).
     `reenterPipeline` adds the issue (2998) and the pipeline's `.finally` removes it on
     completion (`mockRunPipeline` resolves immediately, so this is a microtask). The two-tick
     pattern must keep the existing `await vi.advanceTimersByTimeAsync(0)` microtask flush
     between ticks so the first resume's `.finally` clears `activeIssues` **before** tick 2 —
     otherwise tick 2's poll short-circuits at 2432, never re-calls `answer()`, and the
     answer-spy edge would hang to its 8 s timeout. (The tick-1 `settleRealUntil(re-entry)`
     wait already spans several real-timer polls, so the `.finally` has run by the time it
     returns; the explicit `advanceTimersByTimeAsync(0)` makes it deterministic.)
1. **No fake-timer advance inside `settleRealUntil`.** Once a poll tick has kicked the
   resume chain, the chain proceeds on real timers; the loop only drains real async. Calling
   `vi.advanceTimersByTimeAsync` inside the loop would inject extra poll ticks and could mask
   a genuine double-re-entry. (codex Q1)
2. **`performance.now()`, not `Date.now()`** — `Date` is faked in these suites, so a
   `Date.now()` deadline never advances. (codex Q1)
3. **DOUBLE-DELIVERY restructure** (codex Q2 + Important 3 + the §0 ordering):
   - `const statusSpy = vi.spyOn(manager.ledger(), 'statusOf')` before the ticks.
   - tick 1 → `settleRealUntil(() => reentryCount(#100) === 1)` → assert exactly one re-entry
     (re-entry is last, so the answer is recorded and the row is durably `resumed`).
   - record `const seen = statusSpy.mock.calls.length`.
   - tick 2 → `settleRealUntil(() => statusSpy.mock.calls.length > seen)` — this **waits until
     the second poll has actually executed its idempotency guard** (`statusOf` re-read at the
     top of `resumeParkedRuns`), closing codex's false-pass window where a "short drain" asserts
     before the second poll reaches the guard.
   - assert re-entry count **still 1** and `statusOf === 'resumed'`.

   This proves **replay idempotency after the durable guard exists**: the second poll observed
   `resumed` and short-circuited. It does **not** prove overlapping in-flight single-flight (two
   pollers racing the *same* uncommitted answer) — a distinct concern, captured as a follow-up,
   not expanded here.
4. **Negative / pure-drain assertions stay on `settleRealAsync`** (codex Q5): a test that
   asserts the chain did **not** advance (`statusOf === 'notified'`, "stays parked",
   `resetSaves` length 0) cannot use wait-until — the condition is already true and must be
   shown to *remain* true, for which a bounded drain is the right tool. Likewise the
   **fake in-memory ledger** describe (`integrate park resume (round-trip, CI-default fake —
   no Postgres)`) settles synchronously and is not load-sensitive. These keep
   `settleRealAsync` and carry an explicit `// fixed-drain-ok: <reason>` marker.

## File topology

- `packages/daemon/src/control-plane/daemon.test.ts`
  - **Add** `settleRealUntil` next to `settleRealAsync` (~line 579).
  - **Migrate** every **real-PG positive resume-completion** wait (all three
    `describe.skipIf(!REAL_PG)` resume describes) to `settleRealUntil` (see migration scope).
  - **Mark** every retained `settleRealAsync` *inside a real-PG resume describe* with
    `// fixed-drain-ok: <reason>` (negative non-advancement assertions; the fake/no-PG
    describe is outside the real-PG describes and needs no marker, but is marked anyway for
    clarity).
- `packages/daemon/src/test-hygiene.test.ts`
  - **Add** an `RC-4`-style guard scoped to the **real-PG resume describes** in
    `daemon.test.ts`: locate each `describe.skipIf(!REAL_PG)(` block (brace-tracked range) and
    flag any `await settleRealAsync(` inside it **unless** a `fixed-drain-ok` marker appears on
    that line or an immediately adjacent line. This catches positive resume waits regardless of
    *which* side effect they assert (`statusOf`, `pending()` exclusion, `saveRunState`,
    `mockRunPipeline`, `removeLabel`) — closing the false-negatives codex flagged (Important 4)
    — while the `fixed-drain-ok` escape hatch documents the legitimate negative/drain cases.
  - **Marker is read from RAW source, not stripped source** (codex r2 Minor 1): the existing
    `findHygieneViolations` runs on `stripComments(src)` (test-hygiene.test.ts:55), which would
    erase the `// fixed-drain-ok` comment before the RC-4 scan could see it. RC-4 must operate
    on the **raw file lines** (its own scanner) so the marker survives — both the
    `settleRealAsync` call and its marker are matched against un-stripped lines.

## Migration scope (broadened per codex Importants 1 & 2)

The rule is **"every real-PG positive resume-completion wait"**, not just the two that
flaked. All such sites adopt the **default re-entry predicate** (§0) — *wait until the
pipeline re-entry for the issue is observed* — except where noted. Line numbers are current
HEAD and are **re-derived in the plan** (`grep`), never hardcoded into edits.

**Describe `decision-index enabled mode (real writer over real Postgres)`** — migrate (these
are **legacy `l2-approved`-label** tests → edge observable is the `answer` spy, §0):
- crash-safe ordering (settles 3728/3731; **two-tick**): spy `manager.ledger().answer`; tick 1
  → `settleRealUntil(re-entry #100)`; record `seen = answerSpy.mock.calls.length`; tick 2 →
  `settleRealUntil(answerSpy.mock.calls.length > seen)`; then the existing `answer`-before-save
  ordering + `pending()`-excludes assertions.
- answered-once (3779/3782; **two-tick**): add `answerSpy`; same edge pattern; then the
  existing `pending()`-excludes assertion (replay landed on the resumed row, recorded once).
- requeues when row MISSING (3817; one tick; `saveRunState` + `mockRunPipeline` — **no
  `resumed` row**, re-entry predicate is the side-effect wait codex asked for)
- periodic reconcile (3847; one tick; predicate: `reconcileSpy.mock.calls.length > 0` — this
  test has **no re-entry**, so it waits on its own asserted side effect)
- FLAG ON l2-rejected → l2-design (3920; one tick; `mockRunPipeline` called)
- FLAG ON sanitize placeholder (3964; one tick; re-enters)

**Describe `cockpit answer consumer (Slice 2)`** — migrate: HAPPY PATH (4078), DOUBLE-DELIVERY
(4132/4135, §3), REJECT (4177 — **capture `decisionId`**, codex Important 1), ready-label
removal (4263 — asserts `removeLabel('ready')`, re-entry predicate covers it).

**Describe `integrate park resume (follow-up #9)`** — migrate: APPROVE (4409), APPROVE legacy
(4478), APPROVE pre-rename (4544, uses `decision_id`), REJECT (4585), CRASH-SAFE (4670 —
`answer` before `saveRunState` ordering).

**Keep `settleRealAsync` + `// fixed-drain-ok`:**
- `stays parked (fail-closed) when the ledger is broken` (3875) — asserts **no** advance
  (`mockRunPipeline` not called, `resetSaves` length 0); a negative cannot be a wait-until.
- cockpit Slice 2 NO-ANSWER stays-parked (4225) and integrate NO-ANSWER stays-parked (4631) —
  assert `statusOf 'notified'` / no re-entry (negative).
- the **fake / no-Postgres** describe `integrate park resume (round-trip, CI-default fake)`
  (4826, 4860) — synchronous in-memory ledger, not load-sensitive (outside the real-PG
  describes; marked for clarity, not required by the guard).

## Test strategy

- The **existing** real-PG resume tests (all three `describe.skipIf(!REAL_PG)` describes) are
  the oracle — they already encode the required behavior. The fix changes only **how the test
  waits**, never what it asserts. The behavioral `expect(...)` lines are a **do-not-modify**
  set for the implementer; only the `settleRealAsync()` → `settleRealUntil(...)` settle calls
  (and the DOUBLE-DELIVERY tick/spy scaffolding per §3) change.
- Acceptance:
  1. the full `packages/daemon` suite passes against real Postgres
     (`AUTO_CLAUDE_TEST_DATABASE_URL` set) — `pnpm --filter @auto-claude/daemon test`;
  2. `test-hygiene.test.ts`'s new guard **fires** on a synthetic `settleRealAsync` placed in a
     real-PG resume describe without a `fixed-drain-ok` marker, and **passes** on the migrated
     `daemon.test.ts` (verified by `findHygieneViolations`-style unit assertions over fixtures,
     matching the existing RC-1/2 guard's test shape);
  3. `pnpm --filter @auto-claude/daemon typecheck` and `pnpm lint` clean.
- Robustness intent (not a CI assertion): the migrated tests pass under artificial CPU load
  (concurrent `pnpm test` runs) where the fixed-budget version flaked — the conductor runs
  this in Phase 9.

## Risks

- **`settleRealUntil` predicate reads a stale abstraction** → use `manager.ledger().statusOf`
  directly and `await` every read. (codex Q6)
- **Interval starves the real writer** → 15 ms interval + `await Promise.resolve()` yields the
  loop; do not spin tighter. (codex Q6)
- **Helper consumes the whole 30 s test budget** → per-call default 8 s (§ Chosen design) and
  throw a diagnostic error (label + last-seen state) so a genuine hang fails fast and legibly,
  not as an opaque vitest timeout. (codex Q3 + Minor 2)
- **Guard false-positives** on legitimate drains → the `fixed-drain-ok` escape hatch +
  real-PG-resume-describe scope (not the whole file) keep it precise.

## Follow-ups (out of scope)

- A dedicated **overlapping in-flight single-flight** test (two pollers racing the same
  uncommitted answer), per codex Q2.
- Non-masking CI flake visibility (attempt > 1 surfaced) — already drafted as **#792**;
  land that rather than duplicating here.

## Open questions for stakeholder

None blocking. Defaults `timeoutMs = 8_000` (per call) / `intervalMs = 15` are configurable.
