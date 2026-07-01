# Finding-Dismissal Rung-3/4 "Ask Less" — Design Spec (PR3)

**Date:** 2026-07-01 · **Topic:** `finding-dismissal-ask-less` · **Base:** `origin/main` @ `8d63e45` (+ L1 v2 `c6f976a`)
**Status:** revised after codex R1 (4c/5i) + R2 (3c/5i) + L1 v2 amendment (Operator-approved) · Parents: `2026-06-30-finding-dismissal-learning-design.md`, `2026-07-01-finding-dismissal-rung2-prefill-design.md`

## Goal
Realize FUNC-AC-OPERATOR-LEARNING **v2** rungs 3 + 4 for finding-dismissal: (rung 3) an Operator-approved change to **ask less often** about a non-guarded category, and (rung 4) a **separate** Operator-approved authorization for the platform to **auto-apply the learned dismiss** to *routine* instances — the "ask less" payoff — strictly within the L1 guardrails.

## L1 basis (FUNC-AC-OPERATOR-LEARNING v2 — codex R2 confirmed the amendment L1-valid, guarded set absolute)
- **Rung 3 (l.79-84):** the Operator approves "a change to how often that class is surfaced"; the threshold change then "takes effect" — a **surfacing** change, still asked, never autonomous.
- **Rung 4 (new scenario):** a **further, separate** Operator approval lets the platform apply the learned answer automatically to **routine** instances of a **non-guarded** class; never for safety-critical/sensitive/compliance/spec-content/production-release/flagged/**novel** instances (each still reaches the Operator); every automatic action is recorded visibly, **never counted as new evidence** (l.153 amended), and **reversible** (switch off → asked again).
- **Guarded set absolute** (l.144, l.151) — unchanged.

## Model (codex R2 IMPORTANT-4: policy flag, NOT a 4th RungSchema value)
`RungSchema` stays the 3-value learning **surface** (`surface`/`pre-fill`/`propose-ask-less`) — untouched, no ripple to its 5 hard-coded consumers (`types.ts:8`, `preference-engine.ts:210`, `ranking.ts:96`, `decision-api.ts:106`, `emit.ts:83`). The fourth rung is a **separate, orthogonal authorization**: a distinct approved proposal of kind `act-autonomously`, surfaced as `autoActAuthorized(class, context)`. **Two independent approvals, two proposal kinds** (`ask-less-often`, `act-autonomously`), each with its own liveness key + approve-once CAS.

### Rung 3 — ask-less-often — **DEFERRED product decision (Operator, 2026-07-01)**
codex R2/R3 IMPORTANT-1: a mere de-prioritize is rung-1 ranking, not a genuine "ask less **often**" (fewer asks). For finding-dismissal there is no natural middle behavior between "still ask each" and "auto-dismiss," so the rung-3 shape is an OPEN product decision — **batch/interval-suppress routine dismissals (keep two approvals)** vs **skip rung-3 → a single act-autonomously approval reached from pre-fill**. Deferred; PR3a/PR3b wait on it. **PR3-pre proceeds now (below) — it is independent of this decision.**

### Rung 4 — act-autonomously (the auto-dismiss)
- Proposal kind `act-autonomously`, only offered once rung 3 is approved-and-live for the class (the L1 "already asks less about it" precondition). Informed-consent copy: names that it will auto-apply dismiss without per-finding review, the never-act guards, and the off-switch.
- On approval → `autoActAuthorized === true`. Auto-dismiss then fires per the fail-closed gate below.

## Auto-dismiss gate (fail-closed — any uncertainty → ask)
`autoDismissEligible(labels, category, preference, autoActAuthorized)` true iff ALL:
1. **Both approvals live AND the CURRENT preference still qualifies** (codex R3 CRITICAL — a stale authorization must not outlive consistency, l.153/l.58 "answer has stayed consistent; a contradiction lowers confidence"): the `act-autonomously` approval is live, the `ask-less-often` approval is live, AND `getPreference(finding_dismissal:<category>, ctx)` STILL yields `rung === 'propose-ask-less'` with `mostFrequentChoice === 'reject'` (i.e. routine evidence still crosses the ask-less threshold with dismiss as the learned answer). A later routine **keep**/contradiction drops the rung/flips the choice → auto-dismiss suspends and asking resumes automatically. Test: approve both → auto-dismiss; a subsequent routine keep → next finding is asked, not dismissed.
2. `!isProtectedFinding(labels)` — central fail-closed classifier (codex CRIT-2): guarded category (`security`); `hasHumanRoute`/`needs-discussion`; any explicit protection label (`compliance`, `sensitive`, `sensitive-data`, `release`, `production-release`, `safety-critical`, `spec-content`); OR **severity uncertainty** (codex CRIT-2): NOT exactly one explicit `P1|P2|P3` label — i.e. a `P0`, a **missing** severity, or **multiple** severity labels all force asking (never the `P2` default).
3. `isRoutineFinding(labels)` — label set ⊆ routine vocabulary (`review-finding` + five categories + `P0..P3` + `needs-discussion`); ANY unrecognized label → novel → ask (codex CRIT-3, l.145).
4. **No double-handling** (codex R1 IMPORTANT): `ledger.statusOf(<deterministic finding-dismissal id>)` shows no already-surfaced decision (not notified/viewed/answered/terminal). If the Operator is already being asked, let that decision run; never both.

**Action:** write the `dismissed` verdict via an exported `writeVerdict({actor:'platform', marker, body})` (extracted from the private, Operator-worded `applyVerdict` — codex R1 IMPORTANT) with a machine-action body naming the policy + the off-switch; idempotent (marker-deduped); then raise no decision. Record a distinct `auto_dismiss` action event that is **EXCLUDED from `deriveEvidenceSummary`** and never calls `observeDecisionAnswer` (no self-reinforcement — l.153).

## Hard guards (each a test)
- `isProtectedFinding` applied to **proposal creation, pre-fill (rung-2), AND auto-dismiss** — one classifier, no bypass.
- **Pre-fill hardening (codex R2 CRIT-3 — a PR2 gap):** thread labels into `computeFindingPrefill`; return NO recommendation when `isProtectedFinding(labels)` or severity is uncertain. (A P0/compliance correctness finding must not even be pre-filled a dismiss.)
- **Severity fail-closed:** exactly one explicit non-P0 severity → eligible; P0/none/multiple → ask.
- **Guarded never advances** (l.144): `maybeCreateAskLessProposal` excludes guarded (both proposal kinds).
- **Reversible** (l.156): reject/revert either proposal or a `preference_reset` → its liveness key false → rung-3 de-prioritize and/or rung-4 auto-act stop; asking resumes. Approve-once/CAS so a stale approval replay after reset never resurrects (codex CRIT-4).
- **Dismiss-only** (codex R2 IMPORTANT-5): gate BOTH proposal kinds on `mostFrequentChoice === 'reject'` (a keep-preference has no safe autonomous act).
- **Visible/audited** (l.18, l.160): every auto-dismiss labeled + machine-action audit comment with the revert path.

## Proposal evidence must be built from routine, non-protected source decisions (codex R2 IMPORTANT-2)
`observeDecisionAnswer` today records `{decisionClass, context, sourceDecisionId, chosenOption}` — NO finding labels/severity/protected status. So a proposal cannot today prove its evidence came from *routine* findings. **Requirement:** extend the finding-dismissal observation to record a `routine`/`protected` flag (derived from the source finding's labels at observe time), and build ask-less/act-autonomously proposal evidence ONLY from routine, non-protected, dismiss observations. (Confidence + proposals thus reflect only the routine pattern the auto-act will apply.)

## File topology
**Spec prerequisite (codex R3 IMPORTANT-3):** amend **L2** `ARCH-AC-OPERATOR-LEARNING` (and L3) via `l2-spec-guardian`/`l3-spec-guardian` to add the separate `act-autonomously` policy authorization + the auto-apply act — the L2 currently says the learning service *never acts autonomously* and models only ask-less proposals, so traceability would otherwise forbid PR3b. Keep `RungSchema` three-valued in the L2 too.

**PR3-pre (hardening — safe, immediate value, independent of the deferred rung-3 decision, L1/L2-compatible — BUILDING NOW):**
- `finding-dismissal/labels.ts` — `isProtectedFinding`, `isRoutineFinding`, `explicitSeverity` (exactly-one-or-null), the routine vocabulary + protection-label set. Pure, tested.
- `finding-dismissal/emit.ts` `computeFindingPrefill` — thread labels; no pre-fill when `isProtectedFinding`/uncertain-severity. + tests. **(closes the live PR2 pre-fill gap: a P0/protected finding must not get a pre-filled dismiss — immediate safety value.)**
- `operator-learning/index.ts` — approve-once/CAS on `approveAskLessProposal` (preserve `approvedAt`, bind source decision id, fresh proposal after reset/revert) — a pure bugfix codex flagged critical (the resurrection-after-reset window).
- *(Deferred to PR3a, where their consumer lives: the routine/protected observation metadata producer in `apply-consumer.ts` + the observation schema field. No unused code in PR3-pre.)*

**PR3a (rung-3 ask-less-often — proposal + approval + de-prioritize; no autonomous action):**
- `operator-learning/{types.ts,audit.ts,index.ts}` — proposal `kind` (`ask-less-often`|`act-autonomously`) + per-kind liveness; observation `routine` flag; proposal evidence from routine-only.
- `finding-dismissal/ask-less/` (NEW) — `build-proposal-request.ts` (id `askless-<owner>/<repo>:ask-less-proposal:<category>:<epoch>`, `split(':')[1]==='ask-less-proposal'`, conservative `P2`), `propose.ts` (dismiss-only, routine-only), `approve-consumer.ts` (durable-first).
- `finding-dismissal/emit.ts` — de-prioritize the request when rung `propose-ask-less`.
- `finding-dismissal/tick.ts` + `decision-api.ts deriveLearningKey` (recognize/exclude the proposal id).

**PR3b (rung-4 act-autonomously — the auto-dismiss):**
- the `act-autonomously` proposal (informed-consent) + approve consumer + `autoActAuthorized`.
- `finding-dismissal/apply-consumer.ts` — export `writeVerdict`.
- `finding-dismissal/auto-dismiss.ts` (NEW) — the fail-closed gate + `auto_dismiss` event + action; wired BEFORE emit in `tick.ts`.
- **Acceptance criterion (codex R2 MINOR — hard, not "confirm later"):** the two-approval state machine (two kinds, two liveness keys, approve-once CAS, reset/revert invalidation) is fully implemented + tested before any auto-dismiss path is enabled.

## Test strategy (pure; CI is the gate)
Per bullet above — propose (dismiss-only, routine-only, guarded-excluded, cooldown); approve (rung-3 lifts, rung-4 authorizes; approve-once; reset invalidates); de-prioritize; auto-dismiss eligibility matrix (authorized+reject+routine+explicit-non-P0 → dismissed; P0/none/multi-severity/protected/novel/unknown-label/keep/unauthorized/already-surfaced → asked); no `observeDecisionAnswer` on auto-dismiss; reversibility; pre-fill protection gate.

## Phase 9 E2E (combined rung-2 + rung-3 + rung-4, live) — after PR3b
Seed routine correctness dismissals → rung-2 pre-fill appears (proves PR2); approve ask-less-often → decisions de-prioritized; approve act-autonomously → a new routine correctness finding is auto-dismissed (labeled + machine audit, no decision raised); a **P0** and an **unknown-label** correctness finding still emit (guards); switch off → asking resumes.

## Risks
- **Auto-closing a finding that mattered** — mitigated: two explicit Operator approvals; fail-closed protected + severity + novelty gates; reversible; audited; only the routine, non-protected, dismiss pattern the Operator repeatedly set himself.
- **Self-confidence runaway** — auto-dismiss never feeds evidence (l.153).
- **Opaque bias** — every auto-action labeled + audited with the off-switch (l.18).

## Resolved open question
Auto-keep (`mostFrequentChoice==='approve'`): no autonomous act (keep = leave open = default); a keep-preference never raises either proposal and stays at pre-fill (still asks).
