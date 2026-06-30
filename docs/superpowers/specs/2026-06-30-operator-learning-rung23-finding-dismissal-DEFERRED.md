# DEFERRED design-fork: operator-learning Rung 2/3 ("ask less") on finding-dismissal

**Status: DEFERRED — not a spec, a resume-note.** Date: 2026-06-30. Deferred by Operator decision (the Operator) after grounding revealed it is a major foundational build, not a wiring job. Class confirmed: **finding-dismissal**. Pick this up in a focused session with a real design pass.

## The goal
Realize FUNC-AC-OPERATOR-LEARNING rung 2 (pre-fill a recommendation, still ask) + rung 3 (propose to ask less → Operator approves → threshold changes) for a **non-guarded** decision-class, so the platform learns to **ask the Operator less** about kinds of findings he consistently dismisses. (L1 line 14 names this exact example.)

## Why it's deferred (the discovery)
1. **No non-guarded operator-decision class exists today.** The only two operator decisions implemented (`l2_gate`, `merge_decision`) are both in `DEFAULT_GUARDED_CLASSES` (`operator-learning/types.ts:186-196`) → capped at the `'surface'` rung → rung 2/3 unreachable. So rung 2/3 requires *building a new non-guarded operator-decision flow*.
2. **Finding-dismissal today is agent-driven + label-based + off the decision path.** Findings are dismissed by autonomous PO/TL *agents* applying GitHub labels (`tech-lead/finding-triage.ts applyDecision` reject→close not_planned / defer→`deferred` label; `product-owner/finding-approval.ts` po-rejected) — **never by the human Operator**, and not via a `DecisionRequest`/`DecisionResponse`. The L1's "Operator" is the human (FUNC-AC-OPERATOR-LEARNING actors). So observing today's dismissals learns the *agents'* behavior, not the Operator's — **there is no clean small spec-faithful first step**.
3. **Every escalation is run-parked; finding-dismissal is issue-level.** `buildL2GateRequest`/`buildMergeDecisionRequest` take a `RunState`; `resumeParkedRuns` iterates parked runs; `answerDecision` (`decision-api.ts:491`) is hard-coded approve/reject. A finding is an *issue*, not a pipeline run — so a spec-faithful human-facing finding-dismissal decision means **generalizing the escalation machinery to a new class of non-run, issue-level decisions**. Foundational.
4. **Substrate partly unbuilt:** `STACK-AC-PRODUCT-OWNER-FINDING-APPROVAL` is `status: draft` and `applyFindingDecisions` is *not wired into the daemon* (`finding-approval.ts:98`, no call site; `needs_discussion→SharedPOState` is a TODO).

## What's already built for free (don't rebuild)
- The **read-side rung state machine**: `surface → pre-fill → propose-ask-less`, guarded-pinning (`preference-engine.ts:111`), approval-gating (`getPreference` → `approvedProposalKeys` → `resolveRung` requires `meetsAskLessEvidence && hasApprovedProposal`), reset/revert invalidation (`audit.ts:32-39 isApprovedProposalLive`). Built + tested.
- **Rung-1 inbox ranking** (`decision-api.ts` `applyLearnedRanking`, shipped #803) — re-orders ledger decisions by learned attention; would auto-extend to a finding-dismissal class once it's a ledger decision.
- The protocol already supports rung-2: `DecisionRequest.recommended_option` (`decision-protocol/src/decision-request.ts:37`) + free `phase: z.string()` (`:32`) → a `phase='finding-dismissal'` needs **zero schema change**.
- `maybeProposeAskLess`/`approveAskLessProposal`/`rejectAskLessProposal` exist (`operator-learning/index.ts:194-215`); `maybeCreateAskLessProposal` writes proposal JSON (`audit.ts:150`). The *raise-as-DecisionRequest* + *operator approve route* + *act-side consumer* are missing.

## Recommended approach (re-platform; the only spec-faithful path)
Build a **human-facing, issue-level finding-dismissal decision** and layer rung 2/3 on it.

- **Stable class key:** `decisionClass='finding_dismissal'`, `context='${owner}/${repo}:${category}'`. The per-kind id is the review **`category`** label (`review-scheduler.ts:6`: correctness|consistency|security|performance|test-gaps). NB: the category label is on the issue but **not parsed today** (`triage.ts:18` only extracts P-severity) — add one shared label-parser used by both observe + act.
- **Guard `security`:** consider adding `finding_dismissal:security` (or all security findings) to `DEFAULT_GUARDED_CLASSES` so the Operator is never asked-less about security findings. Policy call for the Operator.
- **Verifier-gate boundary: OK.** Auto-dismiss = conservative *not-doing*, not autonomous execution (FUNC-AC-VERIFIER-GATE governs execution). Bounded by operator-learning's own constraints ("never suppresses a decision from reaching the Operator" except a rung-3 ask-less for a non-guarded class via an Operator-approved proposal).

### PR sequence (each spec-and-deep-reviewed)
- **PR1 — issue-level finding-dismissal DecisionRequest emit + answer + apply.** Emit a `phase='finding-dismissal'` request (options keep/dismiss, `recommended_option` optional) into the ledger for a finding-issue → it lands in `/decisions/pending`; the human answers; on answer, write the verdict label + fire `observeDecisionAnswer({decisionClass:'finding_dismissal', context, chosenOption})`. The hard part: generalize the emit/answer/apply path off the run-parked assumption (a non-run binding) — this is the foundational piece. (Keep findings that don't go to the human on the existing agent-triage path; only surface the kinds intended for Operator judgment.)
- **PR2 — rung 2 (pre-fill).** In the PR1 emitter, call `getPreference('finding_dismissal', context)`; if `rung !== 'surface'` set `recommended_option = pref.mostFrequentChoice`. Still asks.
- **PR3 — rung 3 (propose + act).** After observe, `maybeProposeAskLess(...)` → raise the resulting `AskLessProposal` as its OWN DecisionRequest (reuse PR1 emit) + an operator approve/reject route calling `approveAskLessProposal`. Act-side: when `getPreference(...).rung === 'propose-ask-less'` (approved), **stop emitting** the finding-dismissal request for that learned class (= "ask less"); the finding stays on the agent path. (Apply `proposedThreshold` — `audit.ts:200`.)

## Key open decisions for the design pass
1. **Which findings go to the human at all?** Surfacing every finding as a human decision would be noise. Likely only certain categories/severities, or only after TL/PO triage flags them for Operator judgment. This bounds the whole feature.
2. **Issue-level decision generalization** — the central architectural work: how a `DecisionRequest` binds to an issue (not a `RunState`), how `answerDecision`/`resumeParkedRuns` ingest a non-run answer, how it's reconciled. Design this first.
3. **Guarding security findings** (above).
4. Consider whether to first **wire the draft PO finding-approval flow** (it's not live) as groundwork.

## Alternative class (rejected for now)
**Approaching-limit budget** (continue/defer/extend, FUNC-AC-SAFETY): spec-complete + self-contained, but needs the binary answer transport widened to 3 options, has a "must not introduce a new approval gate" L1 tension, and `extend` must never be pre-filled/auto-applied. the Operator chose finding-dismissal as the better L1-intent match.

## Pointers
Grounding sources: `coordination/tech-lead/finding-triage.ts`, `coordination/product-owner/finding-approval.ts`, `coordination/review-scheduler.ts`, `triage.ts:18`, `decision-escalation/build-request.ts`, `merge-decision/build-request.ts`, `decision-api.ts:274/310/491`, `operator-learning/{index,preference-engine,audit,types}.ts`, `.specify/functional/operator-learning.md` (rung scenarios :67-90), `.specify/stack/operator-learning-ts.md:102` (the explicit gap acknowledgement).
