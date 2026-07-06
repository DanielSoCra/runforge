# Operator-Triggered Retry of a Stuck Work Request — Design Spec

**Date:** 2026-06-26 · **Topic:** `operator-retry` · **Base:** `origin/main` @ `7e2e1c5`
**Status:** draft (codex review pending)

## Goal
Implement the **Operator-triggered** `POST /retry/:issue` handler (currently a stub) so the Operator can recover a **`stuck`** work request from scratch without manual GitHub label surgery. FUNC-AC-PIPELINE already mandates the behavior and the HTTP route is already wired; this is an **implementation slice realizing an existing L1 scenario** (not merely wiring — it requires correct work-type label restoration + decision-state cleanup; see L1 basis).

### Scope — v1 (this slice)
Recover an item that is **`stuck`** and **not `blocked`** (i.e. not yet auto-capped, not manually blocked). This is the common case and is fully implementable today: removing `stuck` + clearing the in-memory backoff + restoring the correct entry label re-admits it, and the per-issue stuck-run **count naturally bounds repeated retries** (after `maxRunsPerIssue` stuck runs the item becomes `blocked` — see deferred).

### Explicitly NOT in scope
- **Autonomous / timer-driven re-admission** — net-new L1, *forbidden* by FUNC-AC-RECOVERABLE-FAILURE-ROUTING §"Non-configurable fail-safe" (no relabeling a human-required `stuck` as retryable). Deferred to an Operator L1 decision.
- **Un-blocking a capped/`blocked` item (budget reset)** — `RunHistoryReader` has no count-reset API (`countStuckRunsForIssue` only), so resetting the budget needs a **new persisted "operator-retry epoch" + a count-after-epoch query (a DB migration)**. Deferred as the immediate follow-up. v1 **rejects** a `blocked` item with a clear message rather than re-admitting it into an immediate re-block.

## L1 basis (HARDENING — implementation of an existing L1 scenario)
- **FUNC-AC-PIPELINE** `Scenario: Operator retries a stuck request` — "Given a work request was halted after repeated failure / When the Operator triggers a retry / Then the system **resets the request and processes it from scratch**."
- **FUNC-AC-PIPELINE** `Scenario: Re-entry from stuck` — "When the Operator makes it available again / Then the system processes it from scratch as a new work request."
- This realizes those scenarios but extends the L3 contract (the from-scratch reset semantics: label restoration + decision/run-state cleanup) — it is hardening of ratified L1, not a new requirement, but it is a real implementation slice, not a one-line stub fill.
- Governing specs: **STACK-AC-CONTROL-PLANE** (the handler/route) → ARCH-AC-CONTROL-PLANE → FUNC-AC-PIPELINE; **STACK-AC-RECOVERABLE-FAILURE-ROUTING** (stuck semantics) → FUNC-AC-RECOVERABLE-FAILURE-ROUTING.

## Current state (file:line, verified @ 7e2e1c5)
- **Stub:** `daemon.ts:1916` — `retry: (_issueNumber) => err(new Error('retry not yet implemented'))`.
- **Route:** `server.ts:487-498` — `POST /retry/:issueNumber` (path param parsed to a number; 400 on NaN; CSRF-guarded by `x-requested-by` at `server.ts:63`). Calls `handlers.retry(issue)` **synchronously**, `json(res, result.ok ? 200 : 404, …)`.
- **markStuck** (`work-detection.ts:186-192`): removes `in-progress`, **adds `stuck`**, posts the error comment.
- **Entry label is consumed at CLAIM, not retained** (C2): `ready` removed at `work-detection.ts:164`, `ready-to-implement` at `:123`. So a `stuck` item has LOST its entry label — `/retry` must RESTORE the correct one by work type, not assume it's present.
- **Detect exclusions:** every detect tier excludes `stuck` (`work-detection.ts:57,82-85`).
- **Decision-block also blocks re-detection** (C3): fresh-work detection skips a decision-owned issue if a parked run exists OR the issue body still contains the cockpit decision block (`resume-consumer.ts:187`, used at `daemon.ts:1524`; block written by `github-block-notifier.ts:40`). So label reset alone is insufficient if a decision block lingers.
- **No DB count-reset API** (C1): `RunHistoryReader` exposes `countStuckRunsForIssue` + orphan cleanup only (`run-history.ts`, `stores.ts`, `postgres-stores.ts`) — no reset/supersede. v1 therefore does not touch the count (it rejects `blocked`/capped items).
- **Gating that must be cleared so a retried item isn't immediately re-skipped/re-blocked:**
  - in-memory `stuckBackoff` map (`daemon.ts:1327-1342`, checked at dispatch `:1553` `isBackedOff → skip`).
  - DB per-issue stuck-run cap (`daemon.ts:3367-3403`): `countStuckRunsForIssue >= config.maxRunsPerIssue` (default 3) → adds `blocked` + returns 'blocked'. A retried item that already hit the cap carries `blocked` and a count ≥ 3.
- **"From scratch":** the L1 says reset + process as a NEW request — so any parked/partial run state for the issue must not cause a resume; detection should create a fresh run.

## Design

### Handler return type (round-2 I2 — must carry the HTTP status)
A bare `Result<void>` cannot express 404 vs 409 vs 503, and the route currently hardcodes `result.ok ? 200 : 404` (`server.ts:493`). So: change `ControlHandlers.retry` (`server.ts:23`) to **async carrying a status**, mirroring `answerDecision`'s `HandlerResult` — e.g. `(issueNumber: number) => Promise<HandlerResult<{ retrying: number } | ErrorBody>>` (status ∈ 200/404/409/503). **Update the `/retry` route** (`server.ts:487-498`) to `await` it in `try/catch` and emit `result.status` + `result.body` (not the hardcoded 404); an unexpected throw → **500**. Route shape stays `POST /retry/:issue` (400 on NaN, CSRF via `x-requested-by`).

### Admission rule (C-I1, I1, C3 — ORDER MATTERS; round-2 I1)
Fetch the issue's current labels first, then check **in this order** (the auto-cap adds `blocked` *without* `stuck` at `daemon.ts:3384`, so `blocked` MUST be checked before "not stuck"):
1. has **`blocked`** (auto-capped OR manual) → **409** "issue N is blocked; un-blocking / budget-reset is not supported in v1 (see follow-up #1). Resolve manually or wait for the budget-reset feature." (Avoids re-admit→immediate-re-block AND avoids overriding a manual block — I1.)
2. has **`decision-request`** / is an **active `l2-gate` or `integrate` decision park** → **409** "issue N is awaiting an Operator decision, not stuck — answer the decision (`POST /decisions/<id>/answer`) instead of retrying." (C3.)
3. **not `stuck`** → **404** "issue N is not stuck; nothing to retry."
4. else (**`stuck`, not `blocked`, not decision-parked**) → proceed.

### From-scratch reset — DURABLE-FIRST ORDERING (I2)
Do the internal, recoverable cleanup BEFORE the externally-visible label change, so a mid-failure leaves the item visibly `stuck` (human-required), never half-reset:
1. **In-memory cleanup (first — NO GitHub mutations; round-3 I1):** clear the issue's entry from the in-memory `stuckBackoff` map and clear any parked/partial **in-memory** run state + the in-memory active/claim tracking (the `activeIssues`/run map) so detection starts a NEW run, not a resume. Do **NOT** call `releaseClaim` here — `releaseClaim` (`daemon.ts:3232`) REMOVES GitHub labels (incl. `l2-in-progress`, a real detection tier), which would violate "labels untouched on failure"; release only the **non-label** in-memory claim state. If any in-memory step fails → 503 `HandlerResult`, **no GitHub touched** (item still `stuck`). Identify the exact non-label run-reset helper at build.
2. **GitHub mutations — strand-safe order (round-2 I3 + round-3 I1; ALL label/body changes live HERE, after the in-memory step):**
   - (a) **ADD/ensure the restored ENTRY label FIRST** (so the item is detectable the instant `stuck` is gone). The entry label was consumed at claim (`work-detection.ts:123/164`) so it must be RESTORED by work type (codex-confirmed mapping vs the live tiers):
     - standard (was `ready`) → **`ready`** · bug → keep **`review-finding`** · feature-impl → **`ready-to-implement`** · l3-generate (`feature-pipeline,l2-approved`) → **`l2-approved`** · l2 tiers → **`l2-in-progress`** / **`l1-approved`**.
     - Infer work type from the remaining `feature-pipeline,*` labels and/or the last run's `workType` in run history; if **indeterminate → 409** with the reason (never re-admit to the wrong tier; touch no labels).
   - (b) **remove the leftover cockpit decision block from the issue BODY** (if present) — explicit body edit: read body, strip the exact `<!-- pm-cockpit:decision-request:v1 -->…<!-- /pm-cockpit:decision-request -->` region, `octokit.issues.update({ body })` (block written via `octokit.issues.update`, `github-block-notifier.ts:40,254`); **fail closed on ambiguous/partial markers**. Else detection still skips the issue (`resume-consumer.ts:187`, `daemon.ts:1524`). (No-op if absent.) Ordered after (a) so a body-edit failure leaves `stuck`+entry intact.
   - (c) **remove the stale active/claim labels** (`in-progress`, `implementing`, `l3-in-progress`, the claim tier label if distinct from the restored entry label, …) as appropriate for the restored tier.
   - (d) **remove `stuck` LAST.** Any failure before (d) leaves the item `stuck`+entry-label (still excluded → safe, retryable again); only after (d) is it re-admitted. No failure position strands it label-less.
3. **Audit (best-effort, after re-admission):** post an operator-readable comment ("Operator-triggered retry: reset and re-queued from scratch as `<workType>`") + structured log. A comment failure here is best-effort — it must NOT fail the (already-completed) retry.
4. Return 200 `{ retrying: issue }`. A second retry after re-admission → 404 (no longer `stuck`).

### What is deliberately NOT changed
- Detect exclusions, `markStuck`, the fail-safe failure routing — untouched. No autonomous re-admission, no count-reset, no conflict auto-rebase. `stuck` still means human-required; this gives the human a correct, single-call trigger.

## File topology
- `daemon.ts` (implement async `retry` returning `Promise<HandlerResult<{retrying:number}|ErrorBody>>`: admission rule; in-memory cleanup; ordered GitHub mutations; best-effort audit comment).
- `server.ts` (change the `retry` type to `(n)=>Promise<HandlerResult<...>>`, `await` it in the route inside try/catch and emit `result.status`/`result.body` — NOT hardcoded 404 — throw→500; route shape unchanged).
- A work-type→entry-label helper (likely in `work-detection.ts`, alongside the tier definitions) so restoration stays consistent with detection.
- New test `operator-retry.test.ts`; L3: extend **STACK-AC-CONTROL-PLANE** (`.specify/stack/control-plane-ts.md`) with the retry-handler contract (admission rule + from-scratch reset + ordering); add the new test to `.specify/traceability.yml`.

## Test strategy
Focused `operator-retry.test.ts` (+ `server.test.ts`), injected octokit + state mgr (no real GitHub/Postgres). The matrix:
- **admission order:** `blocked` WITHOUT `stuck` (auto-capped) → **409** (not 404 — round-2 I1); `blocked`+`stuck` → 409; manual `blocked` → 409; not-`stuck`-not-`blocked` → 404; decision-parked (`decision-request` / active l2-gate/integrate park) → 409 "answer the decision".
- **tier restore (round-2 minor 1):** `stuck` standard → **`ready`** restored; feature-impl → **`ready-to-implement`**; l3-generate (`feature-pipeline,l2-approved`) → **`l2-approved`**; l2-in-progress → **`l2-in-progress`**; l1-approved → **`l1-approved`**; bug → keep **`review-finding`**; indeterminate work type → **409** (no wrong-tier re-admit). Each asserts the entry label present + `stuck`/active labels gone + re-detected at the correct tier.
- `stuck` with a lingering decision body-block → body edited to strip the marker region (C3); ambiguous markers → fail-closed (no truncation).
- a parked/partial run for the issue → cleared + claim released → detection starts FRESH (assert no resume path taken).
- **commit ordering (round-2 I3):** entry label added BEFORE `stuck` removed — simulate a GitHub failure between them → item still `stuck`+entry (excluded, safe), never neither-label stranded; an internal-cleanup failure → labels UNTOUCHED, 503.
- audit-comment failure after re-admission → retry still succeeds (best-effort).
- octokit removeLabel 404 for an absent label → tolerated.
- double retry → second call 404.
- `server.test.ts`: `POST /retry/:issue` emits the handler's **status** (200/404/409/503, not hardcoded 404), 400 NaN, 403 without `x-requested-by`; async/await + thrown-error → 500.
- Run: `pnpm --filter @runforge/daemon exec vitest run src/control-plane/operator-retry.test.ts src/control-plane/daemon.test.ts src/control-plane/server.test.ts src/control-plane/work-detection.test.ts src/infra/traceability-paths.test.ts` + lint + typecheck.

## E2E (Phase 9, on the demo)
Induce a stuck item, then operator-retry it: seed a feature that goes stuck (e.g. a change that fails review past its retry budget, or reuse a conflict path), confirm it carries `stuck` and is NOT re-picked; `curl -X POST /retry/:issue -H "x-requested-by: op"` → 200; confirm `stuck` removed + the item re-detected and re-run from scratch. (If inducing a natural stuck is hard live, at minimum manually label an issue `stuck` and prove `/retry` clears it + re-admits.)

## Risks
- **Wrong reset label / item not re-detected** (the main risk): the entry label was consumed at claim, so the handler must RESTORE the right one by work type. Mitigated by inferring work type from remaining `feature-pipeline,*` labels + run-history `workType`, erroring (409) on indeterminate type rather than guessing, and tests asserting re-detection at the correct tier.
- **Half-reset on partial failure:** mitigated by durable-first ordering (internal cleanup before the label change; on failure leave `stuck` intact).
- **Resuming instead of from-scratch:** clear parked run state + remove the decision body block; test that no resume path runs.
- Small blast radius — one operator endpoint, no change to autonomous routing or the fail-safe.

## Follow-ups
1. **Un-block / budget-reset for a capped `blocked` item** (immediate next slice): add a persisted **operator-retry epoch** per issue + a `countStuckRunsForIssue`-after-epoch query (a DB migration), so `/retry` can give a capped item a fresh budget instead of rejecting it. v1 rejects `blocked` (409) until this lands. Still Operator-triggered, still in-bounds (realizes the same FUNC-AC-PIPELINE scenario for capped items).
2. **Surface to Operator — net-new L1:** **Autonomous stuck-recovery** (timer/sweep auto-retry) needs an L1 decision — it currently *contradicts* FUNC-AC-RECOVERABLE-FAILURE-ROUTING's non-configurable fail-safe (no relabeling human-required as retryable) and the Operator-gated FUNC-AC-PIPELINE scenarios. A safe version needs a cause-aware, allow-listed, evidence-preserving policy authored into L1 first. Not built; not autonomously buildable.
3. **Failure visibility** (FUNC-AC-RECOVERABLE-FAILURE-ROUTING §"Failure visibility"): surface a stuck item's underlying `PipelineFailureKind`/error rather than only the opaque `stuck` label — pure surfacing; complements this slice.
