# P4 (partial) — Escalation Metric + Deployment Budget Abort: Task-Level Plan (4.1 + 4.4)

> Expansion of program-plan Phase 4 (`docs/superpowers/plans/2026-07-02-first-production-deployment-regulated-full-l0.md`), the **fully-provable approved-spec subset**: 4.1 escalation-rate metric ("measurably asks less" — L0's headline differentiator) + 4.4 deployment-level budget abort. Both governed by **approved** L1s (FUNC-AC-OPERATOR-LEARNING v2, FUNC-AC-MERGE-DECISION, FUNC-AC-FLEET). Branch: `plan/p4-earning-half`; build branch: `codex/p4-earning-half-build`.
>
> **Line anchors verified 2026-07-02 at origin/main 14e5578 — grep for symbols, never trust line numbers.**

## Scope + deferral boundary

**IN (this unit — fully approved-spec, fully provable now):**
- **4.1** escalation-rate metric: per-week / per-deployment counts of decisions raised vs. operator-answered, plus auto-merge counts, exposed via a new daemon endpoint and rendered as a dashboard trend. This makes "asks less over time" *measurable* — nothing measures it today.
- **4.4** deployment-level budget hard-abort: enforce the stored-only `DeploymentProfile.budget` (verified enforced nowhere) with a hard abort + escalation at the deployment spend cap.

**OUT (deferred, documented — do NOT build here):**
- **4.2** earn-in wiring (`evaluateEarnIn` → `recordWidening`). Reason (ground-truth finding): FUNC-AC-FLEET's approved **deployment-debut gate** (`fleet.md:62-79` + L0 v7 item 4) requires a deployment's first unattended merge to stay Operator-bound until its first production-release approval records that unattended merging may begin — folded into the release gate (Phase 5), never a third gate. Zero code implements this. So a spec-faithful earn-in must include a default-closed debut-witness gate, and its live "un-touched widening on deployment #0" payoff is Phase-5-gated. Bundle 4.2 with/after Phase 5. (Recorded for the Operator.)
- **4.3** rung-3 act-side — deferred on Operator decision D5 (rung-3 shape) + a known L2 amendment; `docs/superpowers/specs/2026-06-30-operator-learning-rung23-finding-dismissal-DEFERRED.md`.

## Ground truth (independently verified 2026-07-02 @ 14e5578)

- **Decision ledger (Postgres):** `packages/decision-index/src/schema.ts:33-70` (`decisions.created_at` = raised-at; `decisionResponses.answered_at` = answered-at; dedicated `decision_index` schema). `ItemStatus` (`packages/decision-protocol/src/state-machine-types.ts:11-21`) has **no "auto-resolved" state** — every ledger row is, by construction, an escalation that *was* raised. Read model (`packages/decision-index/src/read-model.ts`, methods `get/audit/list/listRanked/detail/hasResponse/recommendedOptionOf`) has **no count/aggregate method** — 4.1 adds one.
- **Auto-merge outcomes** are NOT in the decision-index. The only durable record is `RunState.mergeDecision` (`packages/daemon/src/types.ts:391`, set at `phases.ts:2151-2164` `auto-merge` branch), persisted per-issue as `state/runs/<issueNumber>.json` (`state.ts:21-23`; durable — only `operator-retry.ts:270` deletes, on stuck retry). `StateManager` exposes only `findIncompleteRuns/findParkedRuns/findParkedRunsStrict` — **no "all completed runs" scan**.
- **`WideningRecord` history:** `deployment-registry/types.ts:133-140`, on `AutonomyState.history` (`types.ts:155`), appended by `recordWidening` (`registry.ts:338-421`).
- **No metrics endpoint exists** anywhere (`server.ts:79-539` route dispatch — zero metrics/spend paths; dashboard `app/**` — zero metrics route). 4.1 is the **first** metrics HTTP endpoint.
- **Charting precedent:** recharts already used — `packages/dashboard/components/cost-chart.tsx` (BarChart) rendered from `app/(dashboard)/cost/page.tsx`, a **server component reading a store directly** (`getDashboardStores().costs.listCostEventsSince`), not a daemon endpoint. Two viable seams (below).
- **Computation-pattern precedent:** `packages/daemon/src/coordination/tech-lead/metrics.ts:1-58` (`computeAndStoreMetrics`, deps-injected, 90d retention, flat-JSON time-series via `writeJsonSafe`/`readJsonSafe`). No HTTP exposure. (Check for a `metrics.test.ts` alongside — verifier saw none.)
- **Endpoint seam:** the route-handler object literal in `daemon.ts` (~2190-2252) already closes over `decisionManager` + `deploymentRegistry` (siblings: `answerDecision` ~2190, `widenAutonomy` ~2241); add a sibling there + dispatch `GET /metrics/escalation` in `server.ts` next to `GET /decisions/pending` (~258-270).
- **4.4:** `budget: z.number()` (`deployment-registry/schema.ts:138`), on the frozen profile (`types.ts:114`) — **zero `readDeclaredData(...,'budget')` callers**. Session/run caps are enforced by `CostTracker` (`cost.ts:31-45`, one-per-daemon-process, keyed by issueNumber, global `dailyCost`, gate at `runtime.ts:512`) — **no deployment scope**. FUNC-AC-FLEET (approved) owns `budget` as declared data — pure implementation gap.
- **Test:** daemon `pnpm --filter @runforge/daemon test`; dashboard `pnpm --filter @runforge/dashboard test`; decision-index needs REAL_PG. Mirror: `lane-engine/earn-in.test.ts` (predicate boundaries), `deployment-registry/registry.test.ts`/`autonomy.test.ts`, `coordination/tech-lead/metrics.ts` (computation shape).

## Design decisions (resolved up front)

1. **Metric source = decision ledger + run-state scan, computed in the daemon, served over HTTP** (not the dashboard-store-direct pattern). Rationale: the escalation numerator lives in the daemon's decision-index + `state/runs/*.json`, both daemon-owned; the dashboard already proxies daemon reads (`daemonFetch`). A `GET /metrics/escalation` endpoint keeps the dashboard a thin renderer and matches how `/decisions/pending` already works. (The cost page's store-direct pattern is dashboard-owned cost data — different ownership.)
2. **"auto-resolved" numerator = auto-merge count from a new durable append**, not a `state/runs/*.json` scan. Add a small append-only escalation-metric event log written at BOTH the `auto-merge` branch (`phases.ts:2151`) and the decision-raise seam, so the metric reads one purpose-built time-series (mirrors `tech-lead/metrics.ts` `writeJsonSafe` pattern) rather than scanning per-issue run files (unbounded, and deleted on retry). The decision-index already durably records *raised/answered*; the new log adds the *auto-resolved* counterpart so the ratio is computable.
3. **Weekly buckets, per-deployment, 90-day retention** (mirror `tech-lead/metrics.ts` retention). The trend = escalations/week and operator-touches-per-delivered-change/week.
4. **4.4 seam = the CONTROL-PLANE, not runtime (codex-corrected CRITICAL).** `SessionRuntime.spawnSession`/`CostTracker.reserveCost` (`runtime.ts:481/507`, `cost.ts:97`) receive only `issueNumber` + cost — **no deployment identity**. `deploymentId` lives on control-plane `RunState` (`types.ts:380`). So the deployment-cap accumulator + check live in the **control-plane at run admission / before dispatch** (where `RunState.deploymentId`, `deploymentRegistry`, and the run's cost are all in scope — the same block the P4.1 hooks use). Accumulate per-deployment spend by tagging each run's cost with its `deploymentId` (the control-plane owns the `issueNumber→deploymentId` map via `RunState`); before admitting/continuing a run whose deployment's accumulated spend + the run's `perRunBudget` reservation would exceed `registry.readDeclaredData(deploymentId,'budget')`, **hard-abort + raise a fail-closed escalation**. `budget` is a **required** profile field (`schema.ts:138`, `types.ts:113`) — always present, always enforced; there is no "unset" branch. Floors stay fail-closed.

---

## Task 1 (4.1a) — Escalation-metric event log + aggregation (daemon)

**Files:** new `packages/daemon/src/control-plane/escalation-metrics.ts` (compute + auto-merge append, mirror `coordination/tech-lead/metrics.ts` deps-injected shape); the single auto-merge write-hook at the merge branch (`phases.ts:2166`, post-`integrateToStaging`, `kind==='auto-merge'` only); `daemon.ts` wiring. Raised/answered are READ from the decision-index (no write-hook).

1. **Numerator sourcing is split, and NOT symmetric (codex-corrected):** raised/answered come from the **decision-index DB read model (mandatory, authoritative)** — because finding-dismissal ALSO raises AND answers ledger decisions (`finding-dismissal/emit.ts`, `apply-consumer.ts`), so fire-and-forget append hooks would miss surfaces and drop authoritative counts. Only **auto-merges** come from a new append log (auto-merges never touch the decision-index). So the new event log is a single `kind:'auto-merge'` counter, not a 3-kind log.
2. Auto-merge append hook: at the merge branch (`phases.ts:2166`) append **only after a successful `integrateToStaging`** AND **only when `decision.kind === 'auto-merge'`** — the branch also merges operator-approved overrides, which must NOT count as auto-merges (codex-corrected). Event: `{ ts, deploymentId, issueNumber }`, via `writeJsonSafe`/`readJsonSafe` under `state/metrics/auto-merges.json` (retention 90d, tech-lead-metrics filter). Fire-and-forget + warn (never fail the phase — P3 alert discipline).
3. `computeEscalationTrend({ raisedEvents, answeredEvents, autoMergeEvents }, { weeks })`: per-week, per-deployment `{ weekStart, deploymentId, raised, answered, autoMerges, operatorTouchesPerDelivered }` where operatorTouchesPerDelivered = answered / (answered + autoMerges), **guarded for divide-by-zero** (0 delivered ⇒ null/undefined, rendered as "n/a", never NaN).
4. Read-model method is **event-count oriented, not status-oriented** (codex-corrected — `ItemStatus` has no auto-resolved/answered final state; answered is a `decisionResponses.answered_at` row timestamp): add `countCreatedSince(deploymentId?, since)` (by `decisions.created_at`) and `countAnsweredSince(deploymentId?, since)` (by `decisionResponses.answered_at`) — bucketed separately, NOT a single `countByStatusSince`.

**Commit:** `feat(control-plane): escalation-metric event log + weekly per-deployment trend aggregation (P4.1)`

## Task 2 (4.1b) — `GET /metrics/escalation` endpoint

**Files:** `daemon.ts` (handler sibling to `answerDecision`/`widenAutonomy`), `server.ts` (dispatch case near `/decisions/pending`).

1. Handler: reads decision-index counts (`countCreatedSince`/`countAnsweredSince`, Task 1 step 4) + the auto-merge log, calls `computeEscalationTrend`, returns `{ weeks: [...], deployments: [...] }`. Deployment filter via query param (optional; default all).
2. Route: `GET /metrics/escalation` in `server.ts` dispatch — GET, no CSRF needed (reads), same shape as `/decisions/pending`. If the decision-index is unavailable (no PG / not enabled), degrade to auto-merge-log-only with an `unavailable` flag (mirror the dashboard's degrade-on-error pattern) — never 500.
3. Decision-index count methods: add `countCreatedSince(deploymentId?, since)` and `countAnsweredSince(deploymentId?, since)` to the read model (`packages/decision-index/src/read-model.ts`) — created by `decisions.created_at`, answered by `decisionResponses.answered_at`, bucketed separately. REAL_PG test (outside the gate).

**Commit:** `feat(control-plane): GET /metrics/escalation daemon endpoint (P4.1)`

## Task 3 (4.1c) — Dashboard escalation-trend chart

**Files:** new `packages/dashboard/app/(dashboard)/metrics/page.tsx` (or a panel on an existing page — check if a metrics/insights route is more consistent), new `components/metrics/escalation-trend-chart.tsx` (recharts LineChart, mirror `cost-chart.tsx`), a proxy route `app/api/metrics/escalation/route.ts` (mirror `app/api/decisions/pending/route.ts` — `daemonFetch('/metrics/escalation')`, degrade on error).
Follow the `dataviz` skill for the chart (light bg, teal/burnt-orange accents, accessible). Render escalations/week and operator-touches-per-delivered-change/week as the two series; empty/degraded state handled.

**Commit:** `feat(dashboard): escalation-rate trend chart on /metrics (P4.1)`

## Task 4 (4.4) — Deployment-level budget abort

**Files:** new per-deployment spend accumulator (sibling `state/metrics/deployment-spend.json`); a **shared guard + append helper** called from EVERY `runPipeline` entry + completion seam in `daemon.ts` (codex-corrected — resumed runs must not bypass the cap); escalation raise via the existing fail-closed ledger path.

1. **Guard at ALL runPipeline entry paths, not just fresh admission (codex-corrected):** `runPipeline` is entered from fresh dispatch (`daemon.ts:3689`), crash-resume (`:2323`/`:2398`/`:3164`), and parked-resume (`:3216`) — all set `run.deploymentId`. Factor a single `checkDeploymentBudget(run)` guard and call it before `runPipeline` at **every** one of these sites (a resumed run bypassing the cap is the exact hole). Guard: if the deployment's accumulated spend + the run's `perRunBudget` would exceed `registry.readDeclaredData(deploymentId,'budget')` → **hard-abort** (do not enter `runPipeline`) + raise a fail-closed escalation. No silent proceed.
2. **Append spend at ALL completion seams (codex-corrected):** final cost is written in separate completion paths — fresh (`daemon.ts:3704`), crash-resume (`:2414`), parked-resume (`:3231`). Append `{ ts, deploymentId, cost }` to `deployment-spend.json` at each (a shared `recordDeploymentSpend(run)` helper), so production spend is never stale relative to the guard. Rolling-daily window (documented), matching `dailyBudget` semantics.
3. `budget` is a **required** profile field (`schema.ts:138`, `types.ts:113`) — always present, always enforced. No unset branch. (A deployment wanting a high ceiling sets a high budget.)
4. The `issueNumber→deploymentId` map is available at every seam because each carries the `RunState` (which holds `deploymentId`, `types.ts:380`) — the helpers take `run`, not a bare issue number.

**Commit:** `feat(session-runtime): deployment-level budget hard-abort + escalation at the spend cap (P4.4)`

## Task 5 — traceability + suites

`.specify/traceability.yml`: new files → the correct owning nodes (codex-corrected — do NOT bury budget enforcement under one node): daemon metric code (escalation-metrics.ts, endpoint) → **STACK-AC-CONTROL-PLANE**; the decision-index count methods → the decision-index node; the dashboard chart/page/proxy → **STACK-AC-OPERATOR-SURFACE-CLIENT** (or the dashboard node); the deployment-spend accumulator + registry read → **STACK-AC-DEPLOYMENT-REGISTRY**; any runtime/cost seam touched → **STACK-AC-OPERATIONAL-SAFETY** (`traceability.yml:937`, which governs runtime/cost) — the 4.4 control-plane guard spans control-plane + deployment-registry, list it under both if it reads registry data. New tests → test_paths. `traceability-paths` test + `check-traceability-paths.mjs` green. Baselines before/after: daemon + dashboard suites no new failures; typecheck + lint green.

## Acceptance-gate contract (GATE-AUTHOR; tests FAIL at HEAD)

- **G1 (Task 1):** `computeEscalationTrend` over a fixture event set returns correct per-week/per-deployment raised/answered/autoMerge counts and a divide-by-zero-safe operatorTouchesPerDelivered. (FAILS: module absent.)
- **G2 (Task 2):** `GET /metrics/escalation` via `createControlServer` + injected handlers returns the trend shape; degrades (no 500) when the decision-index count source throws. (FAILS: route absent.)
- **G3 (Task 3):** the dashboard `/metrics` page renders the trend chart component from seeded proxy data (RTL, mirror a cost-page test if one exists); proxy route forwards to `/metrics/escalation`. (FAILS: page/route absent.)
- **G4 (Task 4):** TWO assertions (codex-corrected — cover guard AND recording): (a) `checkDeploymentBudget(run)` returns hard-abort + raises an escalation when accumulated spend + `perRunBudget` exceeds `budget`, and returns proceed when under — exercised directly with an injected accumulator + registry; (b) `recordDeploymentSpend(run)` appends the run's cost tagged by `deploymentId` to the accumulator, and a subsequent `checkDeploymentBudget` reads the increased total (proving the accumulate→enforce loop closes, not just the read). A comment/assertion notes the guard must be wired at all `runPipeline` entry sites (fresh + crash-resume + parked-resume) — the diff-guard/review confirms the wiring; the unit gate proves the helper behavior. (FAILS: neither helper exists.)

No real Postgres in the gate (G2 uses an injected count source; G4 uses an injected accumulator+registry; the REAL_PG read-model methods get their own REAL_PG test outside the gate). 30s timeout floor.

## Verify command

```
pnpm --filter @runforge/daemon test <G1,G2,G4 paths> && pnpm --filter @runforge/dashboard test <G3 path> && pnpm --filter @runforge/daemon typecheck && pnpm --filter @runforge/dashboard typecheck
```

## Definition of done
Gate green; both suites no new failures; typecheck/lint/traceability green; PR against `plan/p4-earning-half`.

**NOT in this PR (P4 program-plan done-evidence, needs a live run):** the execution-log showing the escalation trend declining across recorded runs on deployment #0. That requires deployment #0 live (P2) with recorded runs — logged when P2 lands. This PR delivers + unit/integration-proves the metric mechanism and the budget floor; the live trend is the Phase-2-dependent proof.

## Follow-ups (documented)
- 4.2 earn-in wiring + debut-witness gate (bundle with Phase 5 — the debut gate makes live auto-widening Phase-5-gated; see the Operator FYI).
- 4.3 rung-3 act-side (D5).
- Escalation metric on the acme deployment (P7+).
