# Plan — Merge-Decision Integration (FUNC-AC-MERGE-DECISION Plan 2)

Wire lane-engine + verifier-gate into the live merge path, reading config from the
deployment-registry. Decomposed into **5a (pure decision core)** and **5b (live wiring)**.

## Load-bearing facts (from code recon)
- ONE code-merge point for both feature + spec pipelines: the `integrate` handler at
  `phases.ts:1746` (calls `integrateToStaging`). `l2-gate` is spec-*authoring* approval, NOT code merge.
- Pure modules (`lane-engine/`, `deployment-registry/`) are merged but unimported by daemon/phases/config — this is their first consumer.
- Classifier (`classifier-schema.ts` → `classifier.ts` → `phases.ts:1055`) emits only `complexity`; needs `changeKind` + `scope`.
- Decision-escalation emit pattern to REUSE: `decisionManager.isEnabled()` → `ledger().raise` → publisher `.ensure` → `ledger().notify`, epoch-gated, fail-closed (l2-gate handler ~701-734 is the template). Decision `risk_class` is `P0..P3` (≠ lane `green..red`) → mapping needed.

## 5a — PURE decision core (this sub-slice; zero blast radius; gateable)

New module `control-plane/merge-decision/`:
- `types.ts` — `MergeDecisionInput`, `MergeDecision` union, `MergeDecisionReason`.
- `decide.ts` — `decideMerge(input): MergeDecision` (pure; no I/O).
- `risk-class.ts` — `toDecisionRiskClass(level: RiskLevel): 'P0'|'P1'|'P2'|'P3'`.
- `index.ts` + immovable tests (`decide.test.ts`, `risk-class.test.ts`).

Additive Plan-1 edits (2-line, schema-test gated): add `verifier?: VerifierDeclaration` to
`LaneDefinition`/`ResolvedLane` (`lane-engine/types.ts`) + `LaneDefinitionSchema` (`lane-engine/schema.ts`).
Classifier-schema extension: add `changeKind` enum + `scope` string to `ClassificationSchema`.

### decideMerge signature + MergeDecision
```
interface MergeDecisionInput {
  laneSet; riskPathMap; defaultMinLevel; mode: string;
  verdict: ClassifierVerdict | null; classifierLevel: RiskLevel;
  touchedPaths: string[]; verifierStatus: VerifierStatus;
  autonomyWidened: (level: RiskLevel) => boolean;   // human-gated default ⇒ false
  complianceForced: boolean;
}
type MergeDecision =
  | { kind:'auto-merge'; lane; effectiveRisk; mergePolicy; assignment; eligibility; verifierGate; modeResolution }
  | { kind:'escalate'; reason: MergeDecisionReason; lane; effectiveRisk; assignment; eligibility?; verifierGate; modeResolution }
  | { kind:'hold'; reason:'awaiting-independent-review'; lane; effectiveRisk; mergePolicy:'review-then-auto'; ... };
```

### Precedence (FIRST match wins; fail-safe, most-cautious):
1. verifier gate ≠ verifier-gated → escalate `verifier-withheld` (gate runs FIRST, per verifier-gate spec ordering).
2. `complianceForced` → escalate `compliance-forced`.
3. tripwire out-of-scope → escalate `out-of-scope`.
4. assignment `fallback-most-cautious` → escalate `lane-fallback-most-cautious`.
5. effectiveRisk orange/red OR capped mergePolicy `hold` → escalate `risk-ineligible` (red never earnable).
6. `!autonomyWidened(effectiveRisk)` → escalate `autonomy-not-widened`  **← SAFE-BY-DEFAULT arm**.
7. eligible + widened + policy `review-then-auto` → hold `awaiting-independent-review`.
8. eligible + widened + policy `auto` → **auto-merge**.
9. fall-through → escalate `autonomy-not-widened` (structural default-deny).

Sequence inside: `resolveForMode` → `assignLane` → resolve `ResolvedLane` by name →
`evaluateVerifierGate(lane.verifier, verifierStatus)` → `evaluateMergeEligibility({...})` → precedence.

### 5a invariants to gate (mirror MERGE-DECISION success criteria):
- With `autonomyWidened` always false, NO input yields `auto-merge`.
- green + verifier-gated + in-scope + NOT widened → escalate (not auto-merge).
- red never `auto-merge` even when widened.

## 5b — LIVE wiring (next sub-slice; Claude + codex; minimize edits)
- `classifier.ts` threads changeKind/scope; `phases.ts` classify writes `run.classifierChangeKind/Scope`.
- `RunState` (+`classifierChangeKind?`, `classifierScope?`, `deploymentId?`, `mergeDecision?`, `mergeDecisionEpoch?`, `mergeDecisionBlockPublished?`).
- `phases.ts` `integrate`: resolve registry inputs (not-found/no-registry → escalate, safe) → computeTouchedPaths (git merge-base diff) → observeVerifierStatus (conservative shim, fail-closed) → readAutonomyState → `decideMerge` → branch: auto-merge → existing `integrateToStaging`; escalate/hold → park (`pausedAtPhase='integrate'`) + emit DecisionRequest via the l2-gate pattern (`buildMergeDecisionRequest`, pure, sibling to buildL2GateRequest).
- `daemon.ts`: build `DeploymentRegistry` at boot, register `config.deployment` (fail → empty registry → all escalate); set `run.deploymentId` at run creation + resume; thread registry into both `createPhaseHandlers` sites.
- `config.ts`: optional `deployment` block (id, laneSet, riskPathMap, defaultMinLevel, lifecycleMode, complianceReviewers).
- Enablement flag: flag-OFF or no `config.deployment` → `integrate` keeps unconditional `integrateToStaging` (byte-identical to today). Behavior changes only when a deployment is configured.
- New live shims: `observe-verifier.ts` (fail-closed default), `touched-paths.ts` (git diff). `buildMergeDecisionRequest` is pure.
- Confidence check: one integrate-handler integration test (registry + stubs) — (a) not-widened → parks, no merge; (b) widened green in-scope verifier-gated → integrateToStaging called. Flag-OFF byte-identity test.

## Deferrals (named)
recordOutcome/track-record DB persistence; earn-in wiring + auto-promotion; window-scheduler→resolve() (task #13);
real compliance-gate dispatch (complianceForced is a boolean input here); real verifier-observation plumbing
(shim fails closed); post-merge batch review; lifecycle-mode transition requests; lane roleRouting → session
dispatch (steering slice #6).

## Verify
Pure: `pnpm --filter @auto-claude/daemon exec vitest run src/control-plane/merge-decision` + lane-engine schema tests.
Live (5b): tsc + the integrate integration test + flag-OFF byte-identity + boot smoke.
