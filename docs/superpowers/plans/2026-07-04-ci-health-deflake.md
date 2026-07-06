# CI Health Deflake — implementation plan (2026-07-04)

Spec: `docs/superpowers/specs/2026-07-04-ci-health-deflake-design.md` (read it
first — evidence, chosen designs, rejected alternatives, safety arguments).

Three independent PRs. Plan branch `ci-health-digest-2026-07-04-00-01-02`
carries spec + plan + work-orders ONLY. **Acceptance gates are committed
per-fix on their own build branch, NOT on the shared plan branch** — a gate is
RED until its fix lands, so a shared-branch gate would ride along in the other
two PRs and turn main red when the first PR merges alone. Topology per fix:
cut `codex/<topic>-build` from the plan branch tip → commit that fix's gate
(conductor, after RED proof) → implementer makes it green on the same branch →
PR targets `main`. Each PR carries the docs (identical blobs across PRs —
merge cleanly) + its own gate + its own fix; main never receives a RED gate.
The three fixes touch disjoint files — no ordering constraint between PRs.
Diff-guard consequence: the immovability check runs on the implementer's
commits (gate-commit..branch-head), not base...head — the gate itself is
legitimately ON the branch.

Gate ownership (Stage GATE authors these; the implementer must NOT touch
them — they are the `do_not_modify` set):
- Fix 1: the `cockpit-settle-deflake.gate.test.ts` extension (label-anchored
  advancePollsUntil checks + detector-export check) is GATE-AUTHORED. The
  implementer's files are daemon.test.ts + test-hygiene.test.ts only.
- Fix 2: NEW gate file `packages/dashboard/answer-flow-hardening.gate.test.ts`
  (vitest source-anchored: global-setup contains the answer-route POST
  warm-up; the answer test binds a POST-method waitForResponse before the
  badge expect) is GATE-AUTHORED, registered in traceability.yml under
  STACK-AC-OPERATOR-SURFACE-CLIENT test_paths in the same branch (repo rule:
  new files must be registered; CI check-traceability enforces existence via
  existsSync on every literal path). The traceability.yml registration is
  NOT part of the shared docs — it travels ONLY on the fix-2 branch, together
  with the gate file it names; PRs 1/3 must not carry it (a registration
  without the file fails check-traceability on their branches).
  Implementer files: the two e2e files only.
- Fix 3: the `check-ci-workflows.test.mjs` additions are GATE-AUTHORED (RED:
  the bad-case tests fail against the current check script). Implementer
  files: ci.yml + check-ci-workflows.mjs only.

## Environment prerequisites (conductor, once)

- Worktree deps installed: `pnpm install --frozen-lockfile` (done).
- Real Postgres for the fix-1 suite (docker, mirrors ci.yml):
  container `ci-pg-sparring`, `postgres:18-alpine`, db/user/pass
  `runforge_ci`/`runforge`/`runforge`, mapped port recorded in
  `.sparring/pg-url.txt` (currently
  `postgres://runforge:runforge@127.0.0.1:60212/runforge_ci`).
  **Every fix-1 test run MUST set `RUNFORGE_TEST_DATABASE_URL` (and
  `RUNFORGE_DATABASE_URL`) to that URL — without it the real-PG suite
  SKIPS and a green run is hollow.**
- Playwright browser for fix-2:
  `pnpm --filter @runforge/dashboard exec playwright install chromium`.

## Task 1 — PR 1: daemon tick2 deflake (`codex/ci-deflake-daemon-tick2-build`)

Files: `packages/daemon/src/control-plane/daemon.test.ts`,
`packages/daemon/src/test-hygiene.test.ts`,
`packages/daemon/src/cockpit-settle-deflake.gate.test.ts`.

1. **daemon.test.ts — convert two tick2 waits.** In the real-PG describe
   `decision-index enabled mode (real writer over real Postgres)`:
   - Test `records the answer BEFORE save ... (crash-safe ordering)`: replace
     the block after `const seen = answerSpy.mock.calls.length;` —
     ```ts
     await vi.advanceTimersByTimeAsync(30000);
     await vi.advanceTimersByTimeAsync(0);
     await settleRealUntil(() => answerSpy.mock.calls.length, (n) => n > seen, {
       label: 'crash-safe ordering tick2 second-poll answer re-call',
     });
     ```
     with
     ```ts
     await advancePollsUntil(() => answerSpy.mock.calls.length, (n) => n > seen, {
       label: 'crash-safe ordering tick2 second-poll answer re-call',
       pollPeriodMs: 30000,
     });
     ```
   - Test `records the answer once ... (answered-once)`: same transformation
     for the block after its `const seen = ...` (label
     `answered-once tick2 second-poll answer re-call`).
   - Labels VERBATIM unchanged (gate anchors on them). Tick1 blocks untouched.
   - Update the tick-2 comment in each test to name the swallow mechanism
     (pollInProgress + #839 per-run guard) and point at the advancePollsUntil
     doc-comment.
2. **test-hygiene.test.ts — new detector** `findSecondTickPassiveWaitViolations`
   (exported, same style as `findFixedDrainViolations`):
   - Operates on `blankStringsAndComments(src)` lines, scoped to
     `describe.skipIf(!REAL_PG)` regions (reuse the existing region tracking).
   - Within each `it(` body: track `vi.advanceTimersByTimeAsync(ARG)` calls
     where ARG is a non-zero literal — `(0)` flushes DO NOT count as fires.
     After the SECOND-or-later non-zero fire, a `settleRealUntil(` occurring
     before any further non-zero fire or `advancePollsUntil(` is a violation
     — unless the raw source carries a `second-tick-ok:` comment marker
     within the `it` body (check RAW src for the marker, mirroring
     `fixed-drain-ok`).
   - Wire it into the existing describe that runs detectors over all package
     test files; synthetic self-tests per spec (old flaky shape fires;
     one-fire-plus-flushes clean; marker respected; plain describe ignored;
     real converted daemon.test.ts clean with zero markers).
3. **[GATE-AUTHORED — implementer must not touch]**
   `cockpit-settle-deflake.gate.test.ts` — extend the multi-tick re-fire gate
   (same body-slice + label-regex anchoring technique as the DOUBLE-DELIVERY
   check): for each of
   the two labels, the `advancePollsUntil(` call must be the binder of that
   label (regress to `settleRealUntil` + that label → fail). Plus a structural
   check that `test-hygiene.test.ts` exports
   `findSecondTickPassiveWaitViolations`.
4. **Verify** (PG env vars from `.sparring/pg-url.txt`, per prerequisites):
   ```bash
   cd packages/daemon && RUNFORGE_TEST_DATABASE_URL=<pg-url> RUNFORGE_DATABASE_URL=<pg-url> \
     pnpm exec vitest run src/control-plane/daemon.test.ts src/test-hygiene.test.ts src/cockpit-settle-deflake.gate.test.ts
   ```
   Expected: all pass, 0 skipped in the decision-index describes. Run the
   two converted tests 3× for flake sampling with a SINGLE regex filter —
   `-t "crash-safe ordering|answered-once"` (vitest takes one
   `--testNamePattern`; repeating `-t` is not reliable). Then full
   `pnpm lint && pnpm typecheck` at repo root.
5. Commit message template:
   `test(daemon): re-fire tick2 polls in real-PG replay tests (CI deflake) + second-tick hygiene guard`
   Body: 4 failing runs from 2026-07-03 by id; swallow mechanism one-liner;
   `Co-Authored-By` per repo convention.

## Task 2 — PR 2: e2e answer-flow hardening (`codex/ci-deflake-e2e-answer-build`)

Files (implementer): `packages/dashboard/e2e/global-setup.mjs`,
`packages/dashboard/e2e/operator-surface.spec.ts`.
PR additionally carries (GATE-AUTHORED, implementer-untouchable):
`packages/dashboard/answer-flow-hardening.gate.test.ts` + its
`.specify/traceability.yml` registration — see the gate-ownership section.

1. **global-setup.mjs**: extend the doc-comment (answer POST route joined the
   warm set — first-hit compile of the POST path was still inside the timed
   window, runs 28629487554/28645073274); add
   ```js
   async function warmAnswerRoute() {
     try {
       const res = await fetch(`${BASE_URL}/api/decisions/answer`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           decision_id: '__route_warmup__',
           chosen_option: 'approve',
         }),
       });
       await res.text().catch(() => {});
     } catch {
       // Best-effort, same contract as warm(): never fail the run on warm-up.
     }
   }
   ```
   and call it from `globalSetup()` after the two GET warms. Valid JSON +
   nonexistent id: compiles route + daemonFetch + daemon 404; mutates nothing
   (spec "Integration details" has the verified /reset + 404 argument).
2. **operator-surface.spec.ts** (`answering a decision ...` test): replace the
   bare Approve click + badge expect (lines ~49–50) with the POST-anchored
   form from the spec (Promise.all + waitForResponse predicate checking URL
   `/api/decisions/answer` AND method POST; `expect(answerResponse.ok()).toBe(true);`
   then the unchanged badge expect). Keep lines 52–55 (row-leaves + sibling
   assertions) untouched.
3. **Verify**:
   ```bash
   pnpm --filter @runforge/dashboard test
   pnpm --filter @runforge/dashboard e2e --project=desktop
   ```
   Expected: e2e 3/3 desktop tests pass. Run the e2e twice for sampling.
   Then repo-root `pnpm lint && pnpm typecheck`.
4. Commit template:
   `test(dashboard-e2e): warm the answer POST route + network-anchor the answer-flow assertion (CI deflake)`
   Body: completes #828 (c08f068); 2 failing runs by id.

## Task 3 — PR 3: main per-sha concurrency (`codex/ci-main-concurrency-build`)

Files: `.github/workflows/ci.yml`, `scripts/check-ci-workflows.mjs`,
`scripts/check-ci-workflows.test.mjs`.

1. **ci.yml**: concurrency block →
   ```yaml
   concurrency:
     group: ci-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}
     cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
   ```
   Rewrite the comment: cancel-in-progress:false protects only the RUNNING
   run; GitHub keeps at most ONE PENDING run per group (pending-slot
   replacement) — 2026-07-03 13:45 a 3-commit merge train cancelled the
   queued runs for 2 trunk commits; per-sha groups on main give every trunk
   commit its own group so nothing is replace-cancelled; branches/PRs keep
   the shared per-ref group + supersede-cancellation.
2. **check-ci-workflows.mjs**: export
   `findMainConcurrencyViolations(text, file)` (line-based, reuse
   block-scalar/comment handling conventions): for workflows with a
   push-to-main trigger and a TOP-LEVEL `concurrency:` block, the `group:`
   expression must contain the conditional discriminator
   (`github.ref == 'refs/heads/main' && github.sha`, whitespace-flexible)
   AND a `|| github.ref` fallback; flag (a) a group with neither (shared-slot
   regression), (b) unconditional `github.sha` without the main conditional
   (breaks branch supersede). Wire into `main()` beside the container checks;
   error text names the 2026-07-03 pending-slot incident and this plan.
   Scope note in comments: top-level concurrency only.
3. **[GATE-AUTHORED — implementer must not touch]**
   `check-ci-workflows.test.mjs`: cases — good (conditional discriminator +
   fallback: passes); bad (plain `ci-${{ github.ref }}`: flagged);
   bad (unconditional `ci-${{ github.sha }}`: flagged); discriminator only in
   a `#` comment line or inside a block scalar: still flagged (not
   false-passed); workflow without push-to-main trigger: ignored; workflow
   without concurrency block: ignored.
4. **Verify**:
   ```bash
   pnpm test:scripts        # node --test scripts/**/*.test.mjs
   pnpm check:workflows     # against the edited ci.yml → exit 0
   ```
   Expected: all node --test cases pass; check exits 0 on the repo.
   Then repo-root `pnpm lint && pnpm typecheck && pnpm test`.
5. Commit template:
   `ci: per-sha concurrency group on main — queued trunk runs must never be replace-cancelled`
   Body: cancelled runs 28664593431/28664595700; enacts the workflow
   comment's existing invariant.

## Verification design (Phase 9, post-merge, conductor)

- Fix 3 is verifiable on the REAL target only after ≥2 rapid merges: after
  merging ≥2 of these PRs close together, `gh run list --branch main
  --limit 5` must show NO `cancelled` conclusion — every trunk commit's run
  completes (the 2026-07-03 signature was cancelled queued runs).
- Fix 1/2 are statistical: watch the next days' runs for the two failure
  signatures (`settleRealUntil: '* tick2 second-poll answer re-call'`,
  `expect(locator).toBeVisible ... /answered/i`). Zero recurrence expected;
  any recurrence = new evidence, reopen.
- Execution log: `docs/superpowers/plans/2026-07-04-ci-health-deflake.execution-log.md`
  with actual command outputs; committed via follow-up PR.

## Work-order index (Stage HANDOFF)

These files DO NOT EXIST YET — they are generated and committed at Stage
HANDOFF, after the gates are authored and proven RED. Listed here only so the
slugs and paths are fixed up front:

| Fix | topic slug | work-order |
|---|---|---|
| 1 | `ci-deflake-daemon-tick2` | `docs/superpowers/handoffs/ci-deflake-daemon-tick2.work-order.md` |
| 2 | `ci-deflake-e2e-answer` | `docs/superpowers/handoffs/ci-deflake-e2e-answer.work-order.md` |
| 3 | `ci-main-concurrency` | `docs/superpowers/handoffs/ci-main-concurrency.work-order.md` |
