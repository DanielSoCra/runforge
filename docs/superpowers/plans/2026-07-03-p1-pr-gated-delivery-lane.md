# P1 — PR-Gated Single-Trunk Delivery Lane: Implementation Plan

> **⏸ BUILD-READY, PENDING OPERATOR GATE #1 (D2).** This plan implements the code-change PR delivery lane specified by the L1 deltas (**PR #822**, `FUNC-AC-CONTROLLED-ARTIFACT-DELIVERY` v2) + L2/L3 chain (**PR #823**, `ARCH`/`STACK-AC-CONTROLLED-ARTIFACT-DELIVERY` v2), which are **`draft`, awaiting the Operator's approval**. Do NOT build/gate/merge P1 code until #822 is Operator-approved — building against unratified L1 content would cross the reserved gate. This plan is pre-staged so that the moment D2 lands, the gate + build run with zero planning latency. Base branch on build: `spec/p1-delivery-chain` (rebased onto `main` once #822→#823 merge). Build branch: `codex/p1-delivery-lane-build`.
>
> Expansion of program-plan Phase 1 + P1.5. Line anchors verified 2026-07-03 @ origin/main 1aab22f / spec chain b9059cd — grep for symbols, never trust line numbers.

## Scope

Replace the raw `git merge --no-ff` in the integrate handler with a **PR-gated, risk-class-gated GitHub-API merge** for code changes, consuming `landing.landsOn` as the target trunk; add **await-required-checks**, **post-landing trunk observation**, and a **fail-closed auto-revert lane** (P1.5); quarantine the inert merge-agent scaffolding. Mirror the proven spec-artifact PR path. Governed by the approved-once-D2-lands `FUNC-AC-CONTROLLED-ARTIFACT-DELIVERY` v2 (+ ARCH/STACK v2).

## Ground truth (verified 2026-07-03)

- **Integrate handler** `phases.ts:1944-2287`. Flag-OFF (no deployment, :1986-2019) and even the governed **auto-merge arm** (:2143-2192) both call `integrateToStaging(featureBranch, config.branches.staging, mainRepoRoot)` — a **raw local `git merge --no-ff` + push** (`integration.ts:29-88`, merge at :45-48, target branch is a plain string param). `decideMerge` (`merge-decision/decide.ts:31-156`) returns `auto-merge|hold|escalate` (rule 5 escalates orange/red). Escalate/hold (:2194-2286) parks at `integrate` + raises via `buildMergeDecisionRequest`/`ledger.raise`/`GitHubBlockPublisher` (:2242-2265).
- **Mirror target** `phases.ts:353-377` `mergeL2Proposal`: `octokit.pulls.merge({owner,repo,pull_number,merge_method:'squash'})`, try/catch, never throws. PR-creation half in `spec-pipeline/delivery.ts:406` (`createProposal`). **No checks-polling in this path** — it merges immediately on label. Test mock: hand-built `mockOctokit` (`phases.test.ts:285-296`) with `issues.*` + `pulls.merge` only.
- **`landing`**: `LandingTarget = {landsOn, productionReleasePath}` (`deployment-registry/types.ts:64-67`), on `DeploymentProfile.landing` (:115), validated, accessor `registry.readDeclaredData(id,'landing')` (`registry.ts:459-465`) works (same pattern live for `gateSets`/`complianceReviewers` at `phases.ts:2072-2126`) — but **zero non-test consumers**. `readDeclaredData(...).value` is typed **`unknown`** (`types.ts:241`) → must narrow + fail closed.
- **Octokit/checks**: token via `repoManager.resolveTokenForRepo(id)` else `process.env.GITHUB_TOKEN` (`daemon.ts:2256-2260`); handlers receive `octokit` injected. **No checks-polling helper exists anywhere** (grep `checks.listForRef`/`mergeable_state` → 0); closest shape is `validation/deploy.ts:200-219` `pollHealth` (budget-loop). **No branch-protection code exists** — required-checks enforcement is 100% the daemon's own polling, not a GitHub backstop. STACK spec mandates the daemon's own Octokit, never shelling `gh` (macOS token gotcha).
- **Revert scaffolding**: `merge-agent.ts` is **inert** — only built under `useCoordinator` (default false, `config.ts:463,500`) and even then its `git` dep is a no-op stub (`daemon.ts:1159` `async () => ok('')`). STACK v2 says remove/quarantine it.
- **Spec chain (draft, #822/#823)**: ARCH v2 adds `ArtifactKind` (spec-artifact|code-change), statuses (joined/observed-healthy/observed-red/reversal-raised/reverted), `PostLandingObservation` (indeterminate = red, fail-closed), `ReversalProposal` (auto-joins ONLY under the same verifier gate, else parks). Ops: deliver code change, join-cleared (await checks→merge→mark joined), await-required-checks (timeout/red never falls through), observe-trunk, raise-reversal. Names `phases.ts:360` as mirror, `readDeclaredData(id,'landing')` as source, `merge-agent.ts` for quarantine.

## Load-bearing design concerns (from ground truth — address explicitly)

1. **Checks-polling is new infra** — mirror `deploy.ts:200-219` pollHealth's bounded-budget loop shape, but over `octokit.checks.listForRef` (check-runs) **AND** `octokit.repos.getCombinedStatusForRef` (legacy statuses). Timeout or red ⇒ escalate, NEVER fall through to merge.
2. **"Required checks" has no source of truth (codex CRITICAL-adjacent, I3) + needs an L3 amendment (codex r2):** there is **no branch protection anywhere** in the repo, so "required" is undefined — the daemon can't ask GitHub which checks are required. The plan carries an **explicit required-check-names list** in the deployment profile, and **fails closed** when it's unset for a *governed* deployment (never treat "no checks"/"empty check-runs" as green; never poll forever). **BUT this field is not yet in the L2/L3 contract** — L2 only says "required checks must pass" (`...delivery.md:75`), L3 "poll required checks" (`...-ts.md:42`), and neither `LandingTarget` nor `DeploymentProfile` declares it. So the P1 build's Task 1 **includes a spec amendment** (via `l3-spec-guardian`, no Operator gate): add `requiredChecks: string[]` to the `LandingTarget`/profile contract in the STACK spec + the schema, with an L2 one-line clarification ("which checks are required is declared per-deployment") via `l2-spec-guardian` if the guardian deems it L2-level. Green = every named required check concluded success; unset for a governed deployment ⇒ escalate.
3. **Squash-SHA revert target** — `mergeL2Proposal` uses `merge_method:'squash'`, which rewrites the SHA (codex-confirmed: `pulls.merge().data.sha` is the merge commit; `delivery.ts:186` already treats it so). The revert must target that **squash merge SHA**, NOT the feature-branch head.
4. **Resume-safety via the EXISTING `phaseArtifacts` model (codex I1 — do NOT bolt on parallel state):** `RunState.phaseArtifacts` already exists (`types.ts:465`); STACK v2 says the code-change merge decision / observation / reversal references live there. **Extend `PhaseArtifactStatus`** (`types.ts:138`) with `joined`/`observed-healthy`/`observed-red`/`reversal-raised`/`reverted` rather than adding top-level `{prNumber,mergeSha,...}` fields. Persist PR/SHA/observation on the phase artifact so a restart mid-flow resumes correctly.
5. **Duplicate-PR idempotency needs a ProposalKey, not just persisted state (codex I2):** parking is saved only *after* the handler returns with `pausedAtPhase` (`pipeline.ts:267`), so a crash after `pulls.create` but before the save can orphan a PR. Per STACK v2 (`...-ts.md:36,95`), before creating a PR **look up an existing one by a deterministic ProposalKey** (e.g. search open PRs for `head:<featureBranch>` / a marker in the body) and adopt it instead of creating a duplicate. G5 must test the ProposalKey lookup path, not only persisted-prNumber re-entry.
6. **`readDeclaredData(...).value: unknown`** — narrow to `LandingTarget`; fail closed (escalate) on missing/invalid for a *configured* deployment. Never silently fall back to `config.branches.staging` for a governed deployment.
7. **The operator-approved override ALSO merges (codex CRITICAL 1):** the arm fires on `decision.kind === 'auto-merge'` **OR** `mergeDecisionApprovedEpoch === mergeDecisionEpoch` (`phases.ts:2143`; `resumeIntegrateParkedRun` sets the epoch on approve + re-enters `integrate`, `daemon.ts:2961`). ARCH v2 (`...delivery.md:68`) says Operator approval stands in for auto-merge. **PR-delivery must cover BOTH** — the auto-merge verdict and the approved-override re-entry — via the same PR/check/observe lane. Otherwise approved-held changes keep a raw-merge bypass or get stranded.
8. **The reversal decision is NOT a merge-approval (codex CRITICAL 2):** `buildMergeDecisionRequest` is hard-coded for "Approve the merge" with approve/reject→rework semantics (`build-request.ts:99/113/120`) — reusing it means approving a revert PR resumes the *original integrate*. Build a **dedicated reversal DecisionRequest** (own decision id/class, question "Approve the revert of <sha>?", own resume effect that merges the revert PR — not the original). **Wire options stay `approve`/`reject` (codex r2 CRITICAL — the answer transport only speaks those):** `decision-api.ts:498` publishes `approve|reject`, `parseCockpitAnswer` (`resume-consumer.ts:112`) recognizes `approve|reject|approve-merge`, the dashboard type is `approve|reject` (`decision-answer.tsx:43`). Do NOT invent new wire verbs beyond `approve`/`reject`. Reversal **semantics** ride the existing verbs: `approve` ⇒ merge the revert PR (undo the bad change); `reject` ⇒ hold the revert, leave the change in place, escalate to a human. The reversal-vs-original distinction rides the phase-artifact status, so `resumeIntegrateParkedRun`'s approve path merges the revert PR when the artifact is `reversal-raised`, the original PR otherwise.

---

## Task 1 — Consume `landing.landsOn` as the target trunk

**Files:** `phases.ts` (integrate handler, the `config.branches.staging` reads at ~1991/2151); **the required-checks spec+contract amendment (codex r2 I1 — name these explicitly so it can't be skipped):** `.specify/stack/controlled-artifact-delivery-ts.md` (via `l3-spec-guardian` — declare `requiredChecks: string[]` on the landing/profile contract), `deployment-registry/types.ts` (add `requiredChecks: string[]` to `LandingTarget` ~64), `deployment-registry/schema.ts` (add it to `LandingTargetSchema` ~95). These land in Task 1's diff + gate, not just prose.

1. In the governed (deployment-configured) arm, read `registry.readDeclaredData(deploymentId,'landing')`, narrow `.value` to `LandingTarget` (guard shape; on `not-found`/invalid → **escalate fail-closed**, do not merge). Use `landing.landsOn` as the merge target trunk.
2. The legacy no-deployment arm keeps `config.branches.staging` BUT logs loudly `[integrate] ungoverned delivery — no deployment profile; using config.branches.staging` (per L1 "ungoverned join, loudly marked").
3. Unit-test both arms (extend `phases.test.ts` fixtures: a profile with `landing`, and a not-found → escalate).

**Commit:** `feat(control-plane): integrate consumes landing.landsOn as target trunk; fail-closed on missing landing for governed deployments (P1)`

## Task 2 — Code-change PR delivery (replace raw merge in the auto-merge arm)

**Files:** `phases.ts` auto-merge arm (~2143-2192), new `control-plane/pr-delivery.ts` (the PR create→poll→merge flow, deps-injected + unit-testable), `integration.ts` (keep for the legacy/ungoverned path only).

1. New `deliverCodeChangeViaPR({ octokit, owner, repo, featureBranch, landsOn, requiredChecks, phaseArtifact, ... })`: **ProposalKey idempotency first** (concern 5) — look up an existing open PR for this run (by `head:featureBranch` / a body marker) and adopt it; else push feature branch → `octokit.pulls.create({ base: landsOn, head: featureBranch, ... })`. Then **await required checks** (Task 3) → on green `octokit.pulls.merge({ pull_number, merge_method: 'squash' })` → return `{ merged: true, prNumber, mergeSha: result.data.sha }`. Try/catch, never throw (mirror `mergeL2Proposal`). Update the `phaseArtifact` status at each step.
2. **Cover BOTH merge triggers (concern 7):** call `deliverCodeChangeViaPR` for governed deployments in the arm that fires on `decision.kind === 'auto-merge'` **and** on `mergeDecisionApprovedEpoch === mergeDecisionEpoch` (the operator-approved re-entry). The approved override joins via the *same* PR/check/observe lane — no raw-merge bypass. On escalate/hold, the **PR is the parked artifact** the decision references (create/adopt the PR, then park — do not merge).
3. **Resume-safety via `phaseArtifacts` (concern 4):** extend `PhaseArtifactStatus` (`types.ts:138`) with `joined`/`observed-healthy`/`observed-red`/`reversal-raised`/`reverted`; store `{ prNumber, mergeSha, observation }` on the integrate phase artifact. On re-entry, read the artifact + the ProposalKey lookup to resume from the current step (poll/merge/observe) rather than duplicating.
4. Retire the in-process `integrationLock` for the governed PR path (it doesn't span restarts); idempotency comes from the ProposalKey lookup + persisted phase artifact, not the boolean lock. (`integrationLock` stays only for the legacy raw-merge path.)

**Commit:** `feat(control-plane): PR-gated code-change delivery via GitHub API (squash-merge after checks), resume-safe on RunState (P1)`

## Task 3 — Await-required-checks poller

**Files:** new `control-plane/await-checks.ts` (+ test).

1. `awaitRequiredChecks({ octokit, owner, repo, ref, requiredChecks, budgetMs, pollMs })` → `{ status: 'green' | 'red' | 'timeout' | 'no-required-checks', ... }` — bounded-budget loop (mirror `deploy.ts:200-219`) over `octokit.checks.listForRef({ owner, repo, ref })` AND `octokit.repos.getCombinedStatusForRef`. **`requiredChecks` is the explicit source of truth (concern 2)** — green only when **every named required check** has concluded success; red on any named check failing; timeout on budget exhaustion; **`no-required-checks` when the list is empty/unset — the caller treats this as fail-closed (escalate) for a governed deployment, NOT green.** Never a "proceed on unknown".
2. Unit-test with a mock octokit: all-required→green; one-required-fails→red; always-pending→timeout; empty-required-list→`no-required-checks`.

**Commit:** `feat(control-plane): bounded await-required-checks poller (escalate on red/timeout, never bypass) (P1)`

## Task 4 — Post-landing observation + fail-closed revert lane (P1.5)

**Files:** new `control-plane/revert-lane.ts` (+ test), wired after a successful merge in the integrate handler.

1. After `deliverCodeChangeViaPR` returns `merged`, **observe the trunk**: `awaitRequiredChecks` (or a shorter observation poll) on the **squash `mergeSha`** (concern 2) → `PostLandingObservation` = healthy | red | indeterminate (**indeterminate = red, fail closed**).
2. On red/indeterminate: `git revert --no-edit <mergeSha>` on a fresh branch → push → `octokit.pulls.create` a revert PR → **raise a DEDICATED reversal `DecisionRequest` (concern 8 — do NOT reuse `buildMergeDecisionRequest`):** a new `buildReversalDecisionRequest` with its own decision id/class, question ("Approve reverting `<mergeSha>` — trunk checks went red?"), **wire options `approve`/`reject` ONLY (concern 8 — the answer transport speaks no other verbs; `approve` ⇒ merge the revert PR, `reject` ⇒ hold the revert + escalate to a human)**, and a resume effect that **merges the REVERT PR** (not the original) via the same `ledger.raise`/`GitHubBlockPublisher` transport. The reversal PR **auto-merges ONLY under the same verifier gate** as any autonomous join; else it parks for the Operator. `resumeIntegrateParkedRun`'s approve path branches on the `reversal-raised` phase-artifact status (revert PR) vs. original.
3. Persist observation + reversal state on the integrate **phase artifact** (concern 4): a restart after merge-before-observe resumes observation, not re-merge.
4. Test: the revert's local-git side via the `integration.test.ts` real-git-in-temp-dir pattern; the PR/escalation side via the extended mock octokit; the reversal DecisionRequest schema-validates and its approve path targets the revert PR, not the original.

**Commit:** `feat(control-plane): post-landing trunk observation + fail-closed auto-revert-PR lane on the squash SHA (P1.5)`

## Task 5 — Quarantine the inert merge-agent scaffolding

Delete or clearly quarantine `coordination/merge-agent.ts` (+ its `daemon.ts:1152-1177` build site) per STACK v2 — it's inert (flag-off + stub git dep) and reads as a live rollback net when it isn't. If deletion ripples traceability, quarantine with a loud header + remove from any live wiring. Update traceability.

**Commit:** `refactor(coordination): quarantine inert merge-agent scaffolding — not a live revert net (P1.5)`

## Task 6 — traceability + tests
`.specify/traceability.yml`: add `pr-delivery.ts`/`await-checks.ts`/`revert-lane.ts` + the new reversal builder (+ tests) to `STACK-AC-CONTROLLED-ARTIFACT-DELIVERY` code_paths/test_paths. **Keep ARCH/STACK-AC-CONTROLLED-ARTIFACT-DELIVERY `draft` (codex I4 — do NOT promote on code-merge):** they promote to `approved` only after the **Phase 9 live proof** (a real PR-gated auto-merge on cause-driven-tasks + the revert drill), not when this code lands. Extend `mockOctokit` (`phases.test.ts:285-296`) with `pulls.create`, `checks.listForRef`, `repos.getCombinedStatusForRef`, and open-PR search (for the ProposalKey lookup). Baselines before/after: daemon suite no new failures; typecheck + lint green.

## Acceptance-gate contract (GATE-AUTHOR; tests FAIL at HEAD)
- **G1 (Task 1):** the integrate handler uses `landing.landsOn` as the merge base for a governed deployment and **escalates (no merge)** when `landing` is not-found for a configured deployment; ungoverned (no deployment) uses `config.branches.staging` with the loud log. (FAILS: today it always uses `config.branches.staging`.)
- **G2 (Task 2):** `deliverCodeChangeViaPR` pushes + `pulls.create` + (checks green) `pulls.merge` squash, returns `{merged, prNumber, mergeSha}`; the SAME lane runs for both `decision.kind==='auto-merge'` AND the operator-approved-epoch re-entry; on escalate/hold the PR is created but NOT merged. Exercised with the extended mock octokit. (FAILS: module absent.)
- **G3 (Task 3):** `awaitRequiredChecks` returns green only when every NAMED required check succeeds, red on any named failure, timeout on exhaustion, and `no-required-checks` (→ caller escalates, NOT green) on an empty list. (FAILS: module absent.)
- **G4 (Task 4):** post-landing red/indeterminate on the **squash mergeSha** triggers a revert-PR create + a **dedicated reversal DecisionRequest** (own id/class/question, schema-valid, **wire options `approve`/`reject`**, and the resume `approve` path merges the revert PR — not the original — driven off the `reversal-raised` artifact status); healthy does nothing; reversal parks for Operator unless the verifier gate clears it. (FAILS: module + reversal builder absent.)
- **G5 (idempotency + resume):** re-entering integrate for a run whose ProposalKey matches an existing open PR **adopts it (no duplicate `pulls.create`)**; the integrate phase artifact carries the extended status (`joined`/`observed-*`/`reversal-*`) and drives resume. (FAILS: no ProposalKey lookup + `PhaseArtifactStatus` lacks the new values.)

No real GitHub; mock octokit + real-git-temp-dir for revert; no real Postgres; 30s floor. Runtime-lookup/untyped-alias for not-yet-existing modules so the gate typechecks at RED.

## Verify command
```
pnpm --filter @runforge/daemon test <gate paths> && pnpm --filter @runforge/daemon typecheck
```

## Definition of done (build phase, post-D2)
Gate green; daemon full suite no new failures; typecheck/lint/traceability green; PR against `main` (the spec chain #822/#823 having merged first). **ARCH/STACK stay `draft` — they promote to `approved` only at the Phase-9 live proof (codex r2), NOT at code-merge.**

**NOT in this PR (program-plan P1 done-evidence — live run):** the execution-log with a real PR on cause-driven-tasks (branch protection + a required check ON): daemon opens the PR, checks green, daemon auto-merges via API with `decideMerge` logged, zero operator touch; a second run showing escalate parking a PR + inbox decision; **and the P1.5 post-merge-red drill** — a seeded bad change auto-merges, trunk checks go red, the daemon opens the revert PR + escalation unprompted. That is Phase 9, run after the human merges this PR.

## Reserved-gate note
This plan does not approve any L1 content or merge any P1 code. It is build-ready prep. The build executes only after the Operator approves #822 (D2). If D2 changes the L1 content, this plan + gate get a revision pass first.
