---
date: 2026-06-02
status: draft-for-review
type: design-doc
topic: Decision-escalation fold — pm-cockpit packages → runforge + DecisionRequest emitter
references:
  - .specify/functional/decision-escalation.md (FUNC-AC-DECISION-ESCALATION, L1)
  - .specify/architecture/decision-escalation.md (ARCH-AC-DECISION-ESCALATION, L2)
  - .specify/stack/decision-escalation-store-ts.md (STACK-AC-DECISION-ESCALATION-STORE, L3)
  - .specify/stack/decision-escalation-emitter-ts.md (STACK-AC-DECISION-ESCALATION-EMITTER, L3)
  - runforge #685
---

# Decision-escalation fold — design

> Implementation design for the #685 DecisionRequest emitter. The spec chain (L1→L2→L3) is canonical on `main`; this doc is the concrete fold + wiring design that the implementation plan executes. Sparring-driven: codex picked **P1 + S2** in the brainstorm.

## Goal

Fold pm-cockpit's two proven decision-lifecycle packages into runforge and wire a **DecisionRequest emitter** into the daemon control-plane, so that every run pause needing a human choice becomes a uniform, durable, idempotent decision record — realizing FUNC-AC-DECISION-ESCALATION. **Port, don't rewrite:** the packages carry 270+ unit tests plus a live real-GitHub e2e; preserve their shape, lifecycle, two-phase outbox, idempotency, migrations, and adapter contracts.

## Current state

- **Daemon pause is GitHub-label-based.** Phase handlers set `run.pausedAtPhase` and post an `awaiting-l2-review` label; `resumeParkedRuns()` scans for `l2-approved`/`l2-rejected` each tick and re-queues by resetting `run.phase`. Human-required failures (`failure-routing.ts` `humanActionRequired`) stop the run at `stuck`. **No outbound notification exists; no mid_run session resume exists** (sessions run to completion; parked runs wait at a phase boundary).
- **Persistence is Postgres-only** (`drizzle` + `postgres-js`, `RUNFORGE_DATABASE_URL`); `backend-kind.ts` hard-rejects `sqlite`. Local episodic state lives in `./state/*.json|*.jsonl` via `StateManager`.
- **The packages to fold:** `@pm/protocol` (pure zod types + decision lifecycle; zod ^3.23.8) and `@pm/index` (better-sqlite3 + drizzle durable core: `IndexWriter` facade, two-phase outbox with deterministic effect IDs, transition-key idempotency, protected store, quarantine, migrations, adapters `Notifier`/`SourceSink`/`ResumeDispatcher`; drizzle ^0.36, better-sqlite3 ^11.8).

## Design (chosen: P1 + S2)

### P1 — port onto runforge's toolchain
Bring both packages in under `@runforge/*` and **upgrade their substrate** to the monorepo's versions (zod ^4, drizzle ^0.45, better-sqlite3 ^12), preserving every contract, table, migration, and lifecycle rule. Rationale: the DecisionRequest contract is a control-plane *trust* primitive; pinning zod3/drizzle0.36 in two new packages would plant a permanent major-version type boundary exactly where the contract must be trusted. "Port don't rewrite" preserves *behavior and shape*, not the dependency versions.

### S2 — additive emitter (ledger now, executor later)
**v1 scope: `l2-gate` decisions only.** That is the one pause path that actually parks (`run.pausedAtPhase === 'l2-gate'`) and has a working label executor (`resumeParkedRuns()`). `stuck` / `humanActionRequired` failures do NOT park today — they terminate at `stuck` with no resume path — so emitting decisions for them would create *unanswerable* records. They are deferred until they have a real executor.

The decision-index becomes the **durable, uniform record** of l2-gate decisions and the **source of "what's pending,"** while the daemon's existing label-based requeue **stays the executor**:
- **raise** at the **caller that parks the run** (the l2-gate phase handler / the pipeline park point) — NOT inside the pure synchronous `classifyPhaseFailure()` classifier. Ingest a `DecisionRequest` (`detected`→`notified`).
- The Operator answers as today (labels). When `resumeParkedRuns()` observes `l2-approved`/`l2-rejected` it **records `answered` in the index first** (answered-once via `decisionResponses` + `appliedTransitions`), then performs the existing requeue, and **marks `resumed` only after the daemon has durably saved the unparked run state**.
- **reconcile** on daemon boot completes any in-flight index transition exactly once (two-phase outbox + claim-lease) and exposes a **pending-decisions read path**.

**Executor/ledger split — crash-safe ordering (load-bearing):** the index is the *system of record* for the decision lifecycle; the daemon's label path is the *executor*. Ordering rules so the two never diverge:
1. record `answered` **before** requeue;
2. mark `resumed` **only after** `saveRunState()` of the unparked run commits;
3. the v1 `ResumeDispatcher` does **not** ack a resume effect until the daemon executor has committed — it is driven from the post-requeue point, not fire-and-forget;
4. move the daemon's destructive **label removal to after** `saveRunState()` — today it removes labels first, so a crash between removal and save strands the run with no answer left to rediscover; **this ordering fix is part of v1**.

The two-phase outbox + boot reconcile keep the index's *own* state crash-safe; heavyweight dispatch effects stay light until S1. `Notifier` logs only (delivery deferred).

### Rejected alternatives
- **P2 (pin zod3/drizzle0.36 in the new packages):** two zod majors in one monorepo; type-incompat smell precisely at the DecisionRequest boundary the daemon must trust.
- **S1 (index as source of truth — rewrite `resumeParkedRuns` to read the index, labels become a mirror):** correct end-state, too much blast radius for v1; deferred.
- **Protocol-only fold + a thin daemon store:** throws away the proven `@pm/index` (outbox/idempotency/crash-safety) — violates "port don't rewrite."

## v1 compliance scope (FUNC-AC-DECISION-ESCALATION)

v1 is a **scoped, honest subset** of the L1 — not full compliance. Stated explicitly so nothing is silently dropped:
- **Realized:** uniform decision record (raise); answer-once; no-resume-before-answer-recorded; crash-safe `answered`→`resumed` ordering; idempotent dedup across both repeated scans and distinct rounds (epoch); withdraw-on-moot; overdue *marking*; pending-decisions read.
- **Deferred (each gets a follow-up issue):** outbound notification *delivery* / overdue re-surfacing channel; mid_run resume; decisions for `stuck`/`humanActionRequired` pauses (l2-gate only in v1); the index as source-of-truth (S1); sensitive/protected-content beyond structured-fields-only.
- **Sensitive-withhold (v1 minimal):** only structured, known-safe fields (question, phase, choices, run ref) enter the index. Free-form operator/external text (`handoffNotes`, `l2Feedback`, raw failure messages) is **not** copied into shared decision fields.

## Integration details

- **New packages:** `packages/protocol` (`@runforge/protocol`) and `packages/decision-index` (`@runforge/decision-index`). `server-only` is dropped (no Next.js boundary in the daemon); the `.server` protected-resolve export is omitted in v1 (sensitive-data handling dormant).
- **Daemon deps:** add `@runforge/protocol` (`workspace:*`) to `packages/daemon/package.json`. **Do NOT add `better-sqlite3` to the daemon** — it lives only inside `@runforge/decision-index`. To keep a native-build failure from breaking daemon install when the feature is unused, `@runforge/decision-index` is an **`optionalDependencies`** entry of the daemon (and `better-sqlite3` is an optional dep within that package); the daemon never statically imports or re-exports it. Dynamic import alone gates *runtime* load; optional-dependency placement gates *install/build*.
- **Location + gating (native dep truly gated):** decision-index SQLite at `state/decision-index.sqlite` (absolute-resolved at startup), gated by `RUNFORGE_DECISION_INDEX_ENABLED` (default **off**), optional `RUNFORGE_DECISION_INDEX_PATH`. `better-sqlite3` lives **only** in `@runforge/decision-index`; the daemon **dynamically imports** that package **only inside the enabled branch**, never at module top-level — so a disabled deployment never loads native code, and an install/build/native-load failure cannot break the daemon when the flag is off (a disabled-mode test asserts no SQLite load). A daemon-owned **`DecisionIndexManager`** (not `StateManager`, which today owns only `stateDir`) handles init/accessors/close in the daemon lifecycle. **`backend-kind.ts` stays Postgres-only** — the index is a separate control-plane store, not daemon persistence, and does not consume the Postgres pool. **Failure handling distinguishes disabled vs enabled-but-failed:** flag **off** → the old label path runs unchanged (no-op, no SQLite load). Flag **on** but the index is unavailable (open/native-load failure) → **fail closed** for decision-managed l2-gate resumes: the run stays parked and `resumeParkedRuns()` refuses to requeue it until `answered` can be durably recorded (it does NOT fall back to the unguarded label path, which would advance a run on unconfirmed state — violating answered-before-requeue). The daemon itself keeps running; only l2-gate resume is held.
- **raise hook:** the **l2-gate phase handler / pipeline park point** (the caller performing the park) — NOT the pure `classifyPhaseFailure()` classifier (it has no daemon call site and must stay side-effect-free). The `DecisionRequest` id is **deterministic on `(runId, phase, decisionKind, decisionEpoch)`**, where `decisionEpoch` is a per-pause counter persisted on `RunState`, incremented on each fresh park at a phase. Repeated per-tick scans of the *same* pause reuse the id (idempotent); a *later distinct* pause of the same run+phase (an l2-gate re-review after rework) gets a new epoch → a new decision, so answer-once and pending visibility are never collapsed across rounds.
- **answer hook (preserve existing routing):** in `resumeParkedRuns()`, after the existing label detection, record `answered` in the index (first valid wins) before the requeue, then mark `resumed` only after the unparked `saveRunState()` commits (crash-safe ordering above). **The existing approve-vs-reject routing must be preserved EXACTLY — the emitter records, it does not change the flow.** Today `resumeParkedRuns()` re-enters **`l2-gate`** for *both* outcomes (resets `phase='l2-gate'`, `pausedAtPhase=undefined`, re-queues — see the existing `resumeParkedRuns` tests for both `l2-approved` and `l2-rejected`); the **l2-gate phase handler** (`phases.ts`) is what then captures rejection feedback into `run.l2Feedback` and routes to `l2-design`. The emitter only records `answered`/`resumed` in the index around this unchanged two-step. The one behavioral change v1 makes is the **crash-safe reorder** (record `answered` first; remove labels + mark `resumed` after `saveRunState()`); it must NOT strip `l2-rejected` before the existing handler/resume logic has consumed it, and must NOT alter which phase the run re-enters. Conflicting labels (`l2-approved` AND `l2-rejected`) keep the existing **approved-wins** behavior, recorded explicitly as the chosen option.
- **withdraw hook:** when a parked run's decision becomes moot — its issue is closed, the run completes, or it leaves the l2-gate phase by another path — `withdraw` the pending decision so the pending-source does not accumulate stale items.
- **overdue:** the `DecisionRequest` carries a `deadline`; a reconcile pass marks lapsed decisions `overdue` in the index so the pending read reflects it (re-surfacing *delivery* is deferred; the overdue *state* is v1).
- **reconcile hook:** boot-time `outbox.reconcile()` wired into daemon startup via `DecisionIndexManager`; a pending-decisions accessor for read.
- **Explicitly unchanged:** Postgres stores, the label semantics, the requeue executor, `backend-kind`.

## File topology

- **New:** `packages/protocol/**`, `packages/decision-index/**` (ported), `packages/daemon/src/control-plane/decision-escalation/**` (emitter shim + adapters + wiring).
- **Modified:** `packages/daemon/package.json` (deps), `pnpm-workspace.yaml` (glob already covers `packages/*` — no change expected), `packages/daemon/src/control-plane/state.ts` (init/accessor/shutdown), `failure-routing.ts` + the l2-gate phase handler (raise), `resumeParkedRuns` in `daemon.ts` (answer), daemon startup (reconcile), env example files.
- **Explicitly unchanged:** `backend-kind.ts`, `packages/db/**`, the Postgres schema.

## Test strategy (TDD)

- **Port the packages' existing tests** (protocol + index, 270+); fix only what the zod4/drizzle0.45 upgrade requires — a failing ported test is a porting bug, not a spec change.
- **Daemon integration tests:** raise is idempotent across repeated tick scans; answer-once under duplicate label detection; boot reconcile completes an interrupted transition exactly once; index-disabled (flag off) is a no-op that leaves the label path untouched.
- **Live e2e** (Phase 9, post-merge): a real parked run → raise creates the record → label answer → index records answered-once → requeue proceeds; verify the answer-from-`notified` path applies `opened` first.

## Risks (codex top-5 + 2)

1. **zod4 migration** breaks protocol inference / discriminated unions (zod 3→4 has breaking changes). *Verify: port compiles + protocol tests green.*
2. **drizzle 0.36→0.45** changes migration/query behavior. *Verify: index migrations apply + index tests green.*
3. **better-sqlite3 ^12 native build** fails in the macOS host CI runner. *Verify: CI installs + a smoke open/close passes on the runner.*
4. **Idempotency dedupe** — repeated pause scans must not create duplicate DecisionRequests. *Verify: deterministic-id raise test.*
5. **Label/answer race** — `resumeParkedRuns` recording an answer concurrently with phase reset could record stale. *Verify: answer-once + ordering test.*
6. **State dir not writable** (read-only mount) → index open fails. *Verify: graceful-degrade test.*
7. **Executor/ledger split drift** — the index records `resumed` while the daemon owns the actual requeue; the two must not diverge. *Verify: an integration test asserting the index lifecycle matches the daemon's requeue outcome.*

## Follow-ups (deferred — not this PR)

- **S1:** decision-index as source of truth (rewrite `resumeParkedRuns` to read the index; labels become a mirror).
- **Decisions for `stuck` / `humanActionRequired` pauses** — need a real executor first (those terminate at `stuck` today with no resume path); v1 is l2-gate-only.
- **mid_run** session resume (requires session-runtime pause/resume hooks that don't exist today).
- **Outbound notifier delivery** (Slack/email/dashboard push).
- **Sensitive / protected-content** behavior (deployment-runtime concern; carried dormant).
- **`server.ts POST /retry`** boot endpoint (operator-triggered restart-with-answer).

## Migration plan

Additive and **env-gated (default off)** → zero disruption to existing deployments. Land the packages + wiring dark; enable `RUNFORGE_DECISION_INDEX_ENABLED=true` first on the macOS host (the regulated pilot deployment #1) once the live e2e passes. No data migration (new store).
