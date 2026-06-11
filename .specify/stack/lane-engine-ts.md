---
id: STACK-AC-LANE-ENGINE
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-LANE-ENGINE
code_paths: []  # deferred until implementation — planned: packages/daemon/src/control-plane/lane-engine/ (schema.ts, assign.ts, tripwire.ts, track-record.ts)
test_paths: []  # deferred until implementation — planned: packages/daemon/src/control-plane/lane-engine/**/*.test.ts
---

# STACK-AC-LANE-ENGINE — Lane Engine (TypeScript)

## Pattern

**Declarative config parsed once, evaluated as pure functions.** Lane declarations arrive as data from the active config pack and are parsed at activation time with a zod schema into a frozen `LaneSet`. All evaluation — assignment, risk-path floor, tripwire — is pure functions over `(LaneSet, input) → result`, with no I/O inside the evaluation path. This mirrors the existing classifier-schema and workflow-registry patterns in the control plane: I/O at the edges (config load, git query, Postgres write), decisions in pure, exhaustively testable functions.

**Fail-closed sum types.** Every evaluation returns a discriminated union whose "cannot decide" arms carry a cause and map to the most-cautious treatment. There is no `null` return and no thrown error on policy questions; exceptions are reserved for programmer error.

**Tripwire as a deterministic git read.** Touched paths come from `git diff --name-only <merge-base>...<head>` run against the run's isolated branch by the existing workspace plumbing — never from the classifier verdict, the issue body, or session output. Pattern matching uses the same picomatch-style matching already used for containment path rules, so one glob dialect serves the whole codebase.

## Key Decisions

**Lane config schema lives beside the classifier schema and is validated at pack activation.** A pack with an invalid `lanes` block fails activation atomically (the deployment keeps its previous pack). Shape:

```typescript
const MergePolicy = z.enum(['auto', 'review-then-auto', 'hold']);
// Lifecycle-mode variance (FUNC-AC-MERGE-DECISION v2.1): gateSet and
// mergePolicy — and only those two fields — may be declared per mode.
const byMode = <T extends z.ZodTypeAny>(value: T) =>
  z.union([value, z.record(LifecycleModeName, value)]);

const LaneDefinitionSchema = z.object({
  name: z.string().min(1),
  qualify: z.object({ complexity: z.array(Complexity).optional(),
    changeKind: z.array(ChangeKind).optional() }),
  allowedPaths: z.array(z.string()).nonempty(), // never mode-variant
  roleRouting: z.record(PhaseName, RoleBindingRef),
  gateSet: byMode(GateSetRef),
  mergePolicy: byMode(MergePolicy),
  postMergeReview: BatchReviewPolicy.optional(),
  earnIn: EarnInPolicy.optional(), // all thresholds are pack data
});
```

**Lifecycle mode is resolved before evaluation, never inside it.** A `resolveForMode(laneSet, mode)` step flattens every per-mode map to plain values, producing a `ResolvedLaneSet` that the evaluation functions consume. The evaluation path (`assignLane`, `applyRiskPathFloor`, `evaluateTripwire`, `evaluateMergeEligibility`) never sees a mode parameter — so the tripwire and the risk-path floor *structurally cannot* vary by mode. The mode value is read from the deployment profile at the integration boundary (it is Operator-decision-written state; no engine code path writes it), recorded in the eligibility result and the `LaneDecisionRecord`. An unreadable mode, or a mode not in the pack's declared phase set, resolves every per-mode map to its most cautious declared variant (for `mergePolicy`: the most cautious of the declared variants by `hold > review-then-auto > auto`) with a recorded degraded-resolution cause; a lane referencing an undeclared phase fails pack validation at activation.

**Classifier integration extends the existing verdict, no second classifier.** The batch classifier's structured output gains the fields lane qualification matches on (`changeKind`, declared scope); `assignLane(laneSet, verdict)` is a pure function over that verdict. Ambiguity (0 or 2+ matches) returns the deployment's `mostCautiousLane` with a recorded cause.

**Evaluation order at integrate is fixed and non-configurable:** risk-path floor first (raise-only), then tripwire, then gate-set selection, then merge policy — and compliance gate + earned-autonomy state are applied *after* the engine's result by the existing merge-decision path. Encoding the order in one function keeps "no config can suppress the tripwire" structurally true:

```typescript
function evaluateMergeEligibility(input: EligibilityInput): Eligibility {
  const floor = applyRiskPathFloor(input);            // raise-only
  const tripwire = evaluateTripwire(input.touchedPaths, input.lane);
  if (tripwire.kind !== 'in-scope') return escalate(tripwire, floor);
  return { gateSet: input.lane.gateSet, mergePolicy: cap(input.lane.mergePolicy, floor) };
}
```

**Escalate-only floor implemented as a max, not a merge.** Risk levels are ordered (`green < yellow < orange < red`); the floor computes `max(classifierLevel, ...matchedFloorLevels)` so no map entry can ever lower a level.

**Persistence via existing run-state and Postgres stores.** `LaneAssignment` and `TripwireVerdict` are new fields on the run state (versioned via the existing run-state migration pattern); `LaneTrackRecord` and `LaneDecisionRecord` are Postgres tables written through the daemon's data layer. `recordOutcome` runs in the same transaction boundary as the disposition label write — disposition blocks on record, not vice versa.

**Supersedes the #679 risk-class-rules design.** The standalone risk-class rules module proposed there is not built; its intent (per-repo path→class config) survives as the `RiskPathMap` input to this engine. The implementation phase closes #679 linking here.

## Examples

```typescript
function evaluateTripwire(touched: string[], lane: LaneDefinition): TripwireVerdict {
  const outside = touched.filter((p) => !matchesAny(p, lane.allowedPaths));
  return outside.length === 0
    ? { kind: 'in-scope', touched }
    : { kind: 'out-of-scope', touched, outside };
}
```

```typescript
function applyRiskPathFloor(input: EligibilityInput): RiskLevel {
  const floors = input.riskPathMap
    .filter((e) => input.touchedPaths.some((p) => matchesAny(p, e.paths)))
    .map((e) => e.minLevel);
  return maxRiskLevel(input.classifierLevel, ...floors); // raise-only by construction
}
```

```typescript
type LaneAssignmentResult =
  | { kind: 'assigned'; lane: string; reasons: string[] }
  | { kind: 'fallback-most-cautious'; cause: 'no-match' | 'ambiguous' | 'verdict-unavailable' };
```

## Gotchas

- Compute touched paths from the merge-base diff (`merge-base...head`), not `HEAD~n` or the working tree — fix-cycle commits and rebases otherwise hide or duplicate paths. Re-evaluate on every integrate attempt; never reuse a prior attempt's verdict.
- Renames must surface both sides: use `--name-only` with rename detection disabled (or expand `R` records to old+new path) so a file moved *out of* allowed scope cannot slip through as its old name.
- `mergePolicy: 'auto'` is a lane's *request*, not a grant — always `cap()` it by the effective risk level and leave earned-autonomy and compliance checks to the merge-decision caller. Do not duplicate those checks inside the engine (drift risk).
- Empty `allowedPaths` is rejected by schema (`nonempty`), because an empty allowlist would make every change out-of-scope and look like a tripwire storm instead of the config error it is.
- In-flight runs pin the pack version recorded in their `LaneAssignment`; never read the "current" pack inside evaluation functions — pass the resolved `LaneSet` in.
- The track-record predicate (earn-in) runs over recorded outcomes only; meeting it raises a DecisionRequest via the existing decision-escalation emitter — there is no code path that flips an autonomy flag directly.
- The lifecycle mode is the same kind of Operator-decision-gated state as earned autonomy: read it from the deployment profile, record which mode each evaluation ran under, and never add a code path that transitions it — a proposed transition is a DecisionRequest, the recorded grant updates the profile, the engine merely reads the new value.

## Concerns This Spec Does Not Cover

- Gate execution (STACK-AC-VALIDATION governs how the selected gate set runs).
- Compliance-gate evaluation and the earned-autonomy state store (merge-decision / fleet implementations).
- The config-pack loading, versioning, and activation lifecycle (FUNC-AC-PLUGINS chain; this spec only consumes a parsed, validated `LaneSet`).
- Post-merge batch-review session mechanics (dispatched through the ordinary pipeline; only the accumulation trigger and the track-record append live here).
