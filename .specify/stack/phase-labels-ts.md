---
id: STACK-AC-PHASE-LABELS
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-PHASE-LABELS
code_paths:
  - packages/daemon/src/control-plane/phase-labels.ts
test_paths:
  - packages/daemon/src/control-plane/phase-labels.test.ts
---

# STACK-AC-PHASE-LABELS — Phase Label Mirroring (TypeScript)

## Pattern

**Static PhaseLabelMap as a frozen `as const` object.** Maps the 8 labeled FSM phases to their `phase:*` label strings. Phases without labels (`detect`, `report`) are absent from the map — a lookup returning `undefined` is the skip signal, no separate guard needed. Chosen over a switch statement (concise, compile-time exhaustiveness) and over a runtime-built map (`as const` validates at compile time).

**Factory function `createPhaseLabelMirror(octokit, owner, repo)` returning a typed interface.** Keeps Octokit and owner/repo in a closure; callers thread one object, not three arguments per call. Follows the existing factory pattern in `work-detection.ts` (`createWorkDetector`) and `reviewer-session.ts`.

**Fire-and-forget via voided promise with internal try/catch.** Every Octokit call is wrapped in a helper that catches, logs structured context (issue number, phase, error), and returns `void`. The FSM never awaits label operations. Consistent with how `phases.ts` handles non-critical GitHub API calls (addLabels, createComment wrapped in try/catch).

**Integration: optional `phaseLabelMirror` parameter in `runPipeline`.** Mirrors the existing optional `runWriter?: SupabaseRunWriter` pattern. Called after each successful `advancePhase()` mutation of `run.phase`. `clearPhaseLabels` called at all stuck-transition sites in `pipeline.ts` and at the start of the `report` phase handler in `phases.ts` (before `completeWork`).

**`run.activePhaseLabel` updated synchronously before the network call.** RunState is the authoritative source of truth per ARCH-AC-PHASE-LABELS. Updating the field before the async call means crash recovery always sees the intended label, even if the network call never completed. The observability gap (label not yet on the issue) is acceptable; a RunState divergence is not.

## Key Decisions

**Single file `phase-labels.ts` in `control-plane/`.** Co-located with `pipeline.ts`, `phases.ts`, and `work-detection.ts` — all current label writers. A subdirectory would be premature for a single-concern module of this size.

**`RunState.activePhaseLabel?: string` in `types.ts`.** Optional string added alongside existing optional fields. Existing RunState JSON files without the field deserialize safely — JSON deserialization leaves the field `undefined`, which is the correct initial state. No migration script needed.

**Remove-then-add, not add-then-remove.** Removes the old label first (using `run.activePhaseLabel`), then adds the new one. A crash between the two leaves no `phase:*` label on the issue — corrected on FSM re-entry during crash resumption, which calls `applyPhaseLabel` again. An add-first approach risks two concurrent labels during the gap; remove-first risks zero — zero is the safer observability gap.

**`provisionLabels` creates 8 labels via `createLabel`, swallows HTTP 422.** 422 means the label already exists — treat as success. Fetching the label list to check existence first costs an extra API call per repository on every startup; swallowing 422 is cheaper and correct.

**Skip network call when both old and new labels are absent.** When transitioning between unlabeled phases (e.g., `detect` → `classify`), `oldLabel` is `undefined` and `newLabel` is the classify label — only `addLabels` runs, no remove. When transitioning from a labeled phase to an unlabeled one (e.g., `test` → `report`), `clearPhaseLabels` handles the remove; `applyPhaseLabel` for `report` does nothing.

**`PhaseLabelMirror` is optional in `runPipeline`.** Backward-compatible rollout: callers that don't provide it get the existing behavior with no phase labels.

## Examples

```typescript
// PhaseLabelMap — as const, absent keys return undefined (skip signal)
export const PHASE_LABEL_MAP = {
  classify: 'phase:classify', decompose: 'phase:decompose',
  implement: 'phase:implement', review: 'phase:review',
  holdout: 'phase:holdout', integrate: 'phase:integrate',
  deploy: 'phase:deploy', test: 'phase:test',
} as const satisfies Partial<Record<Phase, string>>;
```

```typescript
// Fire-and-forget helper — catches, logs, never propagates
function fireAndForget(fn: () => Promise<void>, ctx: string): void {
  void fn().catch((err) => console.error(`[phase-labels] ${ctx}:`, err));
}
```

```typescript
// applyPhaseLabel — RunState updated before network call (crash-safe ordering)
applyPhaseLabel(issueNumber: number, newPhase: Phase, run: RunState): void {
  const newLabel = PHASE_LABEL_MAP[newPhase as keyof typeof PHASE_LABEL_MAP];
  const oldLabel = run.activePhaseLabel;
  run.activePhaseLabel = newLabel;             // sync: RunState is source of truth
  if (!newLabel && !oldLabel) return;          // both unlabeled — skip entirely
  fireAndForget(async () => { /* remove old, add new via octokit */ }, `${newPhase}#${issueNumber}`);
},
```

```typescript
// provisionLabels — createLabel per phase label, swallow 422 (already exists)
for (const label of Object.values(PHASE_LABEL_MAP)) {
  await octokit.issues.createLabel({ owner, repo, name: label, color: '0075ca' })
    .catch((e: unknown) => { if ((e as { status?: number }).status !== 422) throw e; });
}
```

```typescript
// Integration in pipeline.ts — after advancePhase, before saveRunState
const advanced = advancePhase(run, table, event, maxAttempts, retryCounts);
if (!advanced) { run.phase = 'stuck'; phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run); }
else { phaseLabelMirror?.applyPhaseLabel(run.issueNumber, run.phase, run); }
await stateMgr.saveRunState(run);
```

## Gotchas

- `octokit.issues.removeLabel` returns HTTP 404 when the label is not present on the issue (distinct from the label not existing in the repo). Skip the remove call when `oldLabel` is `undefined` — calling remove with no prior label generates spurious 404 errors in logs even though the state is correct.
- The 8 `phase:*` labels must exist on each monitored repository before label operations will succeed. `provisionLabels` is called fire-and-forget from `daemon.ts` on startup per repository. If provisioning races with the first FSM transition, a label write may fail softly — corrected on the next phase transition.
- `PHASE_LABEL_MAP` is `Partial<Record<Phase, string>>` because `Phase` includes `detect`, `report`, `stuck`, `paused`, and others that have no phase label. Use `newPhase as keyof typeof PHASE_LABEL_MAP` to index safely without a type error. Do not widen the lookup — the `as const` inference on the map's values is what gives TypeScript the literal string types.
- `clearPhaseLabels` must be called before `completeWork`/`markStuck` apply their respective labels in `work-detection.ts`. The call order in `phases.ts` (report handler) and `pipeline.ts` (stuck paths) must remove the `phase:*` label before the `complete`/`stuck` label is applied — external tooling querying label state should never see both simultaneously.
- On crash resumption, `applyPhaseLabel` is called at FSM re-entry even when the phase hasn't changed. This is correct: it re-syncs the GitHub label to the RunState-persisted intent. Adding a label that's already present on the issue is idempotent at the GitHub API level (no error, no duplicate).
- `provisionLabels` runs sequentially (one `createLabel` at a time) rather than in parallel. This avoids a burst of 8 concurrent API calls on every daemon startup. At one call per startup per repository, the latency cost is negligible and the rate-limit cost is minimal.
- `PhaseLabelMirror` should be passed through from `daemon.ts` where both Octokit and owner/repo are available. Do not create the mirror inside `phases.ts` — the factory should be instantiated once per repository run, not once per phase handler invocation.
