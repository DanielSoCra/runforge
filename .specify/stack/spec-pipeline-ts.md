---
id: STACK-AC-SPEC-PIPELINE
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-SPEC-PIPELINE
code_paths:
  - packages/daemon/src/control-plane/spec-pipeline/
  - packages/daemon/src/control-plane/spec-pipeline/variant.ts
  - packages/daemon/src/control-plane/spec-pipeline/gate.ts
  - packages/daemon/src/control-plane/spec-pipeline/spec-chain.ts
  - packages/daemon/src/control-plane/spec-pipeline/park.ts
  - packages/daemon/src/control-plane/spec-pipeline/context.ts
test_paths:
  - packages/daemon/src/control-plane/spec-pipeline/**/*.test.ts
---

# STACK-AC-SPEC-PIPELINE — Spec-Driven Pipeline Variant (TypeScript)

## Pattern

**Pipeline variant as a static phase definition.** The spec-driven variant is a `PipelineDefinition` object registered alongside `feature`, `feature-simple`, and `bug` in the control plane's variant registry. The phase sequence, transition rules, and per-phase config are declared as a frozen literal — no runtime construction. The control plane FSM executes it using the same `TransitionTable` mechanism defined in STACK-AC-CONTROL-PLANE.

**Gate evaluation as a label-checking function.** Each gate phase maps to a pure function `(labels: string[], commentsSinceGate: Comment[]) => GateOutcome`. Three outcomes: `approved` (forward transition), `feedback` (backward transition with extracted feedback), `unchanged` (remain parked). No side effects — the FSM acts on the returned outcome.

**Spec chain as a growing value object.** The spec chain is a plain array of `SpecReference` entries that grows as the pipeline progresses. Each entry records layer, spec ID, file path, and branch. The chain is stored in `RunState` and passed as context to every session and delegated phase. Validated with Zod before each phase transition.

**Park state as a RunState extension.** When a gate phase returns `unchanged`, the FSM writes a `ParkState` record into `RunState` and skips the run on subsequent poll cycles (no session spawned, no cost). The poll loop re-evaluates parked runs by calling the gate function on each cycle.

**Context assembly per phase type.** A `buildPhaseContext` function reads the spec chain entries from disk, loads feedback from gate history, and assembles a typed context object for the target session or service. Each phase type has a known context shape — no generic context bag.

## Key Decisions

**Location: Subdirectory of control-plane, not a separate package.** The L2 states this variant "IS PART OF" the Daemon Control Plane. Implemented as `packages/daemon/src/control-plane/spec-pipeline/` — a module within the control plane package, not a standalone service. This matches how built-in variants (feature, feature-simple, bug) are structured.

**Phase definition: Frozen literal object.** The ten-phase sequence (detect, l2-design, l2-gate, l3-generate, l3-compliance, implement, review, holdout, integrate, report) is a `const` declaration with `as const` assertion. Chosen over config file because the phase sequence requires code review to change (it defines the pipeline's correctness contract), and TypeScript catches typos in phase names at compile time.

**Gate outcome: Discriminated union.** `GateOutcome` is `{ status: 'approved' } | { status: 'feedback'; content: string } | { status: 'unchanged' }`. Exhaustive switch on `status` field. Chosen over boolean (need three states) and over numeric codes (readability).

**Spec chain validation: Zod schema with layer-conditional rules.** Before entering l2-design: chain must have L1. Before l3-generate: chain must have L1 + L2. Before implement: chain must have L1 + L2 + L3. A single `validateChainForPhase(chain, phase)` function applies the correct Zod schema based on the target phase. On validation failure: transition to stuck.

**Label mapping: Explicit constant map.** A `Record<SpecPhase, { inProgress: string; approval: string; feedback: string }>` maps each phase to its GitHub label names. Keeps label strings in one place — gate evaluation and label-writing both reference this map. Label names match the existing Phase 1 convention (e.g., `l2-approved`, `l2-in-progress`).

**Feedback extraction: Comments-since-timestamp.** Gate phases extract feedback by filtering issue and PR review comments with `created_at` after the last gate event timestamp stored in gate history. Uses Octokit's `listComments` with `since` parameter. The feedback is concatenated into a single string for the session context.

**Gate timeout: Configurable duration with reminder.** Default 7 days. On expiry: post a reminder comment via Octokit, emit a notification webhook event. The run stays parked — timeout is informational, not a failure. Timeout is checked on each poll cycle by comparing `parkState.parkedAt` against `Date.now()`.

**Feedback loop cap: Counter in gate history.** Each gate phase tracks iteration count in `RunState.gateHistory`. If a gate phase cycles through feedback more than `config.maxGateIterations` (default 5) times, transition to stuck. Prevents infinite design loops.

**Variant selector: Label + body marker.** Work requests are routed to `spec-driven` when the issue has the `feature-pipeline` label and the body contains a spec chain reference (an L1 spec path). This keeps detection simple and visible — Operators control routing by adding or omitting the label.

## Examples

```typescript
// Phase definition — frozen literal with phase types
const specDrivenPhases = [
  { name: 'detect', type: 'session' as const, sessionType: null },
  { name: 'l2-design', type: 'session' as const, sessionType: 'l2-designer' },
  { name: 'l2-gate', type: 'gate' as const, approval: 'l2-approved', feedback: 'l2-in-progress' },
  { name: 'l3-generate', type: 'session' as const, sessionType: 'l3-generator' },
  { name: 'l3-compliance', type: 'session' as const, sessionType: 'compliance-reviewer' },
] as const;
```

```typescript
// Gate evaluation — pure function, three outcomes
function evaluateGate(
  labels: string[], commentsSince: Comment[], approval: string, feedback: string,
): GateOutcome {
  if (labels.includes(approval)) return { status: 'approved' };
  if (labels.includes(feedback) && commentsSince.length > 0)
    return { status: 'feedback', content: commentsSince.map(c => c.body).join('\n---\n') };
  return { status: 'unchanged' };
}
```

```typescript
// Spec chain — growing value object validated per phase
interface SpecReference { layer: 'l1' | 'l2' | 'l3'; specId: string; filePath: string; branch: string }
type SpecChain = SpecReference[];

function validateChainForPhase(chain: SpecChain, phase: string): boolean {
  const layers = new Set(chain.map(s => s.layer));
  if (phase === 'l2-design') return layers.has('l1');
  if (phase === 'l3-generate') return layers.has('l1') && layers.has('l2');
  if (phase === 'implement') return layers.has('l1') && layers.has('l2') && layers.has('l3');
  return true;
}
```

```typescript
// Park state — extends RunState, checked on each poll cycle
interface ParkState {
  parkedAt: number;       // Date.now() when parked
  gatePhase: string;      // which gate phase
  deliverable: string;    // spec file path or PR URL
  approvalLabel: string;  // label that unparks forward
  feedbackLabel: string;  // label that triggers re-design
}
```

```typescript
// Context assembly — reads spec files from chain, includes feedback
async function buildL3Context(chain: SpecChain, feedback?: string): Promise<L3SessionContext> {
  const l1 = await readFile(chain.find(s => s.layer === 'l1')!.filePath, 'utf-8');
  const l2 = await readFile(chain.find(s => s.layer === 'l2')!.filePath, 'utf-8');
  return { l1Content: l1, l2Content: l2, existingL3Specs: await loadL3Specs(), feedback };
}
```

## Gotchas

- The phase names in the variant definition must match the transition table keys in STACK-AC-CONTROL-PLANE. If the control plane FSM uses a `Record<Phase, ...>` type, extending the `Phase` union to include spec-driven phases requires updating the shared type definition. Keep the phase union in a shared types file.
- Gate evaluation calls Octokit on every poll cycle for parked runs. At 30-second intervals with multiple parked runs, this adds up. Use conditional requests (`If-None-Match` / ETags) to avoid burning API quota on unchanged label state.
- The `since` parameter on `listComments` is inclusive — comments at exactly the timestamp are included. Store the gate event timestamp as the comment's `created_at` plus one millisecond to avoid re-reading the same feedback on the next iteration.
- Spec chain file paths are relative to the repo root. When reading spec content for context assembly, resolve against the working directory. If the session is running in a worktree, the path must resolve correctly in that worktree — pass the worktree root as a parameter.
- Park state is persisted in the RunState JSON file. If the daemon restarts, parked runs resume correctly because the park state survives. However, the Octokit ETag cache (in-memory) is lost — the first poll after restart will make unconditional API calls for all parked runs.
- The `spec-driven` variant selector checks for both the `feature-pipeline` label and a spec chain reference in the body. If an Operator adds the label but forgets the spec reference, the variant selector falls through to the default variant. Log a warning when `feature-pipeline` is present but no spec reference is found.
- L3 compliance failure with max retries transitions to stuck, but the L3 branch may still have an open PR. The stuck handler should comment on the PR explaining the block, not silently abandon it.
- Gate history grows indefinitely for runs with many feedback iterations. Cap gate history at `maxGateIterations + 1` entries and trim oldest entries on overflow. The history is only used for timestamp-since queries and iteration counting — old entries are not needed.
