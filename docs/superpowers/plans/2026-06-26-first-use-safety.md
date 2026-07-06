# First-Use Safety Hardening — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-06-26-first-use-safety-design.md` (codex-CLEAN)
**Base:** `origin/main` @ `a884135` · **Topic:** `first-use-safety`
**Two PRs, in order:** PR1 (decision-index approval surface — hard-blocker) → PR2 (unattended safety net).

## Conventions (apply to every task)
- Worktree node_modules MUST be synced: `pnpm install --frozen-lockfile` before any build/lint/test (a stale install yields spurious `strict-boolean-expressions` errors).
- Daemon tests: `pnpm --filter @runforge/daemon exec vitest run <path>`. Decision-index tests: `pnpm --filter @runforge/decision-index exec vitest run <path>`.
- Real-Postgres-gated tests run only when `RUNFORGE_TEST_DATABASE_URL` is set (CI sets it); locally they `skipIf(!REAL_PG)`.
- Gate checks before any commit: `pnpm --filter @runforge/daemon lint && pnpm typecheck`. Repo lint: `pnpm lint`.
- **No real timers in unit tests** — inject a clock (per `daemon_pipeline_test_load_flake` convention). Real-PG tests take the shared `SERIALIZE_LOCK` via `__fixtures__/pg-test-harness.ts`.
- Update `.specify/traceability.yml` when adding files; extend governing L2/L3 spec text (NOT L0/L1) via l2/l3-spec-guardian.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## PR1 — Decision-index approval surface (branch `codex/first-use-safety-pr1-build`)

### T1.1 — Manager runtime-degraded marker (governed-only marking policy)
**Files:** `packages/daemon/src/control-plane/decision-escalation/manager.ts` (+ its test).
**Change:** add a private `#runtimeDegraded: boolean` + `markRuntimeDegraded(reason: string)` / `clearRuntimeDegraded()` / `isRuntimeDegraded(): boolean`. Semantics: marking is **governed-only** (callers only mark for a deployment-configured run); `clearRuntimeDegraded()` is invoked **only** after a *successful governed merge-decision op*. Do NOT couple to `#broken` (which is init-only) — this is a separate runtime signal.
**Acceptance:** unit test — `markRuntimeDegraded` flips `isRuntimeDegraded()` true; `clearRuntimeDegraded` resets; default false; independent of `#enabled`/`#broken`.
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/decision-escalation/manager.test.ts`

### T1.2 — Wire the marking policy into all approval-path ledger interactions
**Files:** `packages/daemon/src/control-plane/phases.ts` (integrate handler ~2193 floor, ~2247-2251 publish catch), `daemon.ts` (resume `statusOf` ~2515-2522, `answer` ~2560-2568, `advanceToResumed` ~2620-2626, tick reconcile/markOverdue ~1293-1304).
**Change:** at each site, **for a governed run** (`config.deployment !== undefined`), on failure/floor-miss call `decisionManager.markRuntimeDegraded(reason)`; on a *successful* governed merge-decision op call `clearRuntimeDegraded()`. Prefer a single small helper (`withGovernedDecisionMarking(manager, deploymentId, fn)`) to avoid scattering try/catch. Do NOT change the existing fail-closed control flow (still `return 'failure'` / park-and-retry) — only add the marker side-effect.
**Acceptance (per-site, plan-review IMPORTANT):** a governed run sets the marker at **each** site — `phases.ts:2193` floor miss, integrate publish `raise`/`notify` failure (`phases.ts:2247-2251`), resume `statusOf` failure (`daemon.ts:2515-2522`), `answer` failure (`daemon.ts:2560-2568`), `advanceToResumed` failure (`daemon.ts:2620-2626`), tick `reconcile`/`markOverdue` failure (`daemon.ts:1293-1304`); a subsequent **successful governed** merge-decision op clears it; a successful **non-governed or l2-gate** op does **NOT** clear a governed-set marker.
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/merge-decision-wiring.integration.test.ts` + the daemon resume tests.

### T1.3 — Boot guard (A1): refuse boot for a configured deployment when index unavailable OR registration failed
**Files:** `packages/daemon/src/control-plane/daemon.ts` (~363-376, after deployment registration), mirroring the sanitizer fail-closed at ~384-400.
**Change:** when `config.deployment !== undefined`:
- if `deploymentRegistry.register(...)` returned/threw a failure → `return err(<registry rejection reason>)` (today only `console.error`s).
- else if `!decisionManager.isAvailable()` → `return err(<reason>)` with an operator-readable message distinguishing: index **disabled** (`!isEnabled()` → "set RUNFORGE_DECISION_INDEX_ENABLED=1"), **enabled-but-unreachable** (`isEnabled() && !isAvailable()` → "decision index unreachable: <reason>").
**Acceptance:** boot tests — (governed + index-disabled → err w/ disabled msg); (governed + enabled-but-broken → err w/ unreachable msg); (governed + registration-rejected → err w/ rejection reason); (governed + available + registered → boots ok); (non-governed + index-disabled → boots ok).
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/daemon.test.ts -t "boot guard"`

### T1.4 — `DecisionManagerLike`/`DecisionLedgerLike` seam + lifecycle fake
**Files:** new `packages/daemon/src/control-plane/decision-escalation/__fixtures__/fake-decision-ledger.ts` (+ the seam interfaces, co-located or in a types file).
**Change:** define the seam from the **actual** call sites used by the test's entry point (`resumeParkedRuns`/`resumeIntegrateParkedRun` + the integrate phase handler) — a missing method must fail compilation. **Place each method on the object the real call site uses** (plan-review IMPORTANT): `reader` is `ledger().reader` (NOT a manager method — `daemon.ts:1773`, `ledger.ts:45`), so it belongs on `DecisionLedgerLike`; `protectedStore`/`revealProtected` per their real call sites. Provisional split (verify against the code): `DecisionManagerLike`: `init`, `isEnabled`, `isAvailable`, `ledger`, `protectedStore`, `close`, runtime-marker accessors. `DecisionLedgerLike`: `raise`, `notify`, `answer`, `statusOf`, `advanceToResumed`, `reconcile`, `reader`, plus any tick-maintenance method touched. Injection: the fake is supplied to the daemon via the **same seam `daemon.test.ts:4283` uses to inject its real manager** (confirm that injection path; if `startDaemon` constructs the manager internally with no seam, add a minimal test-only injection opt). The fake enforces: `raise`→`raised`; `notify`→`notified`; `answer` rejects an off-menu choice, applies answer-once (identical re-answer = no-op; conflicting = reject; terminal/`resumed` unchanged), →`answered`; `advanceToResumed`→`resumed`.
**Acceptance:** the fake's own unit test proves each invariant (off-menu reject, answer-once no-op, conflicting reject, terminal unchanged).
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/decision-escalation/__fixtures__/fake-decision-ledger.test.ts`

### T1.5 — Joined round-trip test (CI-default, no Postgres) — the A2 proof
**Files:** `packages/daemon/src/control-plane/daemon.test.ts` (new `describe`).
**Change:** `resumeIntegrateParkedRun` is **private** — drive it through the existing `daemon.test.ts:4283` harness pattern (`startDaemon` with the injected T1.4 fake + fake timers + `resumeParkedRuns`), NOT by calling the private fn directly. Chain: integrate park (`phases.ts`) → mock publisher → synthesized `**DecisionResponse**` approve comment → `parseCockpitAnswer` → `resumeIntegrateParkedRun` → integrate override with a **mock `integrateToStaging`**. Assert: approve → `mergeDecisionApprovedEpoch` set + `integrateToStaging` **called** (merge executes); reject → routed to `implement` with feedback, `integrateToStaging` **not** called; conflicting double-answer → rejected (answer-once).
**Acceptance:** the new test passes CI-default (no `RUNFORGE_TEST_DATABASE_URL`).
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/daemon.test.ts -t "round-trip"`

### T1.6 — Extend the real-PG resume test through the merge
**Files:** `packages/daemon/src/control-plane/daemon.test.ts:4283` (`describe.skipIf(!REAL_PG)`).
**Change:** extend the existing approve case so it continues *through* the integrate override and asserts the merge step is reached (today it stops at "resumed"). Use a mock `integrateToStaging` to assert execution without a real git merge.
**Acceptance:** with `RUNFORGE_TEST_DATABASE_URL` set, the extended test reaches+asserts the merge; without it, it skips (unchanged).
**Test (local, with PG):** `RUNFORGE_TEST_DATABASE_URL=<url> pnpm --filter @runforge/daemon exec vitest run src/control-plane/daemon.test.ts -t "integrate park resume"`

### T1.7 — Spec-chain + traceability (PR1)
**Files:** `.specify/architecture/decision-escalation.md` (index = required escalation transport; governed+unavailable = fail-closed at boot), `.specify/architecture/operational-safety.md` (A1 boot-guard fail-safe), `.specify/architecture/deployment-registry.md` (the "merge-governed = `config.deployment` present" predicate); L3: `.specify/stack/decision-escalation-emitter-ts.md` (boot guard + runtime marker), `.specify/stack/decision-escalation-store-ts.md` / `operator-surface-api-ts.md` (round-trip `test_paths`); `.specify/traceability.yml` (add new test/fixture files to the relevant `code_paths`/`test_paths`).
**Acceptance:** `pnpm --filter @runforge/daemon exec vitest run src/infra/traceability-paths.test.ts` passes (all `code_paths` resolve).

**PR1 gate (all must pass):** `pnpm install --frozen-lockfile && pnpm --filter @runforge/daemon lint && pnpm typecheck && pnpm --filter @runforge/daemon exec vitest run src/control-plane/decision-escalation src/control-plane/daemon.test.ts src/control-plane/merge-decision-wiring.integration.test.ts src/infra/traceability-paths.test.ts`
**PR1 commit template:** `feat(daemon): decision-index approval boot-guard + round-trip proof (first-use PR1)`

---

## PR2 — Unattended safety net (branch `codex/first-use-safety-pr2-build`, off PR1's merge)

### T2.1 — `hasConfiguredAlertChannel` + `pauseReason`
**Files:** `packages/daemon/src/config.ts` (helper `hasConfiguredAlertChannel(config): boolean` abstracting `webhooks`), the daemon pause sites for `pauseReason`.
**Change:** add `hasConfiguredAlertChannel` (true iff ≥1 usable channel; today = non-empty `webhooks`). Add a `pauseReason: 'manual'|'budget'|'stuck'|'tick-error'|'runtime-source'` propagated at the set-`paused` sites (`daemon.ts:1124/1188/1206/1237/1662`) and surfaced in `getStatus()`.
**Acceptance:** `hasConfiguredAlertChannel` truth table; each pause site stamps the correct `pauseReason` (visible via `getStatus()`).
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/config.test.ts` (+ a daemon pauseReason test).

### T2.2 — B1: non-silent empty channel
**Files:** `packages/daemon/src/control-plane/daemon.ts` (pause sites), optionally `notify.ts`.
**Change:** when an auto-pause/escalation fires and `!hasConfiguredAlertChannel(config)`, emit a structured `console.warn` (the no-op is never silent). No SSRF change.
**Acceptance:** test — an induced auto-pause with zero channels logs the warning; with a channel, `notify()` is invoked.
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/notify.test.ts` + a pause-site test.

### T2.3 — B2: governed-without-channel → warn + degraded (NOT refuse)
**Files:** `packages/daemon/src/control-plane/daemon.ts` (boot), state for the degraded flag.
**Change:** at boot, if `config.deployment !== undefined && !hasConfiguredAlertChannel(config)`: loud startup warning + set a persistent `alertChannelDegraded=true` flag readable by `/health`. **Do not refuse boot.**
**Acceptance:** (governed + no channel → boots, warning emitted, flag set); (governed + channel → no flag); (non-governed + no channel → no flag, boots).
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/daemon.test.ts -t "alert channel"`

### T2.4 — B5: `pollStartedAt` + poller snapshot accessor
**Files:** `packages/daemon/src/control-plane/repo-manager.ts` (RepoEntry ~9-18, startPoll ~169-184).
**Change:** add `pollStartedAt: number | null` set when `pollInProgress` goes true (`:171`), cleared when it goes false (`:182`); add a read-only `pollerSnapshot()` accessor returning per-repo `{pollInProgress, pollStartedAt}`. Use an injectable clock.
**Acceptance:** snapshot reflects start time while a poll runs; cleared after; clock injectable in tests.
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/repo-manager.test.ts`

### T2.4b — Active-run progress reader (prerequisite for T2.5 run-stall — plan-review CRITICAL)
**Files:** `packages/daemon/src/control-plane/daemon.ts` (the active-run tracking near `activeIssues` ~1142/1390), `state.ts`.
**Change:** the daemon currently tracks only `activeRuns` (a count) + `activeIssues` (a Set of issue numbers) — there is **no** per-active-run `updatedAt` the watchdog can observe. Add a reader the watchdog can call: for each member of `activeIssues`, obtain its last-progress timestamp. Primary mechanism: **read the persisted `updatedAt` via the existing run-state loader** (`loadRunState(issue).updatedAt`) — no new mutable in-memory registry to keep in sync, and `saveRunState` already persists `updatedAt` on every progress write (`state.ts:21`). If the loader is too heavy to call per watchdog tick, fall back to a lightweight in-memory `Map<issue, lastUpdatedAt>` touched wherever `saveRunState` runs for an active run. Expose `activeRunProgress(): Array<{issue, lastUpdatedAt}>`.
**Acceptance:** `activeRunProgress()` reflects the persisted `updatedAt` for each active issue; a run that keeps calling `saveRunState` shows an advancing timestamp.
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/daemon.test.ts -t "active run progress"`

### T2.5 — B5: watchdog detectors (detect → safe-pause + notify + 503; NO force-release)
**Files:** `packages/daemon/src/control-plane/daemon.ts` (a watchdog tick), reading `pollerSnapshot()` (T2.4) + `activeRunProgress()` (T2.4b).
**Change:** a periodic watchdog (injectable clock) that detects, for a configurable `idleTimeoutMs` (default = 3h subprocess max + 15m grace): **run-stall** (an `activeRunProgress()` entry whose `lastUpdatedAt` is older than idleTimeout) and **tick-stall** (`pollStartedAt` older than idleTimeout while `pollInProgress`). On detection: set `paused=true` (`pauseReason='stuck'`) + `notify()` once + record the state for `/health` 503. **Do NOT decrement `activeRuns`, do NOT cancel** the run.
**Acceptance:** with injected clock — run-stall (frozen `lastUpdatedAt`, past idle) → pause+notify+watchdog-state set, **`activeRuns` unchanged**; tick-stall (frozen `pollStartedAt`) → pause; progressing run (advancing `lastUpdatedAt`) → NOT flagged; a run under idleTimeout → NOT flagged.
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/daemon.test.ts -t "watchdog"`

### T2.6 — B4: truthful `/health` (real server) with the 503/200 mapping
**Files:** `packages/daemon/src/control-plane/server.ts:71-75` (real-server `/health`); thread a state provider (reuse `getStatus()` + heartbeat age + watchdog state + `alertChannelDegraded` + the manager runtime-degraded marker).
**Change:** compute status per the spec mapping:
- **503**: `consecutiveStuckCount >= maxConsecutiveStuck`; watchdog tick/run-stall; repo tick stale > N intervals while not paused/draining; safety pause (`pauseReason ∈ {budget,stuck,tick-error,runtime-source}`) beyond grace; **a governed daemon** (`isGoverned = config.deployment !== undefined`, passed into the health evaluator) **with the manager runtime-degraded marker set OR `isEnabled() && !isAvailable()`** — the index check is **governed-scoped**; a non-governed daemon's index state is never a `/health` signal (plan-review IMPORTANT — test non-governed-index-unavailable → 200-ok separately).
- **200 `degraded:true`**: startup-degraded-retrying; manual pause (`pauseReason='manual'`); draining; transient alert send failure; governed-without-channel (`alertChannelDegraded`).
- **200 `ok:true`**: normal. Decision-index *disabled* on a non-governed daemon is normal (NOT degraded). The degraded-boot server (`degraded-server.ts:36-37`) is unchanged; document the handoff.
**Acceptance:** `/health` status-code matrix test — each signal → 503 / 200-degraded / 200-ok; manual-vs-safety pause distinguished; non-governed index-off → ok.
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/server.test.ts -t "health"`

### T2.7 — process handlers (inside `startDaemon`) + running.md prerequisite
**Files:** `packages/daemon/src/control-plane/daemon.ts` (`startDaemon`, after config load — where `config.webhooks` + the private drain/shutdown at ~2744 are in scope), `docs/running.md`.
**Change (plan-review IMPORTANT):** install `process.on('uncaughtException')` / `('unhandledRejection')` **inside `startDaemon()` after config load** — NOT in `main.ts` (which only awaits `startDaemon()` and has no access to `webhooks`/drain). The handlers `notify()` (if `hasConfiguredAlertChannel`) + exit gracefully (set exitCode, attempt drain). Update **`docs/running.md`** (which already documents the plist, MINOR): governed deployments MUST configure an external `/health` monitor (healthchecks.io / launchd) — the explicit deployment prerequisite (Codex Q7); document the `KeepAlive=true`+`ThrottleInterval=30` crash-loop caveat.
**Acceptance:** smoke test — an unhandled rejection triggers the handler (notify attempted, graceful exit path).
**Test:** `pnpm --filter @runforge/daemon exec vitest run src/control-plane/daemon.test.ts -t "process handlers"` (a focused unit around the handler fn).

### T2.8 — Spec-chain + traceability (PR2)
**Files:** `.specify/architecture/operational-safety.md` (B2 degraded, B4 truthful `/health`, B5 detect-watchdog), `.specify/architecture/operator-surface.md` (if `/health` is operator-surface); L3: `.specify/stack/operational-safety-ts.md` (daemon watchdog/health), `.specify/stack/control-plane-ts.md` (notify/server/repo-manager), `.specify/stack/conventions-ts.md` (config); `.specify/traceability.yml`. Record the deferred `B2-strict`/`B5-cancel`/`B3` as documented follow-ups (not code).
**Acceptance:** `pnpm --filter @runforge/daemon exec vitest run src/infra/traceability-paths.test.ts` passes.

**PR2 gate:** `pnpm install --frozen-lockfile && pnpm --filter @runforge/daemon lint && pnpm typecheck && pnpm --filter @runforge/daemon exec vitest run src/control-plane src/config.test.ts src/main.test.ts src/infra/traceability-paths.test.ts`
**PR2 commit template:** `feat(daemon): unattended safety net — alerting, truthful /health, watchdog (first-use PR2)`

---

## End-to-end verification (Phase 9 — after each PR merges)
Per the spec's "End-to-end verification design" against the demo deployment (`~/code/runforge-demo-runtime`, Postgres `runforge_demo`, target `cause-driven-tasks`). Captured in `docs/superpowers/plans/2026-06-26-first-use-safety.execution-log.md`.
- **PR1:** index-ON boots; index-OFF governed refuses (negative); seed a **yellow/escalate** change → parks at integrate → `decision-request` issue carries the block → post approve `DecisionResponse` → **resumes + merges**; repeat reject → routes to implement. Capture issue URL + block JSON + merge SHA.
- **PR2:** governed + no webhook → boots `degraded:true` (`curl /health`); webhook configured → induced auto-pause fires it; `/health` 200-ok / 200-degraded(manual pause) / 503(induced stuck); orchestration hang → watchdog self-pause + 503 + slot held (restart clears); stop demo PG mid-run → `/health` 503 (governed runtime marker).

## Dependency order
T1.1 → T1.2 (marker before wiring) → T1.3 (boot guard) ‖ T1.4 (seam) → T1.5/T1.6 (tests) → T1.7 (specs). PR1 merges. Then T2.1 → {T2.2, T2.3, T2.4, T2.4b} → T2.5 (needs T2.4 pollerSnapshot + T2.4b activeRunProgress) → T2.6 (needs T2.1 pauseReason, T2.3 flag, T2.5 watchdog-state, T1.1 marker) → T2.7 → T2.8.
