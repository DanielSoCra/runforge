# Operator-Learning on Finding-Dismissal (rung 2/3 "ask less") — Design Spec

**Date:** 2026-06-30 · **Topic:** `finding-dismissal-learning` · **Base:** `origin/main` @ `049e3f5`
**Status:** draft (codex spec-review pending) · Adjudicated with Codex GPT-5.5

## Goal
Give the human Operator a structured **dismiss/keep** decision for review findings, and let operator-learning learn from it — realizing FUNC-AC-OPERATOR-LEARNING rung 2 (pre-fill the recommendation, still ask) and rung 3 (propose to auto-dismiss a learned finding-category, Operator-approved). This is the first **non-guarded** operator-decision class, which unlocks "ask less."

**3-PR sequence (this spec covers the architecture; PR1 in full, PR2/PR3 sketched):**
- **PR1** — the issue-level finding-dismissal **decision flow** (emit → inbox → answer → apply verdict + observe → terminalize). Rung-1 only (the inbox already re-ranks once it learns the new class). Independently shippable + safe (still asks every time, no suppression).
- **PR2** — rung-2 **pre-fill**: the builder sets `recommended_option` from the learned preference (guarded categories never).
- **PR3** — rung-3 **propose + act**: `maybeProposeAskLess` → raise the proposal as its own decision → Operator approves → act-side stops emitting finding-dismissal decisions for the learned category (finding stays on the autonomous agent path).

## Architecture (Codex-adjudicated): a PARALLEL path, reusing the transport
Every existing escalation is **run-parked** (`buildL2GateRequest`/`buildMergeDecisionRequest` take a `RunState`; `resumeParkedRuns` applies an answer by *resuming the run*; `answerDecision`/`parseCockpitAnswer` are binary approve/reject). A finding is a GitHub **issue**, not a run. So finding-dismissal **reuses** the decision-index ledger + `/decisions/pending` inbox + the publish/answer transport, but adds its **own** emit + its **own** answer-apply consumer — **without touching `resumeParkedRuns`** (the run-binding lives in the consumer, not in `DecisionLedger.answer()`).

- **Decision class key:** `decisionClass = 'finding_dismissal:' + category`, `context = '${owner}/${repo}'`. Putting **category in the class** is required so the existing guard check (`guardedClasses.has(decisionClass)`, `preference-engine.ts:111`) can guard a category. (`category` ∈ the review categories: `correctness|consistency|security|performance|test-gaps`, `review-scheduler.ts:6`.)
- **Answer transport:** reuse binary — options `{id:'approve', label:'Keep the finding'}` / `{id:'reject', label:'Dismiss the finding'}`. Observe/learn/pre-fill all key on `approve`(keep)/`reject`(dismiss) consistently; zero transport change.

## PR1 — the finding-dismissal decision flow (this PR)

### Emit (a finding-bound DecisionRequest builder) — raise → publish → notify
New `control-plane/finding-dismissal/build-request.ts`: build a `DecisionRequest` for a finding **issue** — `phase = 'finding-dismissal'`, a **synthetic `run_id`** (not a real run; documented convention), `risk_class` from severity, `source_url` = the issue URL, `options` keep/reject as above. The carrier of both phase and category is the **`decision_id`** — codex CRITICAL-2/IMPORTANT-1: the ledger facade does NOT expose `phase`, and `deriveLearningKey` only receives `decision_id`+`source_url` (no labels). So use a **strict machine-readable id**: `finding-<issue>:finding-dismissal:<category>:<epoch>` (category ∈ the fixed review-category set). Every downstream parse (consumer filter, learning-key derivation) keys off this id shape.

**Emit MUST do the full raise → publish → notify** (codex IMPORTANT-2 — `/decisions/pending` defaults to `notified/viewed`; a `raise`-only row is `detected` and filtered out): `ledger.raise(sanitized)` → `GitHubBlockPublisher.ensure()` embeds the block in the issue body → `ledger.notify(decision_id)` (mirror the gate emit at `phases.ts:875`). Only then does the decision appear in the inbox.

### Emit trigger (which findings reach the human — bounded, configurable)
Emit a finding-dismissal decision for a `review-finding` issue **only when**: it has a **parsed `category`** label AND (category ∈ `config.operatorReviewCategories` (a new config allowlist) **OR** the issue carries the human-route `needs-discussion` label). **Never** emit for: all findings (inbox flood), an issue with no parsable category (do **not** train `uncategorized`), or a guarded-category issue beyond rung-1 (still emitted — the Operator still decides — just never pre-filled/asked-less, handled in PR2/3). Idempotent: never emit a second open decision for the same finding (deterministic id + ledger status check).
- **Default `operatorReviewCategories`:** an open question for the Operator (see Open Questions); default to a conservative small set or empty (configurable per deployment). The `needs-discussion` trigger is spec-faithful — its **label path IS live** in the PO flow (`finding-approval.ts:8` VERDICT_LABELS); only the shared discussion-queue write is still TODO (codex MINOR-1). The config allowlist is the reliable functional path + the natural "ask-less opt-in".
- **Category-label dependency (codex IMPORTANT-3):** the feature keys on a review `category` label. Review-finding issues created by the `verified-codebase-review` skill (`scripts/reviewer.sh:29`) carry `review-finding + priority + category`. The **daemon's** read-only `proactive-reviewer` path does NOT itself persist a category label — so the parser **requires exactly one** of the fixed categories on the issue and **emits nothing if absent** (already the "no category → no emit, never train `uncategorized`" rule). PR1 must (a) make the shared `labels.ts` parser strict about the fixed set, and (b) note that for the daemon-created path to feed learning, issue creation must persist exactly one category label — a small dependency, flagged. The E2E labels its test finding explicitly.

### Answer-apply consumer (a SIBLING scan loop — the load-bearing correctness)
New `control-plane/finding-dismissal/apply-consumer.ts`, wired beside `resumeParkedRuns` in `daemon.ts` (NOT inside it). **Codex CRITICAL-1:** the live `/answer` endpoint only POSTS a `**DecisionResponse**` comment — it does NOT call `ledger.answer()`; for runs, `ledger.answer()` is driven later *inside* `resumeParkedRuns`. A finding has no parked run, so **this consumer must drive `ledger.answer()` itself.** `resumeParkedRuns` iterates `findParkedRuns()` and only handles l2-gate/integrate, so it will never touch finding rows (confirm + assert) — but the consumer must select finding rows itself.

Each tick: scan `ledger.pending()` (returns **every non-terminal row** — do NOT add a `notified/viewed` filter; seeing an answered-but-not-terminalized row is exactly what makes crash-recovery work), **filter to finding-dismissal by the `decision_id` convention** (`:finding-dismissal:` segment — since `phase` isn't on the facade, codex CRITICAL-2). (Note: the operator-facing `/decisions/pending` inbox via `listPendingDecisions` defaults to `notified/viewed` — a different method; the consumer uses the broader `ledger.pending()`.) For each such row whose issue has an operator `**DecisionResponse**` comment (`parseCockpitAnswer`; keep=approve / dismiss=reject):
1. **Skip if terminal** (`statusOf === 'resumed'`) — idempotent re-entry.
2. `await ledger.answer(decisionId, rawChosenOption, 'operator')` (the consumer drives it).
3. **DURABLE-FIRST ORDERING, ALL AWAITED (codex BIGGEST RISK + IMPORTANT-4 — the existing run path fire-and-forgets `observeDecisionAnswer`; here it must be awaited so it's durable):** `await` apply-verdict to the issue (idempotent labels + audit comment — `reject`→`dismissed` verdict label / `approve`→`kept`), THEN `await operatorLearning.observeDecisionAnswer({decisionClass:'finding_dismissal:'+category, context, sourceDecisionId: decisionId, chosenOption})`, THEN `await ledger.advanceToResumed(decisionId)` (terminalize). Never terminalize before the verdict + observation are durably written.
4. **Idempotent replay:** a crash/retry before terminalization re-applies — labels already present = no-op; the observation carries `sourceDecisionId` so the preference engine **dedupes by `sourceDecisionId`** (`preference-engine.ts:37`) and a duplicate append does NOT inflate confidence (assert in tests). `ledger.answer` on an already-answered row is answer-once (no-op).
5. **Closed/moot issue:** if the finding issue is closed/deleted before answer, **supersede** the ledger decision (terminalize without applying), never block.

### Rung-1 ranking derivation extension
`decision-api.ts` `deriveLearningKey` (shipped #803) receives ONLY `decision_id` + `source_url` (no labels — codex IMPORTANT-1). It currently maps the `l2-gate`/`integrate` phase segment; an unknown phase → neutral. **Extend it to parse the strict finding id** `finding-<issue>:finding-dismissal:<category>:<epoch>` → `decisionClass='finding_dismissal:'+<category>`, `context='${owner}/${repo}'` (from `source_url`). The category comes FROM the decision_id (not from a row field — `RankedListItem` has no category), so it is identical to what the apply-consumer observes (both parse the same id). A malformed/short id → neutral (never crash, never mis-key).

### Guarding
Add **the exact string** `finding_dismissal:security` to `DEFAULT_GUARDED_CLASSES` (`operator-learning/types.ts:186`) — the guard is a whole-class `guardedClasses.has(decisionClass)` check (`preference-engine.ts:177`), so the class string must match exactly (codex MINOR-2); add a regression test that `getPreference('finding_dismissal:security', …)` stays `surface`. (Consider also categories implying sensitive_data/compliance/production.) This only changes behavior at PR2/PR3 (guarded → capped at `surface`, never pre-filled/asked-less); in PR1 it's the correct foundation. **Severity guard** (never auto-dismiss a critical/P0 finding regardless of category) is designed in PR3 (a guard predicate on severity, or severity in the class) — flagged, not built in PR1.

### Never-suppress invariant
PR1 NEVER suppresses a finding from reaching the Operator — it ADDS a decision surface. The only place a finding is auto-dismissed (not surfaced) is PR3's ask-less, and only for a non-guarded category with an Operator-approved proposal. (FUNC-AC-OPERATOR-LEARNING: "never suppresses … a decision from reaching the Operator" except a rung-3 approved ask-less.)

## PR2 (sketch) — rung-2 pre-fill
In the builder, call `operatorLearning.getPreference('finding_dismissal:'+category, context)`; if `rung !== 'surface'` (earned pre-fill, not guarded) set `recommended_option = pref.mostFrequentChoice`. Still asks. Reuses the `recommended_option` schema field. Guarded categories (security) never pre-fill (auto-capped at surface).

## PR3 (sketch) — rung-3 propose + act-side ask-less
After observe, `maybeProposeAskLess(class, context)` → raise the `AskLessProposal` as its OWN finding-dismissal-style decision (reuse the emit) → an Operator approve/reject route calling `approveAskLessProposal`. **Act-side:** when `getPreference(...).rung === 'propose-ask-less'` (approved), the emit trigger **stops emitting** finding-dismissal decisions for that learned category (the finding stays on the autonomous agent-triage path = "ask less"). Apply `proposedThreshold`. **Severity guard** lands here: never ask-less a critical/P0 category.

## File topology (PR1)
- new `control-plane/finding-dismissal/{build-request.ts, labels.ts, apply-consumer.ts}` (+ tests) — `labels.ts` is the SHARED parser for category / human-route / guarded / verdict labels (one parse, used by emit + consumer + derivation).
- `control-plane/daemon.ts` — emit trigger wiring (in the tick / detection) + the apply-consumer scan loop beside `resumeParkedRuns`.
- `control-plane/decision-api.ts` — extend `deriveLearningKey` for `finding-dismissal`.
- `operator-learning/types.ts` — add guarded finding categories.
- `config.ts` — `operatorReviewCategories` (allowlist).
- L3: extend STACK-AC-TECH-LEAD-TRIAGE / STACK-AC-OPERATOR-LEARNING-TS / STACK-AC-OPERATOR-SURFACE-API + traceability.

## Test strategy (PR1)
- builder: strict `decision_id` = `finding-<issue>:finding-dismissal:<category>:<epoch>`; phase; options keep(approve)/dismiss(reject); synthetic run_id; risk from severity. Emit does raise→publish→notify (assert the notify, else the row never reaches `/decisions/pending`).
- labels parser (`labels.ts`): strict category extraction over the fixed set (missing/unknown → null → no-emit); human-route; guarded; verdict labels.
- emit trigger: emits for category∈allowlist OR needs-discussion; NOT for no-category, NOT all findings, NOT a duplicate OPEN decision (deterministic id + status check).
- **apply-consumer (the load-bearing):** selects finding rows from `ledger.pending()` by the `:finding-dismissal:` id convention (NOT by `phase`, which the facade lacks); for a row with a DecisionResponse comment → `ledger.answer()` driven by the consumer → **await verdict label + audit comment, await observeDecisionAnswer (with sourceDecisionId), then await advanceToResumed** — in that order; assert **never terminalized before verdict+observe durable**; **crash-before-terminalize replay re-applies idempotently** (labels no-op) and **duplicate observe append does NOT inflate confidence** (dedup by sourceDecisionId); `resumeParkedRuns` does NOT touch finding rows (assert); closed/moot issue → supersede; row with no comment yet → stays pending (no-op).
- deriveLearningKey: the strict finding id → `finding_dismissal:<category>` + context from source_url, EXACTLY matching the observe key; malformed id → neutral.
- guarded: `getPreference('finding_dismissal:security', …)` stays `surface` (regression).
- Pure tests (injected octokit + ledger fake + state), no real GitHub/Postgres/timers. **Heed:** local verify skips real-PG; CI is the real gate — keep these pure so they run in both.

## E2E (Phase 9, demo, index-ON)
Configure `operatorReviewCategories=['correctness']`; create a `review-finding` issue with a `correctness` category label → confirm a `finding-dismissal` decision appears in `/decisions/pending` (keep/dismiss options); answer `reject`(dismiss) via the control API → confirm the verdict label applied + the decision terminalized + an observation recorded (and `/decisions/pending` no longer lists it). Repeat `approve`(keep). Confirm a no-category finding gets no decision.

## Risks
- **Durable-first terminalization (the central risk)** — mitigated by the ordering + idempotency tests above (apply+observe before terminalize; replay-safe).
- **Inbox flooding** — mitigated by the bounded emit trigger (category allowlist / needs-discussion, never all).
- **Synthetic run_id / issue-level decision** colliding with run assumptions elsewhere — audit every consumer of `run_id`/parked-run state; the apply-consumer must be the ONLY thing that processes `phase='finding-dismissal'` rows (resumeParkedRuns must skip them).
- **Learning the wrong actor** — resolved: PR1 makes it a HUMAN decision (the Operator answers in the inbox), per L1.

## Open Questions (for the Operator — configurable defaults, non-blocking)
1. **Default `operatorReviewCategories`** — which finding categories should reach you for personal dismiss/keep by default? (Default conservative: empty or `['correctness']`; per-deployment configurable.)
2. **Guarded categories** — `security` guarded by default (never ask-less). Also guard `compliance`-implying / production-implying findings + critical/P0 severity (PR3). Confirm the set.

## Spec-chain (HARDENING)
Realizes FUNC-AC-OPERATOR-LEARNING rung scenarios (`operator-learning.md:67-90`) for a non-guarded class + FUNC-AC-TECH-LEAD/PRODUCT-OWNER finding lifecycle. Within FUNC-AC-VERIFIER-GATE (auto-dismiss = conservative not-doing, not autonomous execution). No L0/L1 edits; extend L2/L3.
