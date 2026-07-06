# Operator-Learning Rung 1 — Wire Learned Attention into the Pending-Decisions Inbox

**Date:** 2026-06-26 · **Topic:** `operator-learning-rung1-ranking` · **Base:** `origin/main` @ `3823fd1`
**Status:** draft (codex review pending)

## Goal
Make operator-learning **act** instead of being a write-only log: wire `rankInboxItems` into the operator's pending-decisions inbox (`/decisions/pending`) so the order reflects the operator's **learned attention** on top of the explainable base priority. This realizes FUNC-AC-OPERATOR-LEARNING's **rung-1** ("surface differently, still ask") — the only action the L1 permits for the decision-classes the daemon currently observes.

### Why rung 1 (and not pre-fill / ask-less)
The only classes the observe path records are **`l2_gate`** and **`merge_decision`** (`daemon.ts:2629,2915`, keyed by `${owner}/${repo}`). Both are in **`DEFAULT_GUARDED_CLASSES`** (`operator-learning/types.ts:194-195`) — by explicit design "merge/integrate decisions retain operator oversight: they must never silently auto-advance to pre-fill/ask-less." `derivePreference` caps a guarded class at the `'surface'` rung (`preference-engine.ts:111`). So **rung-2 pre-fill and rung-3 ask-less are unreachable for the observed classes** — wiring them would be dead code. Rung 1 (re-rank/surface) is exactly what the L1 allows for a guarded class: *"may re-rank and surface it more usefully, but never pre-fills it as auto-confirmable, never proposes to ask less."*

### Out of scope (deferred follow-ups)
- **Rung 2 (pre-fill) / Rung 3 (ask-less)** — require a **non-guarded** observed decision-class (e.g. finding-dismissals) to be reachable. That needs new observe points + a non-trivial consumer, and is the higher-value "ask less" payoff — a separate, larger effort. **Not buildable as value today** without first observing a non-guarded class.
- **Pull-time contextual relevance** (`getPullTimeRelevance` into work-selection) — a sibling rung-1 surface; can follow once the inbox wire is proven.

## L1 basis (HARDENING — realizes existing mandated behavior)
- **FUNC-AC-OPERATOR-LEARNING** `Scenario: Global inbox order reflects learned attention` — "items are ordered using the learned preference **on top of** the explainable base priority, so what the Operator consistently treats as most important surfaces first / each item can show why it is ranked where it is."
- `Scenario: First rung — surface differently, still ask` — "the items are re-ranked and pull-time relevance is adjusted, but the Operator is still asked every time."
- `Scenario: Learned ordering never suppresses a guarded or novel decision` — "learned preference may change order but never hides or drops such an item; a genuinely novel or guarded decision always reaches the Operator."
- `Scenario: A guarded decision-class never advances past the first rung` — re-rank only; never pre-fill/ask-less. (Satisfied structurally: the observed classes are guarded → capped at `'surface'`.)
- Governing specs: **STACK-AC-OPERATOR-LEARNING-TS** (the module) + **STACK-AC-OPERATOR-SURFACE-API** (the `/decisions/pending` inbox) → ARCH → FUNC-AC-OPERATOR-LEARNING / FUNC-AC-OPERATOR-SURFACE.

## Current state (file:line @ 3823fd1)
- **Actuators dead:** `rankInboxItems`/`getPreference`/`getPullTimeRelevance`/`maybeProposeAskLess` (operator-learning/index.ts:162-215) have **0 production callers** (write-only module).
- **Write path wired:** `OperatorLearningService` constructed + `init()` (`daemon.ts:790-794`); `observeDecisionAnswer({decisionClass:'l2_gate'|'merge_decision', context:'${owner}/${repo}', chosenOption})` at `daemon.ts:2628,2913`.
- **The inbox:** `GET /decisions/pending` → `listPendingDecisions` (`decision-api.ts:68`) → `RankedListItem[]`, sourced from the decision-index read-model's "Ranked dashboard inbox" (`read-model.ts:239`), ordered by `priority.score` desc (tie-break `decision_id` asc), each row carrying `why_ranked` (explainability already present).
- **`InboxItem`** = `{decisionId, decisionClass, context, basePriority}` (types.ts:138-143); **`rankInboxItems(items) → RankedItem[]`** layers the learned preference over `basePriority` and is guarded-safe + novel-safe at the engine level (`rankItems`).

## Design
Wire `rankInboxItems` into `listPendingDecisions` so the returned inbox is ordered by learned attention over the base priority, **without** changing membership (no item added or dropped):

1. **Derive the learning key per row (Codex I1 — `RankedListItem` does NOT carry `decisionClass`, and its `context` is a redacted display field, NOT the learning key).** The row shape (`read-model.ts:61`) is `{decision_id, risk_class, deployment, source_url, score, why_ranked, …}`. Derive the key that **matches what `observeDecisionAnswer` recorded** (`l2_gate`|`merge_decision` × `${owner}/${repo}`, `daemon.ts:2628/2914`):
   - **`decisionClass`** from the deterministic `decision_id` phase segment: `…:l2-gate:…` → `l2_gate`; `…:integrate:…` → `merge_decision`. An unrecognized phase → treat as a **neutral / unlearnable** item (no boost; never dropped).
   - **`context`** = `${owner}/${repo}` parsed from `source_url` (the GitHub issue URL) — this is what the observe path used (`${runOwner}/${runRepoName}`); do NOT use `deployment` (that's the deployment id, e.g. `cause-driven-tasks`, not `owner/repo`).
   - **`basePriority`** = `score`; **`decisionId`** = `decision_id`.
   - A small pure `deriveLearningKey(row) → {decisionClass, context} | null` with tests asserting `issue-x:l2-gate:n → l2_gate` + `issue-x:integrate:n → merge_decision` and `context` exactly matching the observed `${owner}/${repo}`.
2. **Rank the FULL inbox (Codex round-2 minor — the safety property is over EVERY row, not just learnable ones):** map **all** rows → `InboxItem[]`. Learnable rows carry the derived `{decisionClass, context}`; an unrecognized-phase / malformed-`source_url` row carries a **neutral sentinel key** (a class/context that matches no observations → zero learned boost → stays at its base position). Pass the full set to `operatorLearning.rankInboxItems(items)` → `RankedItem[]` (the ONLY learning call). `rankItems` maps every input item and never drops, so the full set is preserved.
3. **Validate the ranker output before trusting it (Codex I2 — the injected ranker is untrusted):** the returned `RankedItem` decision-id **multiset must equal the FULL ORIGINAL base-row multiset exactly** — no missing, no extra, no duplicate IDs (over every row, including neutral ones). If it does not match (or the call throws, or the store is unavailable) → **fall back to the base order** + log. Only on an exact match is the reorder applied. This makes "never suppress" robust against a buggy/partial ranker, not just a throwing one.
4. **Reorder + explain:** reorder the SAME set by the validated `RankedItem` order, and append an **allowlisted, structured** learned note to each row's `why_ranked` (Codex m1 — `RankedItem` has no free `reason`; use ONLY its structured `explanation` fields `rung`/`confidence`/`attentionWeight`, e.g. `· learned: rung=surface confidence=0.67 attentionWeight=1`). **Never** stringify the row `context`, protected/PHI fields, or arbitrary ranker output into `why_ranked`.
5. **Guardrails (tested):**
   - **Never suppress/drop:** output set === input set (validated in step 3); novel (no observations) + guarded items always remain present; ranking only reorders.
   - **No-observations → identical order (pin at the API seam, Codex m2):** a daemon with zero observations yields the existing base order (`score desc, decision_id asc`) byte-for-byte — no behavior change until something is learned.
   - **Fail-safe:** any ranker error / invalid output / unavailable store → base order + log. Learning is an enhancement, never a dependency of the inbox.
6. **Injection:** `listPendingDecisions` gains an optional `rankItems?: (items: InboxItem[]) => Promise<RankedItem[]>` dependency (daemon injects `operatorLearning.rankInboxItems`); absent → base order. Keeps it testable + the fail-safe explicit.

## File topology
- `control-plane/decision-api.ts` — `deriveLearningKey(row)` (pure); `listPendingDecisions` consumes the injected ranker: derive keys → map → rank → **validate output multiset** → reorder + allowlisted `why_ranked` note; fail-safe to base order on any error/invalid-output.
- `control-plane/daemon.ts` — inject `operatorLearning.rankInboxItems` into the `listPendingDecisions` handler wiring.
- New/extended tests; L3: extend **STACK-AC-OPERATOR-LEARNING-TS** + **STACK-AC-OPERATOR-SURFACE-API** with the ranking-consumer contract (derive-key + output-validation + allowlisted-explainability); `.specify/traceability.yml` if new files.

## Test strategy
- **`deriveLearningKey` unit tests:** `issue-7:l2-gate:1 → {l2_gate, owner/repo}` (context parsed from `source_url`); `issue-9:integrate:2 → {merge_decision, owner/repo}`; unknown phase → `null` (neutral, not dropped); a malformed `source_url` → context derivation fails safe (row treated as neutral, never dropped). Assert the derived class+context EXACTLY equal the strings `observeDecisionAnswer` records.
- **`listPendingDecisions` ranking tests (injected fake ranker):** reorders by the learned order; **input/output decision-id multiset equal** → reorder applied; **output missing an ID / extra ID / duplicate ID / mismatched ID → base order + logged** (the I2 validation); **ranker throws → base order + logged**; novel + guarded items always present; `why_ranked` carries ONLY the allowlisted structured note (no context/protected leak — assert the protected/PHI fields never appear in `why_ranked`); **injected ranker returns identical scores → returned order === base order byte-for-byte** (m2 seam pin).
- Engine guardrail (operator-learning tests; add if missing): `rankItems` returns the same set (never drops a novel/guarded item), zero-observations → zero boost.
- No real timers; inject a clock where the ranker needs `now`. **Heed the memory lesson:** local verify SKIPS real-PG suites (the read-model is PG-backed) — **CI is the real gate**; make the new decision-api tests pure (injected fakes, no real PG) so they run locally AND in CI, not skip.
- Run: `pnpm --filter @runforge/daemon exec vitest run src/control-plane/decision-api.test.ts src/control-plane/daemon.test.ts src/operator-learning src/infra/traceability-paths.test.ts` + lint + typecheck.

## E2E (Phase 9, demo, index-ON)
Seed observations so a class has a learned weight (answer several `merge_decision`/`l2_gate` decisions for the demo repo, or pre-seed the observation log), create ≥2 pending decisions, `GET /decisions/pending` → confirm the order reflects learned attention over base priority AND every item is still present (none suppressed) AND `why_ranked` shows the learned reason. Negative: with no observations, order is unchanged.

## Risks
- **Inbox correctness is load-bearing** — a bug that drops/hides a decision is worse than no ranking. Mitigated by the membership-unchanged guardrail + the fail-safe-to-base-order + tests asserting set equality.
- **Explainability drift** — merging the learned reason must not corrupt the existing `why_ranked`. Test it.
- Small blast radius — one read endpoint's ordering; no write, no autonomy change, no effect until something is learned.

## Follow-ups
1. **Pull-time relevance** (`getPullTimeRelevance` into work-selection) — sibling rung-1 surface.
2. **Reach rung 2/3 ("ask less")** — observe a **non-guarded** decision-class the operator routinely handles (e.g. finding-dismissals), then wire pre-fill + the propose-ask-less proposal→approval→threshold loop. This is the headline attention-saving payoff and the natural next major increment; it is NOT reachable for the guarded `l2_gate`/`merge_decision` classes by L1 design.
