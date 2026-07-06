# Cockpit-settle deflake — Implementation Plan

> **For agentic workers:** implement task-by-task. This plan is consumed by the sparring
> IMPLEMENTER against an immovable acceptance gate. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the `packages/daemon` real-Postgres resume tests deterministic under CI runner
load by replacing fixed-budget `settleRealAsync(n)` drains with a condition-polling
`settleRealUntil(...)`, and add a hygiene guard that forbids the fixed-drain anti-pattern in
real-PG resume describes.

**Architecture:** Test-only change. A new `settleRealUntil(read, predicate, opts)` helper in
`daemon.test.ts` drains real async until the asserted resume effect is observable (never a
fixed time budget). The default predicate waits on the **pipeline re-entry** (the last effect
of a successful resume); two-tick replay tests use an **edge-triggered** per-poll observable.
A new RC-4 guard in `test-hygiene.test.ts` enforces the pattern.

**Tech Stack:** TypeScript, Vitest (fake `setInterval`/`Date`, real `setTimeout`), postgres-js,
the decision-index ledger.

## Global Constraints (verbatim from the spec)

- **Do NOT modify any behavioral `expect(...)` assertion.** Only the settle calls and the
  DOUBLE-DELIVERY / two-tick tick-and-spy scaffolding change. The assertions are the oracle.
- `settleRealUntil` uses `performance.now()` (NOT `Date.now()` — `Date` is faked), advances
  **no** fake timers, checks the deadline **before** sleeping, default per-call timeout
  `8_000ms`, interval `15ms`, throws a diagnostic with label + last-seen value on timeout.
- The default predicate is **the pipeline re-entry observed** for the issue
  (`mockRunPipeline.mock.calls.some(c => (c[0]).issueNumber === N)`) — the last/dominant effect.
- Repeated waits in a multi-tick test must be **edge-triggered** on a fresh per-poll observable
  (cockpit path → `statusOf` spy; legacy `l2-approved` path → `answer` spy). Keep the inter-tick
  `await vi.advanceTimersByTimeAsync(0)` so the first resume's `.finally` clears `activeIssues`
  (daemon.ts:2432) before the next tick.
- The RC-4 guard reads the `fixed-drain-ok` marker from **raw** source (not `stripComments`).
- No production code changes. No new files (so `traceability.yml` is unchanged).

---

## File Structure

- `packages/daemon/src/control-plane/daemon.test.ts` — add `settleRealUntil`; migrate the three
  `describe.skipIf(!REAL_PG)` resume describes; mark retained drains `fixed-drain-ok`.
- `packages/daemon/src/test-hygiene.test.ts` — add exported `findFixedDrainViolations(rawSrc,
  label)` + two `it` blocks (fires-on-synthetic-bad / passes-on-real-file), mirroring the
  existing `findHygieneViolations` shape.

All line numbers below are **current HEAD** and shift as edits land — **re-derive with `grep`
before each edit**:
```bash
grep -n "settleRealAsync\|describe.skipIf(!REAL_PG)\|statusOf\|resumeReentries\|reconcileSpy\|answerSpy" \
  packages/daemon/src/control-plane/daemon.test.ts
```

---

## Task 1: Add the `settleRealUntil` helper

**Files:** Modify `packages/daemon/src/control-plane/daemon.test.ts` (next to `settleRealAsync`,
~line 579).

**Interfaces — Produces:**
`settleRealUntil<T>(read: () => Promise<T> | T, predicate: (v: T) => boolean, opts: { label: string; timeoutMs?: number; intervalMs?: number }): Promise<T>`

- [ ] **Step 1: Add the helper** immediately after the `settleRealAsync` function.

```ts
/**
 * Drain real async until `predicate(read())` holds, then return the last read value.
 * For the real-Postgres resume suites: the faked poll tick KICKS the resume chain, which
 * then proceeds on REAL timers (postgres-js). This waits on the durable effect the test
 * asserts instead of a fixed wall-clock budget, so it cannot flake under runner CPU load.
 *
 * - performance.now(), not Date.now() — `Date` is faked in these suites.
 * - advances NO fake timers (extra poll ticks would mask a genuine double-re-entry).
 * - checks the deadline BEFORE sleeping so the diagnostic fires tight.
 * - per-call default 8s: a healthy wait returns in <1s; on a genuine hang a labelled
 *   throw beats vitest's opaque 30s testTimeout (even for tests with 2-3 sequential waits).
 */
async function settleRealUntil<T>(
  read: () => Promise<T> | T,
  predicate: (v: T) => boolean,
  opts: { label: string; timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
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

/** A run was re-entered into the pipeline (the LAST effect of a successful resume). */
function reenteredPipeline(issueNumber: number): boolean {
  return mockRunPipeline.mock.calls.some(
    (c) => (c[0] as { issueNumber?: number } | undefined)?.issueNumber === issueNumber,
  );
}
/** Count of pipeline re-entries for an issue (for exact-once assertions). */
function reentryCount(issueNumber: number): number {
  return mockRunPipeline.mock.calls.filter(
    (c) => (c[0] as { issueNumber?: number } | undefined)?.issueNumber === issueNumber,
  ).length;
}
```

- [ ] **Step 2: Typecheck.** Run: `pnpm --filter @runforge/daemon typecheck`. Expected: clean
  (the helpers are unused until later tasks — TS `noUnusedLocals` is off for these or they are
  referenced soon; if a strict unused error appears, proceed to Task 2 which uses them and
  re-check).

- [ ] **Step 3: Commit.**
```bash
git add packages/daemon/src/control-plane/daemon.test.ts
git commit -m "test(daemon): add settleRealUntil condition-poll helper (deflake)"
```

---

## Task 2: Migrate `cockpit answer consumer (Slice 2)` (the describe that flaked)

**Files:** Modify `daemon.test.ts` describe at ~3983.

**Migration map** (re-grep line numbers first):

| it | current settle | action |
|---|---|---|
| HAPPY PATH (~4045) | `settleRealAsync()` @4078 | → `await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: 'cockpit approve re-entry #100' });` |
| DOUBLE-DELIVERY (~4097) | `settleRealAsync()` @4132 & @4135 | restructure per Step 2 below |
| REJECT (~4149) | `settleRealAsync()` @4177 | capture `decisionId`, then `await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: 'cockpit reject re-entry #100' });` |
| NO-ANSWER (~4196) | `settleRealAsync()` @4225 | KEEP — add `// fixed-drain-ok: negative — asserts stays-parked (no re-entry, statusOf stays 'notified')` on the line above |
| ready-removal (~4238) | `settleRealAsync()` @4265 | → `await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: 'cockpit ready-removal re-entry #100' });` |

- [ ] **Step 1: HAPPY PATH, REJECT, ready-removal** — replace each `await settleRealAsync();`
  with the `settleRealUntil(() => reenteredPipeline(100), Boolean, {label})` call from the map.
  For REJECT, the test currently does not bind the decision id — change
  `await seedNotified(manager, 100);` to `const decisionId = await seedNotified(manager, 100);`
  (the existing `statusOf` assertion, if any, and the label need it; if REJECT has no `decisionId`
  use it only where referenced — do not add unused vars).

- [ ] **Step 2: DOUBLE-DELIVERY** — restructure to edge-triggered exact-once. Replace the
  two-tick block (the two `advanceTimersByTimeAsync(30000)/(0)/settleRealAsync()` groups) with:

```ts
const statusSpy = vi.spyOn(manager.ledger(), 'statusOf');

// Tick 1: the answer is delivered; wait until the run re-entered EXACTLY once
// (re-entry is the last effect, so the row is durably `resumed` by now).
await vi.advanceTimersByTimeAsync(30000);
await vi.advanceTimersByTimeAsync(0);
await settleRealUntil(() => reentryCount(100), (n) => n === 1, {
  label: 'double-delivery tick1 single re-entry #100',
});
const seen = statusSpy.mock.calls.length;

// Tick 2: the SAME answer is seen again. Wait until the second poll has actually
// re-executed its statusOf idempotency guard (daemon.ts:2544, cockpit branch),
// then assert it did NOT re-enter.
await vi.advanceTimersByTimeAsync(30000);
await vi.advanceTimersByTimeAsync(0);
await settleRealUntil(() => statusSpy.mock.calls.length, (n) => n > seen, {
  label: 'double-delivery tick2 second-poll guard re-read',
});
```
Leave the existing assertions below it unchanged (`claimWork` not called, `resumeReentries`
length 1, `statusOf === 'resumed'`).

- [ ] **Step 3: NO-ANSWER** — add the `// fixed-drain-ok:` marker line directly above its
  `await settleRealAsync();`.

- [ ] **Step 4: Run the describe** (needs real Postgres — see the "Running real-PG tests" box).
  Run: `RUNFORGE_TEST_DATABASE_URL=$PG pnpm --filter @runforge/daemon test -t "cockpit answer consumer"`
  Expected: all pass.

- [ ] **Step 5: Commit.**
```bash
git add packages/daemon/src/control-plane/daemon.test.ts
git commit -m "test(daemon): deterministic settle for cockpit answer consumer (Slice 2)"
```

---

## Task 3: Migrate `decision-index enabled mode (real Postgres)` (legacy `l2-approved` path)

**Files:** Modify `daemon.test.ts` describe at ~3650.

**Migration map:**

| it | current settle | action |
|---|---|---|
| crash-safe ordering (~3690) | `settleRealAsync()` @3728 & @3731 (two-tick) | Step 1 (answer-spy edge) |
| answered-once (~3751) | `settleRealAsync()` @3779 & @3782 (two-tick) | Step 2 (answer-spy edge) |
| requeues when row MISSING (~3792) | `settleRealAsync()` @3817 | → `await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: 'missing-row requeue re-entry #100' });` |
| periodic reconcile (~3830) | `settleRealAsync()` @3847 | → spy + `await settleRealUntil(() => reconcileSpy.mock.calls.length, (n) => n > 0, { label: 'tick reconcile' });` |
| FLAG ON reject → l2-design (~3887) | `settleRealAsync()` @3920 | → `await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: 'flag-on reject re-entry #100' });` |
| FLAG ON sanitize (~3940) | `settleRealAsync()` @3964 | → `await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: 'flag-on sanitize re-entry #100' });` |
| stays parked — broken ledger (~3852) | `settleRealAsync()` @3875 | KEEP — add the `fixed-drain-ok` marker (Step 0); this negative test asserts NO advance, so it cannot be a wait-until and the RC-4 guard needs the marker to stay clean |

- [ ] **Step 0: broken-ledger negative — add the marker.** This real-PG test asserts the run
  STAYS parked (no re-entry, `resetSaves` length 0), so it keeps its fixed drain. Add directly
  above its `await settleRealAsync();` (~3875):
```ts
// fixed-drain-ok: negative — decision index unavailable / fail-closed; asserts no re-entry, no phase reset
```

- [ ] **Step 1: crash-safe ordering** (already spies `answer` at ~3724 as `answerSpy`). Replace
  the two-tick block with:
```ts
await vi.advanceTimersByTimeAsync(30000);
await vi.advanceTimersByTimeAsync(0);
await settleRealUntil(() => reenteredPipeline(100), Boolean, {
  label: 'crash-safe ordering tick1 re-entry #100',
});
const seen = answerSpy.mock.calls.length;
await vi.advanceTimersByTimeAsync(30000);
await vi.advanceTimersByTimeAsync(0);
await settleRealUntil(() => answerSpy.mock.calls.length, (n) => n > seen, {
  label: 'crash-safe ordering tick2 second-poll answer re-call',
});
```
Leave the `answer`-before-save ordering + `pending()`-excludes assertions unchanged.

- [ ] **Step 2: answered-once** — add `const answerSpy = vi.spyOn(manager.ledger(), 'answer');`
  before the ticks, then apply the same edge pattern as Step 1 (labels:
  `'answered-once tick1 re-entry #100'` / `'answered-once tick2 second-poll answer re-call'`).
  Leave the `pending()`-excludes assertion unchanged.

- [ ] **Step 3: missing-row, FLAG-ON reject, sanitize** — replace each `await settleRealAsync();`
  with the one-tick `settleRealUntil(() => reenteredPipeline(100), Boolean, {label})` from the map.

- [ ] **Step 4: periodic reconcile** — the existing test spies `reconcile` as `reconcileSpy` at
  ~3843. Replace `await settleRealAsync();` with the reconcile-count wait from the map.

- [ ] **Step 5: Run + commit.**
```bash
RUNFORGE_TEST_DATABASE_URL=$PG pnpm --filter @runforge/daemon test -t "decision-index enabled mode"
git add packages/daemon/src/control-plane/daemon.test.ts
git commit -m "test(daemon): deterministic settle for decision-index enabled-mode resume tests"
```

---

## Task 4: Migrate `integrate park resume (follow-up #9)`

**Files:** Modify `daemon.test.ts` describe at ~4287.

**Migration map** (all one-tick, all re-enter #100):

| it | current settle | predicate label |
|---|---|---|
| APPROVE (~4385) | @4409 | `'integrate approve re-entry #100'` |
| APPROVE legacy (~4449) | @4478 | `'integrate approve-legacy re-entry #100'` |
| APPROVE pre-rename (~4492) | @4544 | `'integrate approve-pre-rename re-entry #100'` |
| REJECT (~4558) | @4585 | `'integrate reject re-entry #100'` |
| NO-ANSWER (~4606) | @4631 | KEEP — `// fixed-drain-ok: negative — stays parked at integrate (no re-entry, statusOf 'notified')` |
| CRASH-SAFE (~4644) | @4672 | `'integrate crash-safe re-entry #100'` |

- [ ] **Step 1:** Replace each migrated `await settleRealAsync();` with
  `await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: '<from table>' });`.
  Leave all `statusOf`, `resumedSave`, `reenteredRun`, `removeLabel`, and `answer`-before-save
  assertions unchanged.

- [ ] **Step 2:** Add the `fixed-drain-ok` marker above the NO-ANSWER `settleRealAsync()`.

- [ ] **Step 3: Run + commit.**
```bash
RUNFORGE_TEST_DATABASE_URL=$PG pnpm --filter @runforge/daemon test -t "integrate park resume \\(follow-up"
git add packages/daemon/src/control-plane/daemon.test.ts
git commit -m "test(daemon): deterministic settle for integrate park resume (#9)"
```

---

## Task 5: Mark the fake / no-Postgres describe drains (`fixed-drain-ok`)

**Files:** Modify `daemon.test.ts` describe `integrate park resume (round-trip, CI-default fake —
no Postgres)` at ~4705 (sites @4826, @4860, and any other `settleRealAsync` in this describe).

> This describe is a plain `describe(` (NOT `skipIf(!REAL_PG)`), so the RC-4 guard does not
> require markers here. We add them anyway: (a) documentation — these use a synchronous
> in-memory ledger and are not load-sensitive; (b) belt-and-suspenders against any brace-count
> drift in the guard's region scan.

- [ ] **Step 1:** Add `// fixed-drain-ok: fake in-memory ledger (no real PG round-trip)` directly
  above each `await settleRealAsync();` in this describe.

- [ ] **Step 2: Commit.**
```bash
git add packages/daemon/src/control-plane/daemon.test.ts
git commit -m "test(daemon): mark fake-ledger settle drains fixed-drain-ok"
```

---

## Task 6: RC-4 hygiene guard — forbid fixed drains in real-PG resume describes

**Files:** Modify `packages/daemon/src/test-hygiene.test.ts`.

**Interfaces — Produces:** `findFixedDrainViolations(rawSrc: string, label: string): string[]`.

- [ ] **Step 1: Add the exported detector** (after `findHygieneViolations`). It reads RAW lines
  for both the `settleRealAsync` call and the `fixed-drain-ok` marker; it blanks
  strings/comments only for the brace-depth region scan.

```ts
// Blank out string-literal and comment CONTENT while PRESERVING line count (every '\n' stays),
// so brace-depth tracking ignores braces in strings/comments AND sanitized line indices stay
// aligned with the raw source. The existing stripComments folds a /* */ block to ONE space,
// which desyncs the indices and drifts the region scan (codex plan review). Char state machine.
function blankStringsAndComments(src: string): string {
  let out = '';
  type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let mode: Mode = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (c === '\n') { out += '\n'; if (mode === 'line') mode = 'code'; continue; }
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { mode = 'line'; out += '  '; i++; continue; }
      if (c === '/' && c2 === '*') { mode = 'block'; out += '  '; i++; continue; }
      if (c === "'") { mode = 'sq'; out += ' '; continue; }
      if (c === '"') { mode = 'dq'; out += ' '; continue; }
      if (c === '`') { mode = 'tpl'; out += ' '; continue; }
      out += c; continue;
    }
    if (mode === 'line') { out += ' '; continue; }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') { mode = 'code'; out += '  '; i++; continue; }
      out += ' '; continue;
    }
    if (c === '\\') {
      if (c2 === '\n') { out += ' \n'; i++; continue; } // line-continuation: keep the newline
      out += '  '; i++; continue; // other escape: blank both chars
    }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
      mode = 'code'; out += ' '; continue;
    }
    out += ' ';
  }
  return out;
}

// RC-4 (CI flake, 2026-06-29/30): the real-Postgres resume tests bridge the faked poll loop
// and the real postgres-js writer with a settle helper. A FIXED-budget drain (settleRealAsync)
// is adequate at idle but overruns under shared-runner CPU contention, so a positive
// resume-completion assertion runs before the durable effect lands (the cockpit-consumer
// flake). The deterministic fix is settleRealUntil(predicate). This guard forbids a fixed
// drain inside any real-PG resume describe (describe.skipIf(!REAL_PG)) unless an explicit
// `fixed-drain-ok` marker documents a legitimate negative / non-advancement drain.
//
// Region + call are matched on the line-preserving sanitized copy (so braces or a
// `settleRealAsync` mention inside a string/comment never count). The `fixed-drain-ok` marker
// IS a comment, so it is matched on the RAW lines (sanitizing erases it); indices align because
// the sanitizer preserves line count.
export function findFixedDrainViolations(rawSrc: string, label: string): string[] {
  const rawLines = rawSrc.split('\n');
  const codeLines = blankStringsAndComments(rawSrc).split('\n');
  const violations: string[] = [];
  let inRealPg = false;
  let depth = 0;
  for (let i = 0; i < codeLines.length; i++) {
    const code = codeLines[i] ?? '';
    if (!inRealPg && /describe\s*\.\s*skipIf\s*\(\s*!\s*REAL_PG\s*\)/.test(code)) {
      inRealPg = true;
      depth = 0;
    }
    if (!inRealPg) continue;
    for (const ch of code) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (/\bawait\s+settleRealAsync\s*\(/.test(code)) {
      const window = `${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}\n${rawLines[i + 1] ?? ''}`;
      if (!/fixed-drain-ok/.test(window)) {
        violations.push(
          `${label}:${i + 1}: settleRealAsync() inside a describe.skipIf(!REAL_PG) resume describe — a fixed wall-clock drain flakes under shared-runner contention (RC-4). Use settleRealUntil(predicate) to wait on the asserted resume effect, or add a \`// fixed-drain-ok: <reason>\` marker for a legitimate negative/non-advancement drain.`,
        );
      }
    }
    if (depth <= 0) inRealPg = false; // describe block closed
  }
  return violations;
}
```

- [ ] **Step 2: Add the "fires + passes" unit test** inside the existing
  `describe('test hygiene: ...')`:

```ts
it('RC-4: forbids fixed-budget settleRealAsync in real-PG resume describes (and the real file is clean)', () => {
  // Fires on a fixed drain inside a skipIf(!REAL_PG) describe with no marker.
  const bad = [
    "describe.skipIf(!REAL_PG)('x', () => {",
    "  it('y', async () => {",
    '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "ok" });',
    '    await settleRealAsync();',
    "    expect(await m.ledger().statusOf(id)).toBe('resumed');",
    '  });',
    '});',
  ].join('\n');
  expect(findFixedDrainViolations(bad, 'synthetic-bad').length).toBe(1);

  // Passes when the drain carries a fixed-drain-ok marker.
  const marked = [
    "describe.skipIf(!REAL_PG)('x', () => {",
    "  it('y', async () => {",
    '    // fixed-drain-ok: negative — stays parked',
    '    await settleRealAsync();',
    "    expect(await m.ledger().statusOf(id)).toBe('notified');",
    '  });',
    '});',
  ].join('\n');
  expect(findFixedDrainViolations(marked, 'synthetic-marked')).toEqual([]);

  // Passes when the drain is OUTSIDE a real-PG describe (plain describe).
  const plain = [
    "describe('fake', () => {",
    '  it("y", async () => { await settleRealAsync(); });',
    '});',
  ].join('\n');
  expect(findFixedDrainViolations(plain, 'synthetic-plain')).toEqual([]);

  // Line-stability: a MULTI-LINE block comment before/inside the real-PG describe must not
  // shift indices or close the region early — an unmarked trailing drain still fires
  // (regression guard for the collapse-to-one-line desync, codex plan review).
  const withBlockComment = [
    '/* a multi-line',
    '   block comment',
    '   before the describe { with a brace } in prose */',
    "describe.skipIf(!REAL_PG)('x', () => {",
    '  /* inner block',
    '     comment */',
    "  it('y', async () => {",
    '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "ok" });',
    '    await settleRealAsync();', // unmarked trailing drain, near the region tail
    "    expect(await m.ledger().statusOf(id)).toBe('resumed');",
    '  });',
    '});',
  ].join('\n');
  expect(findFixedDrainViolations(withBlockComment, 'synthetic-block').length).toBe(1);

  // The REAL daemon test file is clean after migration.
  const daemonTest = join(PACKAGES_DIR, 'daemon', 'src', 'control-plane', 'daemon.test.ts');
  expect(
    findFixedDrainViolations(readFileSync(daemonTest, 'utf8'), 'daemon.test.ts'),
    'daemon.test.ts still has an unmarked fixed-budget settleRealAsync in a real-PG resume describe',
  ).toEqual([]);
});
```

- [ ] **Step 3: Run the guard.** `pnpm --filter @runforge/daemon test -t "test hygiene"`.
  Expected: pass (synthetic-bad → 1 violation; marked/plain/real-file → none).

- [ ] **Step 4: Commit.**
```bash
git add packages/daemon/src/test-hygiene.test.ts
git commit -m "test(hygiene): RC-4 guard — forbid fixed-budget settle in real-PG resume describes"
```

---

## Running real-PG tests locally

```bash
CONTAINER=cockpit-deflake-pg
docker run -d --name "$CONTAINER" -e POSTGRES_DB=runforge_ci -e POSTGRES_USER=runforge \
  -e POSTGRES_PASSWORD=runforge -p 127.0.0.1::5432 postgres:18-alpine
# wait for ready, resolve port:
until docker exec "$CONTAINER" pg_isready -U runforge -d runforge_ci >/dev/null 2>&1; do sleep 1; done
PORT=$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')
export PG="postgres://runforge:runforge@127.0.0.1:${PORT}/runforge_ci"
export RUNFORGE_TEST_DATABASE_URL="$PG" RUNFORGE_DATABASE_URL="$PG"
# teardown when done: docker rm -f "$CONTAINER"
```

## Final verification (whole-change acceptance)

- [ ] `RUNFORGE_TEST_DATABASE_URL=$PG pnpm --filter @runforge/daemon test` — full daemon
  suite green (all three real-PG resume describes + the RC-4 guard).
- [ ] `pnpm --filter @runforge/daemon typecheck` — clean.
- [ ] `pnpm lint` — clean.
- [ ] `grep -nE "await settleRealAsync\(" packages/daemon/src/control-plane/daemon.test.ts` — every
  remaining hit is either OUTSIDE the three `skipIf(!REAL_PG)` describes or carries a
  `fixed-drain-ok` marker (cross-check with `findFixedDrainViolations` → `[]`).
- [ ] Robustness (Phase 9, conductor): run the daemon suite under concurrent load (≥3 parallel
  `pnpm test`) — the migrated tests stay green where the fixed-budget version flaked.

## Verification design rationale

The existing real-PG resume assertions are the behavioral oracle (unchanged). Correctness of the
deflake = (1) suite green against real PG, (2) RC-4 guard green (proves no fixed drain slipped
back into a real-PG resume describe and the synthetic detector actually fires), (3) the
concurrent-load run no longer reproduces the `source_written`/double-re-entry flake.
