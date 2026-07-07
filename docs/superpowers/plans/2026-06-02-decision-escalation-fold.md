# Decision-Escalation Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans, task-by-task. Apply superpowers:test-driven-development to all new code. **Work in the worktree `~/code/runforge-wt-decision-emitter` on branch `codex/phase2-decision-escalation-impl` — `cd` there first in every task.**

**Goal:** Fold the external cockpit consumer's `@pm/protocol` + `@pm/index` into runforge as `@runforge/decision-protocol` + `@runforge/decision-index`, and wire an additive l2-gate DecisionRequest emitter into the daemon control-plane, realizing FUNC-AC-DECISION-ESCALATION (#685).

**Architecture:** P1 (port onto zod4/drizzle0.45/better-sqlite3^12, preserve shape/behavior/tests) + S2 (decision-index = durable ledger + pending source; the existing GitHub-label requeue stays the v1 executor; mid_run/notifier-delivery/source-of-truth/PHI deferred). See `docs/superpowers/specs/2026-06-02-decision-escalation-fold-design.md` (codex-CLEAN) and the L1/L2/L3 specs.

**Tech Stack:** TypeScript ES2022/Node16/strict, pnpm workspace, zod ^4.3.6, zod-to-json-schema ^3.25.1, drizzle-orm ^0.45.2, better-sqlite3 ^12, ajv ^8, ulid ^2, vitest ^3.2.4.

**Port source of truth:** `~/code/cockpit-consumer/packages/protocol` and `~/code/cockpit-consumer/packages/index`. Port = copy `src/` **and `test/`** (+ protocol `schema/`, + index `drizzle.config.ts`, + each package's `vitest.config.ts`/`tsconfig.json`), rename scope `@pm/*` → `@runforge/decision-*`, upgrade deps, fix only what the version bump breaks. **A failing ported test is a porting bug, not a spec change.**

**Real package API (verified — build against THIS, do not invent methods):**
- Factory: `createIndexWriter({ dbPath, protectedKey, protectedDir, notifier, sourceSink, resumeDispatcher, clock, channel?, maxAttempts?, skipMigrate?, generation? }): IndexWriter` — opens the single writable connection AND runs `migrate()` internally.
- `IndexWriter` verbs: `admit(rawRequest)`, `observeRequest(rawRequest, …) → { decision_id, outcome: 'admitted'|'unchanged'|'superseded' }`, `applyEvent(decisionId, event: TransitionEvent, ctx) → ApplyResult` (it **auto-applies `opened` before `answer_submitted`** — do not pre-`open`), `runEffect(decisionId, kind, opts) → Promise<RunEffectResult>`, `reconcile()`, `reader` (read model).
- `DecisionRequestSchema` (all required unless `?`): `decision_id, protocol_version(=PROTOCOL_VERSION), source_url, source_etag?, source_event_id?, deployment, run_id, worker_session_id, phase, risk_class∈P0..P3, question, context, options[≥1]{id,label,detail?}, recommended_option?, consequence_of_no_answer, reversibility∈{reversible,hard_to_reverse,external_effect}, expires_at, answer_schema{kind:'option'|'json'}, resume_mode∈{mid_run,requeue}, idempotency_key, trace_id?, agent_version?, skill_version?, field_sensitivity(complete map — validated by assertFullyClassified())`.
- Adapter contracts (`Notifier`/`SourceSink`/`ResumeDispatcher`) are injected at construction — v1 supplies daemon-owned no-op/log implementations.

**Pre-flight:** read the spec; read `~/code/cockpit-consumer/packages/{protocol,index}` fully incl. `test/`, `package.json`, `vitest.config.ts`, `drizzle.config.ts`, `src/index.ts`, `src/index-writer.ts`, `src/sensitivity.ts`, `src/decision-request.ts`; read in the worktree `packages/db/{package.json,tsconfig.json}` (sibling pattern), and `packages/daemon/src/control-plane/{daemon.ts (resumeParkedRuns),phases.ts (createPhaseHandlers + l2-gate),state.ts,types.ts,main.ts,config*.ts}`. **Line numbers drift — re-grep before every edit.**

---

## Task 1: Port `@pm/protocol` → `@runforge/decision-protocol` (zod4)

**Files:** Create `packages/decision-protocol/{package.json,tsconfig.json,vitest.config.ts}`, `packages/decision-protocol/src/**`, `packages/decision-protocol/test/**`, `packages/decision-protocol/schema/decision-request.schema.json` (all copied from `~/code/cockpit-consumer/packages/protocol`).

- [ ] **Step 1: Copy src/, test/, schema/, configs**
```bash
cd ~/code/runforge-wt-decision-emitter && mkdir -p packages/decision-protocol
cp -R ~/code/cockpit-consumer/packages/protocol/src   packages/decision-protocol/src
cp -R ~/code/cockpit-consumer/packages/protocol/test  packages/decision-protocol/test
cp -R ~/code/cockpit-consumer/packages/protocol/schema packages/decision-protocol/schema
cp ~/code/cockpit-consumer/packages/protocol/vitest.config.ts packages/decision-protocol/vitest.config.ts
cp packages/db/tsconfig.json packages/decision-protocol/tsconfig.json
```
- [ ] **Step 2: Write `package.json`** — name `@runforge/decision-protocol`, zod ^4.3.6, zod-to-json-schema ^3.25.1 (zod4-compatible peer). `test: vitest run`, `typecheck: tsc --noEmit`. Match `typescript` version from `packages/db/package.json`.
- [ ] **Step 3: Install + typecheck to surface zod3→4 breakages**
```bash
pnpm install && pnpm --filter @runforge/decision-protocol typecheck
```
Known zod 3→4 fix points in `src/`: `z.record(z.unknown())` now needs `z.record(z.string(), z.unknown())`; `.datetime()`; errorMap→`error`; discriminated-union helpers; `zod-to-json-schema` import/usage under zod4. Fix until clean.
- [ ] **Step 4: Tests green** — `pnpm --filter @runforge/decision-protocol test`. The committed `schema/decision-request.schema.json` diff test must pass (regenerate via the package's own script if zod4 changes JSON-schema output, and review the diff before accepting).
- [ ] **Step 5: Commit** — `git add packages/decision-protocol pnpm-lock.yaml && git commit -m "feat(decision-protocol): port @pm/protocol -> @runforge/decision-protocol (zod4)"`

---

## Task 2: Port `@pm/index` → `@runforge/decision-index` (drizzle0.45, better-sqlite3^12)

**Files:** Create `packages/decision-index/{package.json,tsconfig.json,vitest.config.ts,drizzle.config.ts}`, `src/**` (+ `src/migrations/*.sql`), `test/**` (copied from `~/code/cockpit-consumer/packages/index`).

- [ ] **Step 1: Copy src/, test/, drizzle.config.ts, configs**
```bash
cd ~/code/runforge-wt-decision-emitter && mkdir -p packages/decision-index
cp -R ~/code/cockpit-consumer/packages/index/src  packages/decision-index/src
cp -R ~/code/cockpit-consumer/packages/index/test packages/decision-index/test
cp ~/code/cockpit-consumer/packages/index/drizzle.config.ts packages/decision-index/drizzle.config.ts
cp ~/code/cockpit-consumer/packages/index/vitest.config.ts packages/decision-index/vitest.config.ts
cp packages/db/tsconfig.json packages/decision-index/tsconfig.json
```
- [ ] **Step 2: `package.json`** — name `@runforge/decision-index`; deps `@runforge/decision-protocol: workspace:*`, `drizzle-orm ^0.45.2`, `ajv ^8.20.0`, `ulid ^2.3.0`, `zod ^4.3.6`, `better-sqlite3 ^12.0.0`; dev `@types/better-sqlite3`, `drizzle-kit ^0.30.0`, `vitest ^3.2.4`, `typescript`. (better-sqlite3 is a normal dep — see Task 3/8 for the gating reality.)
- [ ] **Step 3: Rename protocol imports + drop `server-only`**
```bash
grep -rl "@pm/protocol" packages/decision-index | xargs sed -i '' 's#@pm/protocol#@runforge/decision-protocol#g'
grep -rn "server-only" packages/decision-index   # remove import + the `.server` export from src/index.ts; also remove any vitest server-only alias in vitest.config.ts
```
- [ ] **Step 4: Install + typecheck** — `pnpm install && pnpm --filter @runforge/decision-index typecheck`. Known drizzle 0.36→0.45 points: `drizzle(db)` ctor, `sqliteTable` builders, `InferSelectModel`/`InferInsertModel`, `.$type<>()`. Fix to clean.
- [ ] **Step 5: Full ported suite green** — `pnpm --filter @runforge/decision-index test` (answered-once, concurrent-claim, crash-recovery, effect-reconcile, etc. — the crash-safety contract; keep behavior, fix porting bugs).
- [ ] **Step 6: Commit** — `git add packages/decision-index pnpm-lock.yaml && git commit -m "feat(decision-index): port @pm/index -> @runforge/decision-index (drizzle0.45, better-sqlite3^12)"`

---

## Task 3: `DecisionLedger` facade + v1 adapters + `DecisionIndexManager` (flag-gated dynamic load)

**Files:** Create `packages/daemon/src/control-plane/decision-escalation/{adapters.ts,ledger.ts,manager.ts}` (+ `.test.ts` each). Modify `packages/daemon/package.json` (add `@runforge/decision-protocol` + `@runforge/decision-index` as `workspace:*` deps).

- [ ] **Step 1: v1 adapters** (`adapters.ts`) — daemon-owned no-op/log implementations of `Notifier`, `SourceSink`, `ResumeDispatcher` matching the ported contracts. **Critical: mirror the package's own test fakes so the lifecycle actually advances** (read `~/code/cockpit-consumer/packages/index/test/helpers` for `FakeNotifier`/`FakeSourceSink`/`FakeResumeDispatcher`):
  - `Notifier.notify`→log+`'sent'`; `Notifier.probe`→track effect IDs seen, `'applied'` for known else `'absent'`.
  - `SourceSink.writeResponse`→record + return `'written'` (track the effect ID); `SourceSink.exists`→`'applied'` for recorded IDs else `'absent'`; **`SourceSink.currentEtag`→`{status:'equal'}` by default** (the real `runEffect('requeue')` defers unless equal — a vague `'unknown'` strands the row at `source_written`); `markSuperseded`→record.
  - `ResumeDispatcher.resume`→record + `'acked'`; `status`→`'applied'` for recorded.
  Test: a real `IndexWriter` built with these adapters drives `raise→notify→answer→advanceToResumed` all the way to `resumed` (proves the adapters don't strand the lifecycle).
- [ ] **Step 2: `DecisionLedger` facade** (`ledger.ts`) — **build it TEST-FIRST against a real `IndexWriter` over a temp sqlite**, deriving every exact event name, `ApplyCtx`/`AnswerPayload` shape, effect kind, and `reader` method from the now-local `@runforge/decision-protocol` (`src/state-machine-types.ts`, `src/decision-request.ts`) and `@runforge/decision-index` source + its ported tests (`test/answered-once.test.ts`, `test/crash-recovery.test.ts`, `test/effect-reconcile.test.ts` show the real call sequences). **Do NOT invent method names or payload shapes — read them from the local code.**

  The facade wraps the real verbs only — `observeRequest`, `applyEvent`, `runEffect`, `reconcile`, `reader` — and drives the **real lifecycle** (verified order):
  `detected` —`runEffect('notify')`→ `notified` —`applyEvent('answer_submitted', {answer})` (auto-opens notified→viewed)→ `answered_pending_source_write` —`runEffect('write_response')`→ `source_written` —…→ `resume_requested` —`runEffect('resume'|'requeue')`→ `resume_dispatch`/`resume_ack` → `resumed`.

  Facade methods (names illustrative; signatures must match the real `AnswerPayload` — `{ response_idempotency_key, chosen_option, answerer, answered_at }` + `ApplyCtx.semanticKey`/`now`/`actor`):
  - `raise(req)` → `observeRequest(req)` (admit/unchanged/superseded; new = `detected`)
  - `notify(id)` → **reads `reader.get(id).status` first**; calls `runEffect(id,'notify')` ONLY when status is `detected`; otherwise returns a no-op result (the real `runEffect('notify')` throws `IllegalTransitionError` from `notified`+ unless it is an explicit `re_notify` cycle)
  - `answer(id, chosenOption, answerer)` → `applyEvent(id,'answer_submitted',{ actor, semanticKey, answer:{ response_idempotency_key, chosen_option: chosenOption, answerer, answered_at } })`
  - `advanceToResumed(id, mode)` → `runEffect(id,'write_response')` then the resume/requeue effect chain to `resumed`
  - `pending()` → `reader.list(...)`/`reader.listRanked(...)` filtered to non-terminal statuses (NOT an invented `listPending`)
  - `reconcile()` → `writer.reconcile()`

  **Tests (against a real writer):** raise→notify→answer→advanceToResumed drives a row all the way to `resumed`; answered-once (second answer is a no-op); a raised+notified item appears in `pending()`; reconcile after a simulated crash completes the in-flight effect. These tests are the proof the facade matches the real lifecycle.
- [ ] **Step 3: `DecisionIndexManager`** (`manager.ts`) — flag-gated, **dynamic-import only when enabled**, constructs the real writer with v1 adapters + a protected key/dir, fail-closed when enabled-but-broken:
```ts
export class DecisionIndexManager {
  #enabled; #opts; #ledger: DecisionLedger | null = null; #broken = false;
  constructor(o: { enabled: boolean; dbPath: string; protectedKey: string; protectedDir: string;
                   importer?: () => Promise<typeof import('@runforge/decision-index')> }) { /* … */ }
  isEnabled() { return this.#enabled; }
  async init() {
    if (!this.#enabled) return;                              // disabled → NEVER imports native code
    try {
      const mod = await (this.#opts.importer ?? (() => import('@runforge/decision-index')))();
      const writer = mod.createIndexWriter({ dbPath: this.#opts.dbPath,
        protectedKey: this.#opts.protectedKey, protectedDir: this.#opts.protectedDir,
        notifier: new LogNotifier(), sourceSink: new RecordingSourceSink(),
        resumeDispatcher: new AckResumeDispatcher(), clock: () => new Date() });
      this.#ledger = new DecisionLedger(writer);
    } catch { this.#broken = true; /* log */ }
  }
  ledger(): DecisionLedger {
    if (!this.#enabled) throw new Error('decision index disabled');
    if (this.#broken || !this.#ledger) throw new Error('decision index unavailable'); // fail-closed
    return this.#ledger;
  }
  async close() { /* close underlying writer if open */ }
}
```
- [ ] **Step 4: Tests** — disabled: `init()` calls importer 0×, `isEnabled()` false. enabled (fake importer returning a writer over temp sqlite): `ledger()` works end-to-end (raise→answer). enabled-but-importer-throws: `ledger()` throws `/unavailable/` (fail-closed), daemon keeps running.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): DecisionLedger facade + v1 adapters + flag-gated DecisionIndexManager (fail-closed when enabled)"`

---

## Task 4: l2-gate `DecisionRequest` builder (full schema) + `decisionEpoch`

**Files:** Create `packages/daemon/src/control-plane/decision-escalation/build-request.ts` (+ `.test.ts`). Modify `packages/daemon/src/control-plane/types.ts` (`RunState.decisionEpoch?: number`).

- [ ] **Step 1: Failing test against the REAL schema** — `buildL2GateRequest(run, epoch, deployment)` produces an object that `DecisionRequestSchema.parse()` accepts and `assertFullyClassified()` passes; deterministic `decision_id` = `issue-<n>:l2-gate:<epoch>` and `idempotency_key` derived from it; epoch 1 ≠ epoch 2 ids; `field_sensitivity` classifies **every** field as operational/non-sensitive (no PHI); `options` = approve/reject; `resume_mode='requeue'`; `risk_class='P1'`; `reversibility='reversible'`; only structured fields (NO `l2Feedback`/`handoffNotes`/raw failure text in `context`).
- [ ] **Step 2–4:** implement `build-request.ts` against `@runforge/decision-protocol`'s `DecisionRequestSchema`; TDD to green. Add `decisionEpoch?: number` to `RunState`.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): full l2-gate DecisionRequest builder + decisionEpoch on RunState"`

---

## Task 5: Wire raise/answer into the daemon (DI through `createPhaseHandlers` + `resumeParkedRuns`)

**Files:** Modify `packages/daemon/src/control-plane/phases.ts` (`createPhaseHandlers` signature/context + l2-gate park path), `daemon.ts` (`resumeParkedRuns` + construct/inject the manager), `state.ts`/`types.ts` as needed, `main.ts`/config for env parsing + shutdown.

- [ ] **Step 1: Thread the manager as an explicit dependency** — extend the `createPhaseHandlers(...)` context (and the daemon wiring that builds it) to receive the `DecisionIndexManager`; parse `RUNFORGE_DECISION_INDEX_ENABLED` / `RUNFORGE_DECISION_INDEX_PATH` / `RUNFORGE_DECISION_PROTECTED_KEY` / `…_PROTECTED_DIR` in ONE place (the config reader) with safe defaults (path `state/decision-index.sqlite`, dir `state/decision-protected/`, generated key persisted to `state/` if unset). Update every `createPhaseHandlers` call site + its tests to pass a disabled manager by default (so existing tests are unaffected).
- [ ] **Step 2: raise (+notify) at the l2-gate park (idempotent)** — where the l2-gate handler sets `pausedAtPhase='l2-gate'` + posts `awaiting-l2-review`: on a FRESH park bump `run.decisionEpoch=(run.decisionEpoch??0)+1`; if `manager.isEnabled()`, `const r = manager.ledger().raise(buildL2GateRequest(run, run.decisionEpoch, deployment))` then `manager.ledger().notify(r.decision_id)` so the row reaches `notified` (the only state `answer` can proceed from — `answer_submitted` is illegal from `detected`). `observeRequest` dedupes by deterministic id across re-scans, and the facade's `notify()` status-guards (no-op once past `detected`), so repeated raise+notify across per-tick re-scans is safe (no `IllegalTransitionError`). Wrap in try/catch → fail-closed (stay parked, log) if `ledger()` throws.
- [ ] **Step 3: answer with crash-safe ordering + PRESERVE rejection routing** — in `resumeParkedRuns`, after the existing `l2-approved`/`l2-rejected` detection: if enabled, `manager.ledger().answer(id, choice, 'operator')` (auto-opens `notified`→`viewed`; records `answered_pending_source_write`; answered-once). Then run the **existing** requeue (phase reset + `saveRunState`) **UNCHANGED** — approved re-enters `l2-gate`; rejected keeps its existing route through the l2-gate handler which captures `l2Feedback`→`l2-design`. **⚠ Pre-existing tension — verify and fix as part of this task (do NOT assume the current path works):** `resumeParkedRuns` (daemon.ts ~1373) *deliberately removes* `l2-rejected` before re-entry ("to prevent the l2-gate handler from immediately seeing it"), but the l2-gate handler (phases.ts ~515) captures rejection feedback into `run.l2Feedback` **only when it sees `l2-rejected`** on the re-fetched labels. These contradict — rejection feedback is likely already dropped on resume. **Write a regression test FIRST** asserting a rejected resume sets `run.l2Feedback` (from the rejection comment) and routes to `l2-design` (the existing test only checks `runPipeline` was called — too weak, codex). If it fails against current code, fix minimally as part of this task. **Capturing `run.l2Feedback` alone is NOT sufficient** — the l2-gate handler only routes to `l2-design` when the *re-fetched labels still include `l2-rejected`*. So the fix must do ONE of: (a) **preserve `l2-rejected` until the handler consumes it** — move the label removal out of `resumeParkedRuns` into the handler's rejection branch, after it captures feedback and routes; or (b) **have `resumeParkedRuns` route the rejected resume directly** — set `run.l2Feedback` (from the rejection comment) AND `run.phase='l2-design'` (instead of `l2-gate`) before save. The regression test asserts the run lands at `l2-design` with `l2Feedback` populated — not merely that `runPipeline` was called. The emitter's answer/ordering changes touch exactly this code; it must not make it worse. After `saveRunState()` commits, drive the ledger to `resumed` via the **real effect chain** `await manager.ledger().advanceToResumed(id, 'requeue')` (`write_response` → resume/requeue effects → `resumed`) — **never direct-apply `resume_ack`** (illegal from `answered_pending_source_write`). Fail-closed if enabled and `ledger()` throws (skip requeue this tick, stay parked).
- [ ] **Step 4: Tests (the load-bearing ones):**
  - existing `resumeParkedRuns` approved + rejected tests still green (run with manager disabled);
  - **new: rejected resume reaches the feedback path** — assert `run.l2Feedback` set and `phase` routed via the l2-gate handler (not merely that `runPipeline` was called — codex flagged the existing test as too weak);
  - enabled: answered recorded before save, resumed after save (ordering); duplicate label tick records once; enabled-but-broken → run stays parked (fail-closed).
- [ ] **Step 5: Shutdown** — call `manager.close()` in the daemon shutdown hook. Run full daemon suite. **Commit** — `git commit -am "feat(daemon): wire l2-gate raise/answer via DI; crash-safe ordering; preserve reject feedback path; fail-closed"`

---

## Task 6: boot reconcile + supersede-on-moot + overdue marking

**Files:** Create `packages/daemon/src/control-plane/decision-escalation/reconcile.ts` (+ `.test.ts`); modify daemon startup + the run-completion/issue-closed path.

- [ ] **Step 1–4:** TDD `bootReconcile(manager)` (calls `ledger().reconcile()` when enabled, no-op disabled); `supersedeIfMoot(ledger, run, issueState)` — issue closed / run complete → **first `reader.get(id)` and SKIP if the row is missing (`undefined`) OR its status is terminal (`resumed`/`superseded`/`failed`)** (applying `source_superseded` to a missing or terminal row throws — it is legal only from a present, non-terminal status); otherwise drive the **`source_superseded`** transition (there is **no** `withdraw` event; the real event set is `notify, opened, answer_submitted, write_response, resume_dispatch, resume_ack, source_superseded, expire, re_notify, …` — read `state-machine-types.ts`). Add tests proving terminal rows are skipped, not thrown on.; `markOverdue(ledger, now)` — for rows past `expires_at` **whose status is `notified` or `viewed` only** (the real `expire` transition is legal only from those; applying it to `detected`/`answered_pending_source_write`/`source_written`/`resume_requested` throws), drive **`expire`** with a deterministic `semanticKey` derived from `expires_at` (mark only; no delivery). Build each test-first against a real writer; add tests proving other non-terminal states are skipped, not thrown on.
- [ ] **Step 5:** wire `bootReconcile` after `manager.init()` at startup; `supersedeIfMoot` at the closed-issue/complete-run site; `markOverdue` in the tick (enabled-guarded). **Commit.**

---

## Task 7: lifecycle integration test (enabled, real sqlite) + disabled no-op

**Files:** Create `packages/daemon/src/control-plane/decision-escalation/lifecycle.integration.test.ts`.

- [ ] **Step 1:** enabled over a temp sqlite: park → raise (`detected`, epoch 1) → re-scan no dup → `l2-approved` → answered-once → requeue → resumed; assert the ledger lifecycle matches the daemon requeue outcome (no divergence). Second park (rework) → epoch 2 → distinct decision. Rejected variant → feedback path + ledger `answered`.
- [ ] **Step 2:** disabled: same park/resume path, zero ledger interaction (spy asserts no import/writes), behavior identical to today.
- [ ] **Step 3:** Run → green. **Commit.**

---

## Task 8: CI native build (mandatory) + full-suite gate + traceability code_paths

**Files:** Modify `.github/workflows/*` (test job); `.specify/traceability.yml` (add the now-existing code_paths/test_paths to the two STACK entries — they were deferred pending these files).

- [ ] **Step 1:** **better-sqlite3 native build is a workspace install concern** (codex: optionalDeps does NOT isolate `packages/*` install). Ensure the CI test job builds native deps (node-gyp toolchain present on the macOS host runner; add an explicit `pnpm rebuild better-sqlite3` step if needed). Grep `.github/workflows/`.
- [ ] **Step 2:** `pnpm -r test && pnpm -r typecheck` from root — all green (ported protocol + decision-index suites + daemon suite).
- [ ] **Step 3:** Now that `packages/decision-protocol/`, `packages/decision-index/`, `packages/daemon/src/control-plane/decision-escalation/` exist, add their paths to `STACK-AC-DECISION-ESCALATION-STORE` / `-EMITTER` in `.specify/traceability.yml` (the path validator now passes). Run `pnpm --filter @runforge/daemon test -- traceability-paths`. **Commit.**

---

## Self-review notes (author)
- **Findings resolved:** copy `test/`+`schema/`+`drizzle.config.ts`+vitest configs (T1/T2); real `createIndexWriter` deps + v1 adapters + protected key/dir (T3); `DecisionLedger` over the real `observeRequest/applyEvent/runEffect/reconcile/reader` verbs — no invented methods (T3); full `DecisionRequestSchema` builder + `assertFullyClassified` (T4); rejected-path: don't strip `l2-rejected` before the handler consumes it + a test that asserts the feedback path, not just `runPipeline` called (T5); native build = CI workspace concern, not optionalDeps (T8); `zod-to-json-schema ^3.25.1` (T1); package path `packages/decision-protocol` matches L3 (all tasks); DI via `createPhaseHandlers` context + one-place env parse + shutdown close (T5); traceability code_paths added when files exist (T8).
- **Dependency order:** T1→T2→T3→T4→T5→T6→T7→T8.
- **Existing-file edits:** every one says re-grep first (line numbers drift).
