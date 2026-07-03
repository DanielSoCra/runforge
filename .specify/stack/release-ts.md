---
id: STACK-AC-RELEASE
type: stack-specific
domain: auto-claude
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-RELEASE
code_paths:
  - scripts/release.sh
  - packages/daemon/src/control-plane/release/types.ts
  - packages/daemon/src/control-plane/release/proposal.ts
  - packages/daemon/src/control-plane/release/build-request.ts
  - packages/daemon/src/control-plane/release/executor.ts
  - packages/daemon/src/control-plane/release/release-ledger-manager.ts
  - packages/daemon/src/control-plane/release/resolve-consumer.ts
  - packages/release-ledger/src/index.ts
  - packages/release-ledger/src/db.ts
  - packages/release-ledger/src/ledger.ts
  - packages/release-ledger/src/migrate.ts
  - packages/release-ledger/src/schema.ts
test_paths:
  - scripts/test-release-dry-run.sh
  - packages/daemon/src/control-plane/p5-release-lane.gate.test.ts
  - packages/daemon/src/control-plane/p5-release-ledger.gate.test.ts
  - packages/daemon/src/control-plane/release/proposal.test.ts
  - packages/daemon/src/control-plane/release/build-request.test.ts
  - packages/release-ledger/test/store.test.ts
  - packages/release-ledger/test/ledger.test.ts
  - packages/release-ledger/test/marker.test.ts
---

# STACK-AC-RELEASE — Per-Deployment Release Lane (TypeScript)

> **Scope.** The daemon Control-Plane orchestration for FUNC-AC-RELEASE v2 / ARCH-AC-RELEASE v2: per-deployment proposal assembly, an append-only per-deployment **Release Ledger** (Postgres, mirroring `@auto-claude/decision-index`), a 4th `DecisionRequest` builder (phase `'release'`, approve/reject) raised through the existing raise → publish → notify seam, an upgraded `landing.productionReleasePath` discriminated 3-shape union that is *actually consumed*, and a 3-shape executor with preview-before-change and fail-safe. The bash `scripts/release.sh` is retained (and stays in `code_paths` until the TS lane lands) as the **reference implementation for the platform-performs shape** — the platform's own deployment. This spec owns no second source of live-state truth: the Last-Released Marker is derived from the ledger, never stored twice. `code_paths` list only files that exist today; the net-new TS paths are added when the lane is implemented.

## Pattern

**A daemon-orchestrated per-deployment release lane that reuses the decision seam and the decision-index store pattern, rather than a single ops shell script.** v1 was `scripts/release.sh` — one Operator-run action against the launchd checkout, for the platform's own single deployment. v2 generalizes to every deployment, which needs per-deployment proposal aggregation, a durable per-deployment ledger, and the governed Operator-decision transport — all of which live in the daemon Control Plane. The lane is five collaborating pieces, each reusing an existing seam:

1. **Proposal assembly** — replaces the vestigial single-repo `packages/daemon/src/control-plane/release.ts` (`aggregateReleaseNotes` + `createReleaseProposal`, which is single-trunk-not-applicable and never passes `since`). v2 assembly is per-deployment: read the deployment's Last-Released Marker from its ledger, diff its trunk since that marker, and gather exactly the accepted-but-unreleased work.
2. **Release Ledger** — a new append-only per-deployment Postgres store following the `@auto-claude/decision-index` writer/read-model shape (see Key Decisions), fronted by a per-deployment manager exactly like `DecisionEscalationManager`.
3. **The 4th decision builder** — `buildReleaseDecisionRequest` (phase `'release'`, options `approve`/`reject`), mirroring `buildMergeDecisionRequest` (`control-plane/merge-decision/build-request.ts:84`) and `buildReversalDecisionRequest` (`control-plane/revert-lane.ts:78`).
4. **The declared release path** — `landing.productionReleasePath` upgraded from `z.string().min(1)` (schema.ts:98, currently zero non-test readers) to a `z.discriminatedUnion` of three shapes, consumed by the executor and the preview.
5. **The 3-shape executor** — carries out the declared path on approval, with preview-before-change and fail-safe (platform-performs rollback modelled on `scripts/release.sh`).

## Key Decisions

- **Release Ledger is an append-only EVENT journal, mirroring `@auto-claude/decision-index`'s `audit_log`.** A `pgSchema("release_ledger")` (drizzle + `postgres-js`) with one append-only table keyed by a `bigint generatedAlwaysAsIdentity()` id (the `audit_log` shape in `packages/decision-index/src/schema.ts:105`): `release_id`, `deployment`, `event` (`proposal`/`decision`/`execution`/`completion`), `detail_json` (carries the proposal, or the `approved`/`rejected` answer, or the outcome `released`/`triggered-awaiting`/`recorded-awaiting-human`/`failed`), `target_revision`, `at`. A single release is the ordered run of events sharing a `release_id`; there is **no mutable per-release row**, so a proposal appended before the decision exists is just an earlier event — no nullable/pending columns are needed. A `createReleaseLedger({ databaseUrl })` factory does `openDb` + idempotent `migrate` (mirroring `createIndexWriter`, `index-writer.ts:94`), `databaseUrl` from `AUTO_CLAUDE_DATABASE_URL`. A per-deployment manager owns it and fails closed (`#broken`) exactly like `DecisionEscalationManager.init()` (`decision-escalation/manager.ts:91`). Export a writer facade + a read-only projection only (mirror `decision-index/src/index.ts`).
- **Last-Released Marker is derived, not stored.** It is the `target_revision` of the deployment's most recent `released` *event* — an `execution` or `completion` event whose outcome is `released` — one source of truth. The two handed-off outcomes (`triggered-awaiting`, `recorded-awaiting-human`) are **non-final** and do NOT advance the marker; only a `released` event does. The proposal's `since` base comes from this read (fixing `release.ts:85`, which never passes `since`).
- **The 4th builder mirrors the approve/reject builders.** Deterministic `decision_id === idempotency_key` (e.g. `release:${deployment}:${targetSha.slice(0,8)}` — re-proposing the same target is idempotent), `phase: 'release'`, options `[{id:'approve'},{id:'reject'}]`, `answer_schema:{kind:'option'}`, `risk_class:'P0'` (highest — a production release is the most consequential event), `reversibility:'external_effect'` (a production release has real-world effect the platform cannot unilaterally undo, true across all three shapes), `resume_mode:'requeue'`, closed with `DecisionRequestSchema.parse`. **Context/question carry only structured, known-safe text** — never raw commit bodies, handoff notes, or L2 feedback (the security invariant of `build-request.ts:23`).
- **Always raises, never earns autonomy — a policy gate, not a risk gate.** The release phase is deliberately NOT routed through the merge-style earn-in / auto-approve path. `proposeRelease` always assembles → appends the proposal → `ledger.raise` → publish → wait, at every level of earned or pre-approved autonomy. `risk_class` and `reversibility` do not gate this; the always-raise policy does.
- **Reuse the governed raise → publish → notify seam verbatim.** `sanitizeDecisionRequest(req)` → `withGovernedDecisionMarking(decisionManager, deploymentId, () => ledger.raise(sanitized))` → `resolveDecisionPublisher().ensure({request, octokit, owner, repo, issueNumber})` → on `posted`, `ledger.notify(decision_id)` (the governed merge-decision publish block, `phases.ts:2522`). No new transport.
- **`productionReleasePath` becomes a consumed discriminated union.** Three shapes (see Examples). The executor and preview read the declared shape via `readDeclaredData(id, 'landing')` (`deployment-registry/registry.ts:459`), fail-closed on missing/invalid mirroring `resolveLandingTarget` (`landing-target.ts:48`).
- **Executor fail-safe modelled on `scripts/release.sh`.** platform-performs: advance + restart under the supervisor, confirm live, and **record only after** the restart is confirmed; on failure roll back to the prior release marker and append an `execution` event of `failed` (never `released`) — the `scripts/release.sh:63-71` rollback pattern. trigger-automated: dispatch the declared target, append `triggered-awaiting`; if it cannot fire, append `failed`, nothing promoted. record-only: append `recorded-awaiting-human`, mutate nothing in production. For the two handed-off outcomes, a later `recordCompletion` appends a `completion` event resolving the release to `released` (marker advances) or `failed`.
- **v1 L3 disposition: retire `release-sh.md`; `release-ts.md` is the single STACK-AC-RELEASE node.** `scripts/release.sh` + `scripts/test-release-dry-run.sh` stay in this node's `code_paths`/`test_paths` as the existing platform-performs reference, so the real bash reference remains traced. The net-new TS paths (`packages/daemon/src/control-plane/release/**`, the release-ledger package) are added to `code_paths` when the lane is implemented.

## Examples

```ts
// (4) landing.productionReleasePath: z.string().min(1) → a consumed discriminated 3-shape union
z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('platform-performs') }).strict(),                              // reference: scripts/release.sh
  z.object({ kind: z.literal('trigger-automated'), trigger: z.string().min(1) }).strict(),  // fires the deployment's automation
  z.object({ kind: z.literal('record-only'), procedure: z.string().min(1) }).strict() ]);   // a human completes it
```

```ts
// (3) the 4th builder — mirror buildMergeDecisionRequest; id = `release:${deployment}:${targetSha.slice(0,8)}`
return DecisionRequestSchema.parse({ decision_id: id, idempotency_key: id, deployment, phase: 'release',
  risk_class: 'P0', reversibility: 'external_effect', resume_mode: 'requeue', answer_schema: { kind: 'option' },
  options: [{ id: 'approve', label }, { id: 'reject', label }], question, context /* structured-safe */ });
```

```ts
// always raises — reuse the governed seam; never route through merge earn-in / auto-approve
const sanitized = await sanitizeDecisionRequest(request);
const { decision_id } = await withGovernedDecisionMarking(decisionManager, deployment, () => ledger.raise(sanitized));
const published = await resolveDecisionPublisher().ensure({ request: sanitized, octokit, owner, repo, issueNumber });
if (published.posted) await ledger.notify(decision_id);   // then wait for the Operator; no autonomous resolve
```

## Gotchas

- **Preview never mutates production.** The proposal + the raised `DecisionRequest` *are* the preview; the Running Production System changes only on an approved platform-performs / trigger-automated execution. Appending the proposal to the ledger is fine (it is not a production change); touching production during preview is not.
- **Fail-safe is per shape.** platform-performs must restore the prior-live state on any failure and append an `execution` event of `failed` (the `scripts/release.sh:63-71` rollback) — never `released` for a release that did not confirm live. trigger-automated that cannot fire appends `failed`, nothing promoted. record-only never touches production; it appends `recorded-awaiting-human`. The two handed-off states are non-final: only a later `completion` event of `released` advances the Last-Released Marker, so what is live is never inferred from a mere hand-off.
- **Compute `since` per deployment — do not reuse the vestigial proposal.** `aggregateReleaseNotes` (`release.ts:38`) accepts a `since` but the current caller never passes it (`release.ts:85`), and `createReleaseProposal` is single-trunk-not-applicable (`release.ts:96`) and PR-model. v2 assembly must pass the per-deployment Last-Released Marker and gather that deployment's trunk diff; replace the module, don't extend it.
- **Never route release through earn-in.** There is no auto-approve path for phase `'release'`. Do not copy the merge auto-resolve branch; a release decision is always raised and only an Operator answer resolves it — regardless of how much autonomy the deployment earned.
- **Wrap `ledger.raise` in `withGovernedDecisionMarking`** (as the merge block does, `phases.ts:2522`) so a transport failure marks the deployment degraded and fails closed, rather than proceeding on partial state.
- **Single-writer ledger.** The Release Ledger store uses the same advisory-lock single-writer as decision-index (`decision-index/src/db.ts:131`); one writer per process, readers use the read-only projection. Fail closed if the store cannot init (mirror `DecisionEscalationManager` `#broken`); a release that cannot be recorded must not proceed.
- **Structured-safe decision context only.** Do not put raw commit bodies, handoff notes, or L2 feedback into the release decision `context`/`question` (the `build-request.ts:23` invariant) — carry only structured, known-safe fields (deployment, counts, target revision, covered issue numbers).
- **Idempotent decisions.** `decision_id === idempotency_key` keyed on `deployment` + target revision means re-proposing the same target yields the same decision, so a retried propose does not raise a duplicate.
