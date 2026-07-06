---
id: STACK-AC-OPERATOR-LEARNING-TS
type: stack-specific
domain: runforge
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-OPERATOR-LEARNING
code_paths:
  - packages/daemon/src/operator-learning/
  - packages/daemon/src/operator-learning/types.ts
  - packages/daemon/src/operator-learning/observation-log.ts
  - packages/daemon/src/operator-learning/preference-engine.ts
  - packages/daemon/src/operator-learning/ranking.ts
  - packages/daemon/src/operator-learning/audit.ts
test_paths:
  - packages/daemon/src/operator-learning/**/*.test.ts
---

# STACK-AC-OPERATOR-LEARNING-TS — Operator Behavioral Learning (TypeScript)

## Pattern

**Append-only JSONL log for observations, with derived preference state recomputed on read.** Each observation is an immutable JSONL line keyed by an `observationId`. The preference engine reads all observations for a `(decisionClass, context)` pair and derives confidence, the most frequent choice, and the effective rung. This mirrors the Knowledge Service's append-only log pattern and keeps the learning state reconstructible from raw observations.

**Preference as a pure function over observations.** No mutable preference cache is authoritative; `derivePreference(observations)` returns the current `Preference` deterministically. A lightweight in-memory cache may speed repeated reads, but the JSONL log remains the source of truth.

**Rung state machine as explicit transitions.** The rung transitions only on evidence thresholds and Operator approval. Guarded classes are rejected at the transition boundary, not by special-casing the state machine internals.

## Key Decisions

**Observation log at `state/operator-learning.jsonl`.** Each line is a JSON object with a discriminating `kind` field: `decision_answer`, `rerank_action`, or `spec_edit`. All observations share `decisionClass`, `context`, and `observedAt`; kind-specific fields live inside a `payload` object. Writes append a single line; reads scan and filter in memory.

**Zod schemas for observation kinds.** Runtime validation keeps malformed lines from poisoning derived state. Unknown `kind` values are skipped with a warning rather than failing the whole read.

**Confidence as Laplace-smoothed agreement ratio.** For `n` observations with `m` matches to the modal choice and `c` contradictions, `confidence = (m + 1) / (m + c + 2)`. This stays bounded in `(0,1)`, requires repeated evidence to rise, and falls smoothly on contradiction. Confidence never advances a rung on a single observation.

**Rung thresholds are configuration, not code.** Default thresholds: `surface` is the starting rung; `pre-fill` requires `confidence >= 0.75` and `n >= 3`; `propose-ask-less` requires `confidence >= 0.9` and `n >= 5`. Thresholds live in the config subsystem (STACK-AC-CONVENTIONS `config.ts`) so the Operator can tune them without changing code.

**Guarded classes via a hard-coded set checked at transition time.** The set contains keys such as `safety_critical`, `sensitive_data`, `compliance_gate`, `specification_content`, and `production_release`. The state machine itself is unaware of guardrails; the public `advanceRung` function rejects transitions that would move a guarded class past `surface`.

**Attention weights for re-ranking.** Re-rank observations contribute `+1` for pin/reorder-to-top, `-1` for mute/defer. The attention weight for a class/context is the sum of recent weights within a configurable recency window. Positive weights boost ranking; negative weights demote but never hide.

**Ranking score = base priority + learned boost, with explanation attached.** The learned boost is a small additive term derived from attention weight and rung. The explanation object carries `basePriority`, `attentionWeight`, `rung`, `confidence`, and `evidenceSummary` so the Steering Surface can render "why ranked here" without recomputing.

**Ask-less proposals are stored as JSON files in `state/operator-learning-proposals/{id}.json`.** Each proposal records the decision class, context, proposed frequency threshold, evidence, status, and optional approval timestamp. On rejection, a `cooldownUntil` timestamp prevents immediate re-proposal.

**The fourth rung (ARCH-AC-OPERATOR-LEARNING v2 act-autonomously authorization) is a proposal `kind`, never a fourth `RungSchema` value.** `RungSchema` stays exactly `['surface', 'pre-fill', 'propose-ask-less']` — its literal values are hard-coded in multiple consumers (the rung order array, the ranking boost map, the operator-surface rung allowlist, and the pre-fill gate), so widening the enum ripples unsafely. Instead, proposals carry a discriminating `kind` (`ask-less-often` | `act-autonomously`), each kind with its own independent liveness and approve-once compare-and-swap so a stale approval replayed after a reset or revert never resurrects. Autonomous application is exposed as a derived boolean per `(decisionClass, context)` — true only while the `act-autonomously` approval is live AND the currently derived preference still qualifies (still at the ask-less rung with the same learned answer) — never as stored mutable state.

**Audit trail mirrors the observation log.** Reset and revert events are appended as observations with kinds `preference_reset` and `preference_revert`. The audit list is the filtered log of these event kinds plus rung transitions.

## Examples

```typescript
// Append an observation
function appendObservation(logPath: string, obs: Observation): Promise<void> {
  return appendJsonl(logPath, obs);
}
```

```typescript
// Derive preference from observations for one (class, context)
function derivePreference(
  observations: Observation[],
  thresholds: RungThresholds,
  guarded: Set<string>,
): Preference {
  const decisionAnswers = observations.filter(o => o.kind === 'decision_answer');
  const counts = countByChoice(decisionAnswers);
  const modal = maxBy(counts, ([, n]) => n);
  const contradictions = decisionAnswers.length - modal[1];
  const confidence = (modal[1] + 1) / (decisionAnswers.length + 2);
  // rung resolution respects guarded classes
  return resolveRung({ confidence, n: decisionAnswers.length, guarded: guarded.has(...) }, thresholds);
}
```

```typescript
// Ranking with explanation
function rankItems(
  items: InboxItem[],
  preferences: Map<string, Preference>,
  attention: Map<string, number>,
): RankedItem[] {
  return items
    .map(item => ({ ...item, score: basePriority(item) + boost(item, preferences, attention) }))
    .sort((a, b) => b.score - a.score);
}
```

```typescript
// Guarded-class transition guard
function advanceRung(preference: Preference, target: Rung, guarded: Set<string>): RungResult {
  if (guarded.has(preference.decisionClass) && target !== 'surface') {
    return { ok: false, reason: 'guarded class cannot advance past surface' };
  }
  return { ok: true, rung: target };
}
```

## Gotchas

- The read-side actuator must actually be wired or it is dead code. `rankInboxItems`/`getPullTimeRelevance` are the ONLY way learned attention reaches the Operator. The proven consumer is the daemon's pending-decisions inbox (`listPendingDecisions`, STACK-AC-OPERATOR-SURFACE-API): it injects `rankInboxItems` and re-orders the inbox by learned preference on top of base priority (FUNC-AC-OPERATOR-LEARNING rung 1). For the classes the daemon currently observes (`l2_gate`/`merge_decision`), both are in `DEFAULT_GUARDED_CLASSES` → capped at the `'surface'` rung, so ONLY rung 1 (re-rank/surface) is reachable; rung 2 (pre-fill) / rung 3 (ask-less) are unreachable until a NON-guarded observed class exists, and wiring them for a guarded class would be dead code.
- The consumer's learning key must match what `observeDecisionAnswer` recorded, byte-for-byte. The observe path keys on `decisionClass ∈ {l2_gate, merge_decision, finding_dismissal:<category>}` × `context = ${owner}/${repo}`. A consumer that derives a different class (e.g. from a display field) or a different context (e.g. the `deployment` id instead of `owner/repo`) silently learns nothing — the keys never join. Derive the class from the deterministic `decision_id` phase segment and the context from the issue `source_url`.
- **Finding-dismissal is the first NON-guarded observed class (PR1).** `finding_dismissal:<category>` puts the review `category` IN the class string so the existing whole-class `guardedClasses.has(decisionClass)` guard can guard a single category (`finding_dismissal:security` is in `DEFAULT_GUARDED_CLASSES`, capped at `surface`; the other categories are free to earn pre-fill/ask-less in PR2/PR3). The guard is a whole-class STRING check, so the guarded entry MUST match the observe/derive key EXACTLY. PR1 wires only rung-1 (the inbox re-ranks once the class is learned); pre-fill (PR2) and act-side ask-less (PR3) build on this foundation. The class string is produced by one helper (`finding-dismissal/labels.ts:findingDismissalClass`) shared by the apply-consumer's observe AND `deriveLearningKey` so they can never drift.
- `rankItems` is membership-preserving but the SEAM is not. `rankItems` maps every input and never drops, but a consumer that trusts a wrong-shaped result can still suppress an item OR leak text. A consumer of the (potentially injected/untrusted) ranker must validate BOTH that the output decision-id multiset equals the input multiset EXACTLY (never suppress) AND that each item's `explanation` is well-formed at runtime — `rung` ∈ the literal enum, `confidence`/`attentionWeight` finite numbers — before stringifying any of it into an operator-visible surface (the TS type is not a runtime guarantee). Either check failing → fall back to the base order; never let a buggy/partial/hostile ranking hide a decision or write arbitrary text.
- JSONL read: skip empty lines and malformed lines with a warning. A truncated final line from a crash must not prevent reading earlier observations.
- Confidence must require varied occurrences. If all observations come from the same decision instance (e.g., a retry loop), confidence should not rise. Include a `sourceDecisionId` field and require at least `minDistinctSources` distinct sources before advancing a rung.
- Re-rank weights must decay. A mute from six months ago should not permanently suppress a class. Apply a recency window or exponential decay to attention weights.
- Pull-time relevance must not hide guarded or novel items. The function returns the highest-scoring candidate, but callers must still surface all candidates somewhere if the selected one is not chosen.
- Reset is per `(decisionClass, context)` pair. Resetting "approve low-risk dependency updates in deployment A" must not affect the same class in deployment B.
- Ask-less proposals must be decision requests. Do not silently change surface frequency when the threshold is crossed; always raise a `DecisionRequest` and wait for an explicit Operator answer. The `act-autonomously` proposal is the same pattern with informed-consent copy: it must name what will be auto-applied, the instance kinds it will never act on, and the off-switch.
- An autonomous action must never feed the evidence loop. Record it as a distinct action event kind excluded from evidence derivation, and never call the decision-answer observe path for it — otherwise the platform reinforces its own confidence (forbidden by FUNC-AC-OPERATOR-LEARNING v2).
- The autonomous-application gate fails closed. Any read failure, missing authorization, no-longer-qualifying preference, protected or novel instance attribute, uncertain severity, or already-surfaced pending decision → ask the Operator instead of acting. Never default a missing attribute toward eligibility.
- Sensitive observations: never include the `sensitive` payload in explanations or audit entries visible outside the authorized Operator view. The aggregate count may be reported, but not the content.
- Fleet-wide revert: the Operator Learning Service records the revert locally and emits an event the Fleet subsystem consumes. Do not assume all deployments are reachable synchronously.
- Spec-edit fingerprints should be structural, not textual. Avoid storing full diff content; store only the classification of the change (e.g., "added constraint", "removed step", "reordered section").
- The preference cache, if used, must be invalidated on any observation append. A stale cache is a bug; the JSONL log is always authoritative.
