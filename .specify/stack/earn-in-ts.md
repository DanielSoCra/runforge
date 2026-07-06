---
id: STACK-AC-EARN-IN
type: stack-specific
domain: auto-claude
status: draft
version: 1
stack: typescript
layer: 3
references: ARCH-AC-EARN-IN
code_paths: []  # DEFERRED to implementation — net-new files (floor evaluator, track-record derivation, mint wiring, debut reader, demote trigger) don't exist yet; the seams it composes (lane-engine/earn-in.ts, deployment-registry recordWidening, merge-decision/observe-verifier.ts, phases.ts) are owned by their own nodes. cf. STACK-AC-DEPLOYMENT-REGISTRY.
test_paths: []  # DEFERRED to implementation — same reason
---

# STACK-AC-EARN-IN — Pre-Approved Earn-In Promotion (TypeScript)

> **Scope.** The daemon Control-Plane earn-in mechanism for ARCH-AC-EARN-IN / FUNC-AC-MERGE-DECISION v2.3: a pure floor evaluator composed over the existing bar predicate, a separate **mint step** at the integrate seam that widens autonomy through the registry's reversible write, the debut gate for a deployment's first unattended merge, and the demote-on-red trigger. The pure `decideMerge` is **not** touched. `code_paths` list only files that exist today; the net-new paths are added when the mechanism is implemented.

## Pattern

**A separate mint step composing a pure floor evaluator over the existing bar predicate — `decideMerge` stays pure and untouched (option b, not a change to the decision).** The v2.2 bar already lives as the pure `evaluateEarnIn(record, policy)` in `lane-engine/earn-in.ts` (`cleanMerges` / `bounceFreeDays`, no I/O). Earn-in adds a second pure function, `evaluatePromotion`, that composes the v2.3 non-configurable floors *over* that bar verdict, and a Control-Plane **mint step** wired into the integrate handler that, on a fully-cleared auto-widen, records the widening through the registry's reversible write with an `earn-in-policy` authorization (the write path already accepts it; the call shape is in Examples). The mint runs *before* the `autonomyWidened` closure at `phases.ts:2506`, so the very next `decideMerge` reads the freshly-recorded state and disposes the change on its own merits. This mirrors the codebase idiom: pure decisions (`evaluateEarnIn`, `evaluatePromotion`) in exhaustively-testable functions, I/O and state mutation at the integrate edge.

**Fail-closed discriminated-union outcomes.** `evaluatePromotion` returns `{ kind: 'not-eligible' } | { kind: 'raise-decision'; failedFloors } | { kind: 'auto-widen'; clearedFloors; evidence; policyRef }`. The `auto-widen` arm MUST carry `policyRef` (the pre-approved policy's reference), because the mint step records the widening as `{ kind: 'earn-in-policy', policyRef }` and the registry requires that authorization — the evaluator that decides to auto-widen is the only place the policyRef is in hand, so it threads it through rather than have the mint step re-derive it. There is no `null` and no throw on a policy question; any indeterminate input collapses to `not-eligible` or `raise-decision`, never `auto-widen`. Exceptions are reserved for programmer error.

**Floors are a platform constant, not config.** `EARN_IN_FLOORS` is a frozen module constant the schema layer cannot reach — no pack, profile, or lane field parses into it. A deployment's declared bar (`EarnInPolicy`) may only make promotion *harder* than a floor; the evaluator rejects a bar that sits below any numeric floor exactly as it rejects a missing bar.

## Key Decisions

- **`evaluatePromotion` composes `evaluateEarnIn`, never forks it.** It first calls the existing bar predicate; a `not-eligible` bar short-circuits to `not-eligible`. Only on an `eligible-for-promotion` bar does it evaluate the floors. The bar stays the Lane Engine's; earn-in owns only the floors layered on top.
- **`EARN_IN_FLOORS` is a frozen constant with PROVISIONAL values pending the Operator's ruling (bridge #104).** Default conservative: `{ minCleanMerges: 10, recencyWindowDays: 30, redWindowDays: 30 }` — the deployment cannot lower them. The "bar ≥ floor" check (`bar.cleanMerges >= EARN_IN_FLOORS.minCleanMerges` and `bar.bounceFreeDays >= EARN_IN_FLOORS.recencyWindowDays`) belongs **inside** `floorsFailed` as named failure entries (e.g. `bar-clean-merges-below-floor`), alongside the structural floors (no red in window, scope holding, verifier-gated, reversible) — so a weak declared bar surfaces in `failedFloors` as complete audit evidence rather than as a silent non-match. Mark the constant with a comment tying it to the bridge item so the eventual ruling is a one-line edit.
- **`cleanMerges` counts every clean merge through the lane — Operator-approved or autonomous.** The existing `LaneTrackRecord.cleanMerges` (and the bar) accrue from changes flowing through the lane while it is still human-gated too, not only from autonomous merges; otherwise the bar could never be met before autonomy exists (chicken-and-egg). Do not filter the earn-in record to autonomous merges.
- **Recency is freshness, not just streak length — guard against a dormant record.** `cleanMerges` is cumulative and `bounceFreeDays` grows on an idle lane, so a lane whose ten clean merges are all months old would clear the amount + streak checks while proving nothing recent. The recency floor therefore requires that **at least `minCleanMerges` clean merges occurred *within* `recencyWindowDays` of `now`** — NOT merely that the single most-recent clean merge is recent. The weaker "most-recent within window" reading is unsafe: a dormant lane with ten months-old clean merges and one fresh success would clear it after a single recent merge, proving no current record. Require the full floor count inside the window: count, from the recorded outcome timestamps, the clean merges whose timestamp is `>= now - recencyWindowDays`, and fail the recency floor unless that count `>= minCleanMerges`. A stale/dormant lane fails even with a high cumulative `cleanMerges`. This derivation reads recorded timestamps only; `now` is passed in.
- **`reversible-on-red` is a structural invariant, not a lane flag.** Every earn-in widening is recorded through `recordWidening`, which the demote primitive can always reverse (a level-wide demote to `human-gated` clears the class's lane widenings and appends per-lane revocations — `registry.ts:417`). So the floor is satisfied by construction: mint only through that path and keep the demote-on-red trigger wired. No `reversibleOnRed` field is added to `LaneDefinition`.
- **The pre-approved policy rides on the lane as pass-through data.** A `preApprovedEarnIn?: { policyRef: string }` field on the lane declaration is opaque to the Lane Engine (which already passes `earnIn` through as config data); earn-in is its sole interpreter. Its presence flips the outcome on a met bar from `raise-decision` (v2 default) to a candidate `auto-widen`; its `policyRef` becomes the `earn-in-policy` authorization's `policyRef`. Absent ⇒ v2 default, unchanged.
- **The red-window marker is derived from recorded state, never declared.** Compute it over the lane's recorded outcome stream + the registry autonomy history: a red-risk merge, a high-severity batch-review finding, a post-merge tripwire fire, a failed release, a compliance breach, or a demote-on-red `WideningRecord` (`next: 'human-gated'`) whose `recordedAt` falls within `redWindowDays` of `now`. `now` is passed in (the `observedAt` idiom), never read inside the pure function.
- **The mint step guards on the human-gated → widened crossing and never crosses always-escalate.** It fires only when `readAutonomyState(id, level, lane)` currently reads `human-gated` (idempotent — a second pass is a no-op), only for `verifierStatus` gated, only for a level eligible for an autonomous proceed (`green`/`yellow`; never `orange`/`red`), and only when `complianceForced` is false. It never duplicates the merge-decision gates — it widens the *state* the decision reads, it does not decide the merge.
- **`hasDebutAuthorization(deployment)` reads the Release Ledger; the debut is derived from autonomy history.** "Is this the first unattended merge" = `!history.some((r) => r.next === 'widened')` over the registry's `WideningRecord[]` — the deployment's **first-ever** widening to a widened state, of any authorization, is the debut. Any prior widening (a per-event `operator-grant` OR an earlier `earn-in-policy` promotion) means the crossing into unattended merging was already witnessed, so a later earn-in promotion is not the debut and proceeds. Guarding on `next === 'widened'` (not on the authorization kind) is what keeps it live: it never traps a deployment whose debut was witnessed by a per-event grant, and it fails closed only for the true first-ever, mechanism-driven crossing. `hasDebutAuthorization` reads the release ledger for an **approved** decision event (answer `approve`) whose detail carries `debutAuthorized: true` — a rejected release, even one whose payload set the flag, never authorizes the debut; a deployment with no production-release path has no such event, so it returns `false` and the first earn-in widening is withheld to a per-event Operator decision whose grant records an `operator-grant` widening — and that now-present prior widening record makes the next earn-in promotion no longer the debut (the witnessed per-event debut unlocks earn-in for a no-release-path deployment, so it is never trapped closed forever).
- **Demote-on-red calls the same primitive.** The trigger is a thin Control-Plane hook in the post-landing / post-run observation path (`runPostLandingObservation`, `phases.ts`) that, on a `RedEvent`, calls `registry.recordWidening(id, class, 'human-gated', auth, ts)` (level-wide, so lane widenings clear). No new reversal machinery — it reuses the existing demote path that already records revocations.

## Examples

```ts
// Compose the floors OVER the existing bar predicate — decideMerge is untouched.
function evaluatePromotion(i: PromotionInput, now: number): PromotionResult {
  if (evaluateEarnIn(i.record, i.bar).kind !== 'eligible-for-promotion')
    return { kind: 'not-eligible' };
  const failed = floorsFailed(i, now);      // ALL floor failures — structural (red/scope/
  //   verifier/reversible/recency) AND numeric bar-below-floor (bar-clean-merges,
  //   bar-recency), so `failedFloors` is complete audit evidence, not just a subset.
  const eligible = i.preApproved !== undefined && failed.length === 0;
  return eligible
    ? { kind: 'auto-widen', clearedFloors: FLOOR_NAMES, evidence: i.record, policyRef: i.preApproved.policyRef }
    : { kind: 'raise-decision', failedFloors: failed };
}
```

```ts
// The mint step at the integrate seam — runs BEFORE the autonomyWidened closure
// (phases.ts:2506) so the very next decideMerge reads the widened state.
if (p.kind === 'auto-widen' && verifierStatus.falsifying && !complianceForced
    && isAutonomousEligible(level) && currentlyHumanGated(deploymentId, level, lane)) {
  if (isDebut(deploymentId) && !hasDebutAuthorization(deploymentId)) {
    /* withhold — fall through to a per-event Operator decision */
  } else {
    registry.recordWidening(deploymentId, level, 'widened',
      { kind: 'earn-in-policy', policyRef: p.policyRef }, now, lane);
  }
}
```

```ts
// Debut derived from the registry's own history — rename/clone/re-bundle cannot evade it.
// First-ever widening of ANY authorization is the debut; a prior grant already witnessed it.
const isDebut = (id: string): boolean =>
  !registry.readAutonomyHistory(id).some((r) => r.next === 'widened');
```

## Gotchas

- **Mint before the `autonomyWidened` closure, not after.** The closure at `phases.ts:2506` reads `readAutonomyState`; if the mint runs after `decideMerge`, this run won't benefit and the widening lags a run behind. Order: `assignLane` → `observeVerifierStatus` → **mint** → `autonomyWidened` closure → `decideMerge`.
- **`decideMerge` stays pure — the mint is a sibling step, not a branch inside it.** Do not thread earn-in into `decide.ts`; it composes as a separate state-mutation step ahead of the decision. Adding it inside `decideMerge` would make the pure decision read/write state and break its exhaustive testability.
- **A bar below a floor fails closed exactly like a missing bar.** Do not treat an explicit-but-weak bar as "the Operator chose it, so honor it": `bar.cleanMerges = 3` with `minCleanMerges = 10` resolves to `raise-decision`, never `auto-widen`. The bar is necessary, not sufficient.
- **The mint is idempotent — gate on `human-gated`.** Without the `currentlyHumanGated` guard, every integrate pass re-records a widening, flooding the history and re-tripping the debut derivation timing. Fire exactly at the crossing.
- **Never let the mint touch orange/red/compliance-forced.** These are always-escalate; the guard (`isAutonomousEligible(level) && !complianceForced`) must precede the `recordWidening` call, not follow it. A widening recorded for an always-escalate class is inert (the merge decision still escalates) but pollutes the audit trail and the debut history.
- **Demote-on-red must be level-wide to clear lane widenings.** Call `recordWidening(id, class, 'human-gated', auth, ts)` with **no** `lane` argument — a lane-scoped demote leaves the level-wide entry (and the `readAutonomyState` OR-logic) reading `widened`. The level-wide demote path is the one that appends per-lane revocations (`registry.ts:417`).
- **Red-window marker and the demote trigger are two effects of one event.** A red event both demotes (reverses the widening now) and sets the marker (blocks re-promotion for `redWindowDays`). Wire both off the same `RedEvent`, or a demoted lane will immediately re-earn and re-mint on the next clean pass.
- **`EARN_IN_FLOORS` values are provisional (bridge #104).** Do not hard-code them in multiple places or treat them as final; single frozen constant, one comment tying it to the ruling. The Operator's decision changes the numbers, never the mechanism.
- **`recordWidening` fails closed on persistence.** It persists before committing in-memory (`registry.ts` — durable write first). Treat a non-`ok` outcome as "not widened"; never report an auto-promotion that did not durably record, because an unrecorded widening is neither reversible nor explainable.

## Concerns This Spec Does Not Cover

- The bar predicate itself (`evaluateEarnIn`), lane assignment, the scope tripwire, and the recorded `LaneTrackRecord` (STACK-AC-LANE-ENGINE owns these; earn-in composes over them).
- The autonomy-state store, the `recordWidening` write/demote primitive, and the `WideningRecord` history shape (STACK-AC-DEPLOYMENT-REGISTRY owns them; earn-in only calls and reads them).
- The verifier observation (`observeVerifierStatus`) and the verifier-gate evaluation (STACK-AC-VERIFIER-GATE / merge-decision shims); earn-in consumes the observed `VerifierStatus`.
- The release DecisionRequest, the `debutAuthorized` field, and the Release Ledger persistence (STACK-AC-RELEASE, amended for the debut field); earn-in only reads the recorded authorization.
- The integrate-handler wiring, `decideMerge`, and the post-landing observation plumbing themselves (STACK-AC-CONTROL-PLANE / phases.ts); earn-in defines the mint/trigger seams that hook into them.
