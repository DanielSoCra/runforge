# P3 (partial) — Operator Surface to Production Grade: Task-Level Plan (3.1/3.2/3.3/3.6)

> Expansion of program-plan Phase 3 (`docs/superpowers/plans/2026-07-02-first-production-deployment-full-l0.md`), **approved-L1-governed subset only**: FUNC-AC-DASHBOARD v4 + FUNC-AC-OPERATOR-SURFACE v1 (both `approved`) govern all four tasks. **Excluded pending D1 batch 1 (FUNC-AC-OPERATOR-AUTH is draft):** 3.4 remote-access topology, 3.5 daemon-API shared-secret hardening. Branch: `plan/p3-operator-surface` (off main at a0aad17, includes Phase 0); build branch: `codex/p3-operator-surface-build`.
>
> **Line anchors verified 2026-07-02 at origin/main a0aad17 — grep for symbols, never trust line numbers.**

## Ground truth (independently verified 2026-07-02)

- `/steering` (`packages/dashboard/app/(dashboard)/steering/page.tsx`, server component, `force-dynamic`) mounts NO refresher; `/briefing` mounts `<BriefingRealtime />` (`components/briefing/briefing-realtime.tsx:18-30` — client component, `setInterval(() => router.refresh(), interval)`, `NEXT_PUBLIC_REFRESH_INTERVAL_MS` override, default 30s), at `briefing/page.tsx:50`.
- **Answer-flow race (binding constraint):** `decision-answer.tsx:250-257` documents why answering deliberately does NOT `router.refresh()` — an immediate refetch races the resume loop and resurrects the still-pending row. A periodic poll is safe; an answer-triggered refresh is NOT. Do not add one.
- E2E today: `e2e/operator-surface.spec.ts` runs against a hand-rolled `mock-daemon.mjs` via `playwright.config.ts` (two webServers: mock on 9899, `next dev -p 3123` with `LOCAL_AUTH_BYPASS=true`). **The e2e script is NOT wired into CI** (root `pnpm -r test` only runs scripts named `test`; ci.yml has no playwright reference) — it never runs automatically.
- Real-daemon seam, Postgres-free: `createControlServer(port, handlers, host)` (`packages/daemon/src/control-plane/server.ts`) is ledger-decoupled — `GET /decisions/pending` calls `handlers.listPendingDecisions(query)`. `server.test.ts` boots it ~10× with fake handlers on port 0. `FakeDecisionLedger` (`decision-escalation/__fixtures__/fake-decision-ledger.ts`) implements the full raise/notify/answer lifecycle. (A PGlite-backed real IndexWriter was explicitly ruled out — single-writer guarantees can't be modeled in-process; the fake is the sanctioned fixture.)
- Alerts: `notify.ts` = SSRF-hardened HTTPS-only webhook `notify(webhookUrls, payload)` (private-IP + DNS-rebinding defense, one retry); `config.webhooks` exists (`config.ts` ~256, default `[]`). `notifyOperator()` (`daemon.ts` ~1304) is the single operator-alert entry; its 4 callers are all daemon-health events (tick errors, budget, stuck, watchdog). **Nothing fires on decision-raise.** The decision seams: merge-park `ledger.raise(sanitized)` → github-block publish → `ledger.notify(decision_id)` (`phases.ts` ~2262-2273) and finding-dismissal `emit.ts:154`.
- Halt/pause: daemon has `POST /pause` and `POST /halt` (Phase 0) — `/halt` additionally requires `Authorization: Bearer $RUNFORGE_CONTROL_TOKEN` when that env is set on the daemon. Dashboard `app/api/daemon/` has a `pause/route.ts` following the standard proxy template (`requireDashboardAdmin()` → `daemonFetch()` → verbatim status/body; `DaemonConfigError`→500, reject→503, non-JSON→502) — **no halt route; `daemonFetch` never sends Authorization**.
- Governing L2/L3 (all draft, repo norm): `STACK-AC-OPERATOR-SURFACE-CLIENT` owns steering page + decision components + proxy routes + playwright config/mock; `STACK-AC-DASHBOARD-BRIEFING` owns `briefing-realtime.tsx`; `STACK-AC-CONTROL-PLANE` covers server.ts/notify.ts/daemon.ts.
- Commands: `pnpm --filter @runforge/dashboard test|lint|typecheck|e2e`; daemon equivalents. Root `pnpm -r test` does NOT run e2e.
- Stale-comment debt (cleanup task): `decision-inbox.tsx` and `app/api/decisions/pending/route.ts` carry leftover "STUB: not implemented" headers contradicting their real implementations.

## Task 1 (3.1) — Live steering inbox

**Files:** `packages/dashboard/app/(dashboard)/steering/page.tsx`; new `components/steering/steering-realtime.tsx` OR reuse `BriefingRealtime`.

1. Reuse WITHOUT moving (codex-corrected): `BriefingRealtime` has zero briefing-specific logic (it just `router.refresh()`es). Import it directly into `steering/page.tsx` and mount it beside the existing children — do NOT move/rename the file (a move breaks `STACK-AC-DASHBOARD-BRIEFING`'s `components/briefing/` dir ownership and adds churn for nothing). Traceability: `steering/page.tsx` is already in `STACK-AC-OPERATOR-SURFACE-CLIENT` code_paths; no changes needed.
2. **Do NOT add any answer-triggered refresh** (race at `decision-answer.tsx:250-257`). Periodic `router.refresh()` is **verified safe** (codex-confirmed vs Next.js docs: refresh merges the new RSC payload without discarding unaffected client `useState`; the row key is `decision_id` and `DecisionAnswer` owns its `answered` state) — the row disappears on whichever poll first sees the ledger advanced.
3. Respect `NEXT_PUBLIC_REFRESH_INTERVAL_MS` like briefing does.
4. Add (non-gate) invariant test: `decision-answer.tsx` contains no `router.refresh` / `useRouter` import — a static guard codifying the race comment (this arm already holds at HEAD, so it lives OUTSIDE the failing gate; see G1).

**Commit:** `feat(dashboard): live steering inbox — periodic refresh on /steering (P3.1)`

## Task 2 (3.2) — Real-daemon E2E, wired into CI

**Files:** new `packages/dashboard/e2e/real-daemon.mjs` (boot script), `playwright.config.ts`, `e2e/operator-surface.spec.ts` (or a new spec file), `.github/workflows/ci.yml`.

1. Build a **real** control-plane boot script — with the CORRECT seams (codex-verified; the naive "delegate to FakeDecisionLedger" does NOT work): `FakeDecisionLedger.reader.listRanked/detail` deliberately **throw "not implemented"** (`fake-decision-ledger.ts:158`), and the real answer path (`decision-api.ts:481-511`) validates via `readModel.detail()` then calls `publisher.publish()` — it never records `ledger.answer`. Therefore the boot script must: (a) implement a small **seeded in-memory read model** (the `listRanked`/`detail` surface `decision-api` consumes), seeded with ≥2 decisions incl. one answerable; (b) wire the REAL decision-api handler factory (grep how `daemon.ts` builds `listPendingDecisions`/`getDecisionDetail`/`answerDecision` from read model + publisher) with an in-memory publisher that, on publish, marks the decision answered in the read model (simulating the resume loop's later advance — optionally after a short delay to preserve the "row leaves on next fetch" semantics); (c) hand those handlers to `createControlServer(port, handlers)`. This runs the REAL HTTP layer + REAL decision-api validation — the honest claim; state it as such in the spec file header (in-memory read model replaces Postgres by design; a PGlite-backed real IndexWriter was explicitly ruled out).
2. The answer-flow test asserts through the REAL `POST /decisions/:id/answer` handler: answer → 200 → follow-up `GET /decisions/pending` shows the row gone once the in-memory publisher has advanced it (mirror the "row leaves on the next fetch" L3 rule). Keep `mock-daemon.mjs` ONLY if a degraded/unreachable-daemon spec needs it; otherwise delete it and update `STACK-AC-OPERATOR-SURFACE-CLIENT` code_paths.
3. **Wire into CI (explicitly, not "just add a step"):** add to the existing single self-hosted job (no new runner class — RC-1 guard history): a browser-provisioning step `pnpm --filter @runforge/dashboard exec playwright install chromium` (idempotent; caches under ~/Library/Caches/ms-playwright on the mac runner) and the e2e step `pnpm --filter @runforge/dashboard e2e -- --project=desktop` (chromium/desktop only in CI; mobile project stays local). **Raise the job's `timeout-minutes`** (currently 15) to accommodate e2e — measure locally and set 15 + measured e2e ceiling (~+10). `check-ci-workflows.mjs` does not object (it only rejects Actions container features). CI must fail on e2e red.
4. Config note: `playwright.config.ts` boots `next dev` + the daemon script as webServers — the boot script replaces the `mock-daemon.mjs` webServer entry; ensure `reuseExistingServer` stays CI-safe.

**Commit:** `feat(dashboard): real-daemon E2E — steering specs run against createControlServer + seeded ledger, wired into CI (P3.2)`

## Task 3 (3.3) — Out-of-band alert on decision-raise

**Files:** `packages/daemon/src/control-plane/phases.ts` — **BOTH its notify seams** (codex-verified: the merge-park seam ~2262-2273 AND the L2-gate seam ~879-888; grep ALL `ledger.notify(` call sites in phases.ts and cover every one), `packages/daemon/src/control-plane/finding-dismissal/emit.ts` (~154), `daemon.ts` (`notifyOperator`), tests beside existing notify tests. The alert wiring must be seam-complete: any `ledger.notify` whose transition applies ⇒ one alert — prefer a single small helper (`alertOnNotifyApplied(ledger, notifyOperator, ...)`) used at all three call sites over three hand-rolled copies.

1. **Alert iff the notify transition APPLIED (codex-corrected idempotency):** `ledger.notify()` can no-op when the decision is already past `raised` (fake-ledger `:222` models this; finding-dismissal `emit.ts:351-361` calls it unconditionally and ignores `applied`). Fire the alert ONLY when the notify result reports `applied: true` — that is the exactly-once seam; retries of the surrounding flow then cannot duplicate the alert. Check the real notify return shape (grep the decision-index writer's notify) and thread accordingly.
2. **Payload must fit `NotificationPayload` (codex-verified: `notify.ts:5` requires `{event, issueNumber, message}` + optional `phase`):** extend the schema with a new event value `'decision-raised'` and optional `decisionId`/`url` fields (update its type + any payload tests), OR compose within the existing shape (`issueNumber` from the decision's issue, `message` = sanitized title + deep link). Prefer the minimal schema extension — spec it explicitly; the plan's earlier freeform payload does not typecheck.
3. Payload hygiene: decision id + sanitized title + optional deep link (`dashboardBaseUrl` config, omit link when unset) — no decision body/sensitive regulated content (withholding sanitizer is P7 scope).
4. Failure isolation: alert failure must never fail the raise path (fire-and-forget with the existing notify retry; log a warning). `notifyOperator` already warns-when-unconfigured — decision-raised joins the same warning surface (`daemon.ts` ~465-467 list may need updating).
5. Thread `notifyOperator` (or a narrow callback) into all three seams the way phases.ts already receives daemon-scoped callbacks (no globals).

**Commit:** `feat(daemon): out-of-band operator alert on decision-raise via existing webhook channel (P3.3)`

## Task 4 (3.6) — Halt/pause controls on /steering

**Files:** new `packages/dashboard/app/api/daemon/halt/route.ts`; `components/steering/` new `daemon-controls.tsx`; `steering/page.tsx`; `app/api/daemon/daemon-routes.test.ts` (table-driven fixture, pause at ~line 53).

1. **Proxy route:** clone the `pause/route.ts` template (`requireDashboardAdmin()` → forward → verbatim status/body) BUT with the Bearer design point resolved explicitly: read `RUNFORGE_CONTROL_TOKEN` from the **dashboard's** env; when set, pass `Authorization: Bearer <token>` via `daemonFetch`'s EXISTING `RequestInit` headers support (codex-verified `daemon-fetch.ts:8` — headers merge after `X-Requested-By`; do NOT add a new param or fork it). When unset, send none (matches the daemon's halting-is-the-safe-direction posture). Document in the route header. Add the distinct Bearer-forwarding case to `daemon-routes.test.ts`.
2. **UI:** a small `DaemonControls` client component on `/steering`: Pause / Halt buttons, **confirm-gated** (two-step confirm for Halt with explicit copy: "kills in-flight workers; parked runs resume via Resume"), admin-role-gated exactly like answer/reveal (the API route enforces `requireDashboardAdmin`; the component renders only for admins the same way answer controls do — mirror the existing role-conditional pattern). Show the halt response summary (`parked/terminated/escalated`) inline after success. Include Resume (proxy exists: `app/api/daemon/resume/route.ts`).
3. E2E: extend the Task-2 real-daemon spec: admin clicks Halt (confirm), server receives `POST /halt` (assert via the boot script's handler recording), UI shows the response summary.

**Commit:** `feat(dashboard): confirm-gated halt/pause/resume controls on /steering with Bearer-forwarding halt proxy (P3.6)`

## Task 5 (cleanup) — stale STUB comments

Remove/correct the leftover "STUB: not implemented" headers in `decision-inbox.tsx` and `app/api/decisions/pending/route.ts` (both fully implemented). One commit: `docs(dashboard): drop stale STUB headers on implemented decision components`.

## Task 6 — Traceability + suites

1. `traceability.yml`: new files → owning nodes' `code_paths` (`STACK-AC-OPERATOR-SURFACE-CLIENT` for steering/e2e work, `STACK-AC-CONTROL-PLANE` for the daemon alert seam); new tests → `test_paths`; if `BriefingRealtime` moves, keep paths truthful. Run the traceability-paths test + `node scripts/check-traceability-paths.mjs`.
2. Baselines BEFORE changes: `pnpm --filter @runforge/dashboard test` and `pnpm --filter @runforge/daemon test` tails recorded; after: no new failures; both packages' lint + typecheck green; `pnpm --filter @runforge/dashboard e2e` green locally.
3. Dependency order: Task 2's boot script before Task 4's e2e case; Tasks 1/3/5 independent.

## Acceptance-gate behavioral contract (GATE-AUTHOR; tests must FAIL at current HEAD)

- **G1 (3.1):** `/steering` page mounts a periodic-refresh client component (assert component presence in the page render — e.g. RTL render of the page's client tree or a lightweight unit on the page module's JSX). (FAILS at HEAD: nothing mounted.) The no-answer-triggered-refresh invariant is **NOT part of the gate** — it already holds at HEAD (codex-verified: `decision-answer.tsx` has no router import) and a behavioral spy would be brittle once periodic refresh exists; the implementer adds it as a separate static-guard test (Task 1 step 4).
- **G2 (3.2):** an integration test boots the REAL `createControlServer` wired through the REAL decision-api handlers over a seeded in-memory read model, and `GET /decisions/pending` serves the seeded decisions; the answer flow round-trips (answer → row leaves on a later fetch). (FAILS at HEAD: no boot script/read-model exists.) AND `ci.yml` contains a step running the dashboard e2e script (workflow-lint-style test reading ci.yml, `check-ci-workflows.mjs` style — FAILS at HEAD: no such step).
- **G3 (3.3):** with `config.webhooks` set, a decision-notify transition that reports `applied: true` produces exactly one webhook payload (schema-valid `NotificationPayload` with the `decision-raised` event) through ALL THREE seams — merge-park (`phases.ts` ~2262), **L2-gate (`phases.ts` ~879)**, and finding-dismissal (`emit.ts` ~154); an already-notified decision (notify no-op, `applied: false`) produces NO alert; webhook failure does not fail the raise.
- **G4 (3.6):** `POST /api/daemon/halt` route exists, admin-gated (non-admin → 403 per `requireDashboardAdmin` mapping), forwards to daemon `/halt`, and injects `Authorization: Bearer` iff the dashboard env token is set (both arms); UI-level: steering page renders confirm-gated halt control for admin role (component test).
- **G5 (5):** the two files no longer contain the string `STUB: not implemented`.

Gate placement: dashboard gates under `packages/dashboard` (vitest/RTL or playwright per repo conventions — mirror existing test styles), daemon gate (G3) under `packages/daemon`; no real Postgres anywhere; 30s timeout floor in daemon package.

## Verify command (work-order)

```
pnpm --filter @runforge/dashboard test <dashboard gate paths> && pnpm --filter @runforge/daemon test <daemon gate path> && pnpm --filter @runforge/dashboard typecheck && pnpm --filter @runforge/daemon typecheck
```

(E2E gate runs via `pnpm --filter @runforge/dashboard e2e` — implementer runs it locally as DoD; CI enforces it post-Task-2.)

## Definition of done (PR)

Gate green; both packages: full test suites no new failures vs baseline, lint + typecheck green; e2e green locally; traceability green; PR against `plan/p3-operator-surface`.

**NOT in this PR (program-plan P3 done-evidence, needs live target):** the P3 execution-log drill — the Operator receives a webhook push for a parked decision, opens `/steering` over Tailscale, sees it appear without reload, answers it, run resumes (requires 3.4's topology decision D6 + a live daemon window). This PR's e2e + the Phase-0 drill harness cover the mechanical arms; the human-in-the-loop drill is logged when P3.4/D6 land.

## Follow-ups (documented, not in scope)

- 3.4/3.5 (Tailscale topology D6, shared-secret on all POSTs, `LOCAL_AUTH_BYPASS` boot assertion) — blocked on FUNC-AC-OPERATOR-AUTH ratification (D1 batch 1).
- Mobile playwright project in CI (kept local-only if runtime demands).
- `notifyOperator` payload i18n/formatting for ntfy/Pushover niceties — plain JSON is the floor.
