---
id: STACK-AC-VERIFIER-GATE
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-VERIFIER-GATE
code_paths: []  # DEFERRED to implementation — the path-existence validator requires real files; paths land with the impl PR (new sibling module under control-plane/lane-engine/verifier-gate/)
test_paths: []  # DEFERRED to implementation — colocated *.test.ts added with the impl PR
---

# STACK-AC-VERIFIER-GATE — Verifier Gate (TypeScript)

## Pattern

**A pure precondition function evaluated before lane eligibility, fail-closed by construction.** The verifier gate is `evaluateVerifierGate(lane, verifierStatus) → VerifierGateResult`, a pure function over `(VerifierDeclaration | undefined, VerifierStatus) → result` with no I/O on the decision path — the same shape as the lane-engine's `evaluateTripwire` / `applyRiskPathFloor`. I/O lives at the edges: the `VerifierDeclaration` is parsed once at pack activation (zod, beside the lane schema), and the `VerifierStatus` is observed by the platform's verifier-observation plumbing and passed in. The gate itself never runs a verifier, never reads config, never writes state.

**Fail-closed discriminated union with a default-deny shape.** The result is `{ kind: 'verifier-gated' } | { kind: 'assist-and-escalate'; reason }`. The *only* way to reach `'verifier-gated'` is a present, runnable, falsifying verifier; every other path — including the `undefined` declaration, an unobservable status, and a non-falsifying oracle — returns `'assist-and-escalate'` with a `reason`. There is no `null`, no boolean, and no thrown error on policy questions (exceptions reserved for programmer error); a `default:` arm that returns assist-and-escalate makes "any doubt withholds autonomy" structurally true, not a code-review promise.

**Composed ahead of the lane engine, never inside it.** The control-plane wiring calls `evaluateVerifierGate` *before* `evaluateMergeEligibility` (and before any autonomous-purpose `assignLane`); only a `'verifier-gated'` result proceeds to the lane-engine path, after which compliance + earned-autonomy still apply on top. This keeps the lane-engine's pure functions ignorant of the verifier precondition — the gate is a sibling module, exactly like the scope tripwire is a step inside `evaluateMergeEligibility` rather than a config flag.

## Key Decisions

**`VerifierDeclaration` is an optional field on the lane config, validated at pack activation.** It lives beside `LaneDefinitionSchema` (STACK-AC-LANE-ENGINE) and is `.optional()` — absence is the default and means "not verifier-gated." Shape (illustrative; `kind` is data, the gate never trusts a self-asserted "isVerifier" flag):

```typescript
const VerifierKind = z.enum(['test-suite', 'integration', 'e2e', 'deployable-check', 'deterministic', 'independent-check']);
const VerifierDeclarationSchema = z.object({
  kind: VerifierKind,
  invoke: VerifierInvocationRef,   // how the oracle is run + how its verdict is observed
}).strict();
// on the lane: verifier: VerifierDeclarationSchema.optional()  // absent ⇒ assist-and-escalate
```

**`VerifierStatus` is observed input, not lane-asserted.** It is the runtime usability of the declared verifier — present, reachable/runnable, falsifying — produced by the verifier-observation plumbing and passed into the pure function. The gate never invokes the oracle; it consumes a `VerifierStatus` the same way the lane engine consumes a git-derived touched-path set. Modeling it as input keeps the gate pure and exhaustively testable.

**Falsifiability is a precondition, not a trust flag.** `'verifier-gated'` requires `status.present && status.runnable && status.falsifying`. A declared-but-non-falsifying oracle (one that cannot return a failing verdict on incorrect work) yields `reason: 'verifier-non-falsifying'` — identical treatment to absent. This encodes the L1/L2 rule that "a check that cannot fail is not a verifier."

**The gate is non-configurable — a sibling of the scope tripwire — so there is no policy object to read.** There is deliberately no `VerifierGatePolicy` zod schema and no config-pack key. The precondition is engine code, not pack data; nothing a deployment can write reaches it. This mirrors how the tripwire's unconditional evaluation is encoded in the engine, not exposed as a toggle.

**The result type withholds only; it can never grant.** `evaluateVerifierGate` returns at most `'verifier-gated'`, which means "do not withhold — proceed to the other gates." There is no `'granted'`/`'auto-merge'` arm: granting passage is the lane-engine + compliance + earned-autonomy path's job, applied *after* a `'verifier-gated'` result. Earn-in and Operator-grant widening (STACK-AC-LANE-ENGINE's `evaluateEarnIn` / the merge-decision path) must gate their promotion on a `'verifier-gated'` result first — a verifier-less lane is structurally unreachable by promotion.

**Plug-in point: a new sibling module under `control-plane/lane-engine/`.** The intended layout is a `verifier-gate/` sibling (e.g. `control-plane/lane-engine/verifier-gate/{types,schema,evaluate,index}.ts`) — pure module, no daemon imports — wired into the integrate-phase path *before* `eligibility.ts` runs. Final paths are deferred (frontmatter `code_paths: []`) until the implementation PR lands real files.

## Examples

```typescript
type VerifierGateResult =
  | { kind: 'verifier-gated' }
  | { kind: 'assist-and-escalate';
      reason: 'no-verifier' | 'verifier-unusable' | 'verifier-non-falsifying' | 'evaluation-indeterminate' };
```

```typescript
function evaluateVerifierGate(
  declaration: VerifierDeclaration | undefined,
  status: VerifierStatus,
): VerifierGateResult {
  if (!declaration) return { kind: 'assist-and-escalate', reason: 'no-verifier' };
  if (!status.observed) return { kind: 'assist-and-escalate', reason: 'evaluation-indeterminate' };
  if (!status.runnable) return { kind: 'assist-and-escalate', reason: 'verifier-unusable' };
  if (!status.falsifying) return { kind: 'assist-and-escalate', reason: 'verifier-non-falsifying' };
  return { kind: 'verifier-gated' };
}
```

```typescript
// Composition at the integrate path: the gate runs BEFORE lane eligibility.
const gate = evaluateVerifierGate(lane.verifier, verifierStatus);
if (gate.kind !== 'verifier-gated') return assistAndEscalate(gate.reason); // lane-engine result is moot
const eligibility = evaluateMergeEligibility(input);  // tripwire/floor/policy still apply on top
```

## Gotchas

- The `default`/last branch must return assist-and-escalate, never `'verifier-gated'`. Order the guards so the *only* fallthrough to `'verifier-gated'` is the fully-checked happy path; a future added `VerifierStatus` field must not silently become a pass. Test the indeterminate and partial-status cases explicitly.
- Never trust a lane-asserted "this is a verifier" boolean. Falsifiability comes from the observed `VerifierStatus`, not from the declaration — a pack author can write `kind: 'test-suite'` for a no-op; only `status.falsifying` makes it count.
- Run the gate *before* `assignLane`/`evaluateMergeEligibility` for any autonomous purpose, not after. If it runs after eligibility, a momentary code path could act on a positive eligibility result before the precondition is checked — invert it and the lane-engine result is correctly moot when autonomy is withheld.
- Do not duplicate compliance or earned-autonomy checks here, and do not add a `'granted'` arm. The gate only *declines to withhold*; mixing in grant logic re-introduces the drift the lane-engine spec warns about (`cap()` / earned-autonomy belong to the merge-decision caller).
- A verifier that *was* usable is not cached as usable. Re-evaluate `VerifierStatus` on every attempt — a verifier that goes unreachable mid-life must drop the lane to assist-and-escalate on the next evaluation (`reason: 'verifier-unusable'`), never coast on a prior pass.
- There is no config toggle to add, ever. If a future pack field looks like it would "enable/disable the verifier gate," that is the non-configurability boundary being violated — the precondition is engine-owned, a sibling of the tripwire.
- Record the `VerifierGateResult` (and its reason) to run state for audit, but recording is the caller's side-effect, not the pure function's; if recording fails, fail closed (treat as assist-and-escalate), do not proceed on an unrecorded precondition outcome.

## Concerns This Spec Does Not Cover

- How a verifier is actually invoked and its verdict observed (the `VerifierStatus` producer) — the verifier-observation plumbing owns that; this spec consumes a `VerifierStatus`.
- Lane assignment, tripwire, risk-path floor, gate-set selection, and merge policy (STACK-AC-LANE-ENGINE governs these; the verifier gate composes ahead of them).
- Compliance-gate evaluation and the earned-autonomy state store (merge-decision / fleet implementations apply these *after* a `'verifier-gated'` result).
- Earn-in promotion mechanics and the Operator-grant path (STACK-AC-LANE-ENGINE / merge-decision); this spec only fixes that promotion is reachable solely for a `'verifier-gated'` lane.
- Config-pack loading, versioning, and activation (FUNC-AC-PLUGINS chain); this spec only consumes a parsed, validated `VerifierDeclaration`.
- The integrate-phase FSM wiring, run-state persistence schema, and Postgres records (Plan-2 pipeline integration, mirroring the lane-engine's deferred integration concerns).
