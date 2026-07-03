---
id: STACK-AC-CONTROLLED-ARTIFACT-DELIVERY
type: stack-specific
domain: auto-claude
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-CONTROLLED-ARTIFACT-DELIVERY
code_paths:
  - prompts/l2-designer.md
  - prompts/l3-generator.md
  - packages/daemon/src/control-plane/phases.ts
  - packages/daemon/src/control-plane/integration.ts
  - packages/daemon/src/control-plane/spec-pipeline/delivery.ts
  - packages/daemon/src/control-plane/spec-pipeline/park.ts
  - packages/daemon/src/control-plane/spec-pipeline/spec-chain.ts
  - packages/daemon/src/types.ts
test_paths:
  - packages/daemon/src/control-plane/phases.test.ts
  - packages/daemon/src/control-plane/integration.test.ts
  - packages/daemon/src/control-plane/spec-pipeline/delivery.test.ts
  - packages/daemon/src/control-plane/spec-pipeline/**/*.test.ts
---

# STACK-AC-CONTROLLED-ARTIFACT-DELIVERY - Controlled Artifact Delivery (TypeScript)

> **v2 (2026-07-02, draft):** adds the TypeScript patterns for delivering a **code change** as a PR against the deployment's declared trunk — mirroring the proven spec-artifact PR path in `spec-pipeline/delivery.ts` (`createProposal` + `mergeL2Proposal`, `phases.ts:360`) — plus required-checks polling before the merge, landing-target plumbing from the deployment profile, and the post-landing observation + revert-PR lane. New implementation modules do not exist yet; their `code_paths` are added when the implementation lands. v1 spec-artifact patterns below are unchanged.

## Pattern

**Artifact-only prompt contract.** L2 and L3 prompt templates explicitly forbid branch, commit, push, label, comment, and pull request operations. The session exits after writing files; the daemon owns packaging.

**PhaseArtifact on RunState.** Add a typed `phaseArtifacts` field keyed by phase name. Keep artifact metadata with the run so crash resume and parked gate checks can reconcile without scraping comments. For a code-change phase, extend the record with the merge decision reference, the post-landing observation, and any reversal reference.

**ProposalKey idempotency.** Build a deterministic key from owner, repo, issue number, phase, and base branch. Search open and recently merged pull requests for that key before creating a new one.

**Daemon-owned proposal creation.** A control-plane delivery helper stages changed paths, creates a phase commit, pushes the source branch, and creates or updates the pull request through Octokit.

**Code-change delivery in the integrate handler.** In the `integrate` handler (`phases.ts`, ~1944) and `integration.ts`, replace the raw `integrateToStaging` merge for a *configured* deployment with the PR path: push the feature branch, `octokit.pulls.create` against the deployment's `landing.landsOn` trunk, and — on the `decideMerge` `auto-merge` verdict — await required checks, then `octokit.pulls.merge`. Mirror the spec-artifact path exactly (`createProposal`, `mergeL2Proposal`). On `escalate`/`hold`, the PR is the parked artifact the existing `DecisionRequest` references; no merge occurs until the decision clears it.

**Required-checks polling before merge.** Before calling `pulls.merge`, poll the PR head's combined check-runs/commit-status with a bounded timeout budget. Red or timeout routes to the escalate path (park + `DecisionRequest`); the daemon never calls `pulls.merge` to bypass a pending or red check.

**Landing-target plumbing.** For a configured deployment, resolve the trunk from `registry.readDeclaredData(deploymentId, 'landing')` (`value` narrowed to `LandingTarget`, using `landsOn`), not `config.branches.staging`. The raw `config.branches.staging` read remains only on the profile-less legacy path.

**Post-landing observation + revert-PR lane.** After a controlled merge, re-poll the trunk's required checks for the merge commit. On red (or indeterminate — fail-closed), open a **revert PR** (`git revert --no-edit <mergeSha>` on a fresh branch → push → `octokit.pulls.create`) and raise a merge-style `DecisionRequest`. A revert may auto-merge only under the same verifier gate that governs any autonomous join.

## Key Decisions

**Use phase-specific source branches.** Use branch names like `spec/l2/<issue>` and `spec/l3/<issue>` for spec artifacts, separate from implementation branches. This keeps review history clear and prevents implementation work from inheriting stale spec-generation commits.

**Do not let prompts mention delivery commands as tasks.** The prompt still explains that the daemon handles delivery, but it does not provide shell commands for the agent to run. This avoids turning prohibited delivery operations into tempting action steps.

**Record merged artifact status before resume.** `resumeParkedRuns()` must reconcile the pull request status and update `run.phaseArtifacts[phase].status` before clearing `pausedAtPhase`.

**Reuse existing labels for gate visibility.** Labels remain the operator-visible gate signals, but proposal identity comes from `PhaseArtifact`, not labels or comment text.

**Reuse the daemon's Octokit + its own token, never shell `gh`.** The daemon already constructs an Octokit instance with its own token for the spec-artifact path; keep the code-delivery PR path on the same Octokit. `gh auth token` can return an invalid token on macOS (TLS/date rollover), so shelling out to `gh` for `pulls.create`/`pulls.merge`/checks is fragile — the in-process token is not.

**Mirror the spec-artifact merge method.** Use the same `merge_method` shape as `mergeL2Proposal` (`'squash'`) so both delivery lanes behave identically; expose it as config only if a deployment needs a different method. Return a failure reason instead of throwing (as `mergeL2Proposal` does) so the caller can re-park gracefully when the PR is un-mergeable.

**Poll checks, do not subscribe to webhooks.** The daemon is a single long-running loop, not a webhook receiver. Wait on required checks by polling with a bounded budget and escalating on timeout — this composes with the existing per-claim loop and needs no inbound HTTP surface.

**Quarantine the inert coordinator revert scaffolding.** `coordination/merge-agent.ts` holds a `useCoordinator`-gated (default `false`), stub-git-injected revert path that returns `ok('')` unconditionally. Remove it or clearly quarantine it so the live revert-PR lane is the only rollback path; do not extend the dead scaffolding.

## Examples

```typescript
// Open the code-change proposal against the deployment's declared trunk.
const { landsOn } = registry.readDeclaredData(deploymentId, 'landing').value as LandingTarget;
const pr = await octokit.pulls.create({ owner, repo, head: featureBranch, base: landsOn, title, body });
```

```typescript
// Wait on required checks before merging; escalate on timeout — never bypass.
const combined = await octokit.checks.listForRef({ owner, repo, ref: headSha });
const allGreen = combined.data.check_runs.every((c) => c.conclusion === 'success');
```

```typescript
// Auto-merge arm mirrors mergeL2Proposal: squash, and return a reason on failure.
await octokit.pulls.merge({ owner, repo, pull_number, merge_method: 'squash' });
```

```typescript
// Revert lane: revert the merge/squash commit, then open a revert PR.
await git(['revert', '--no-edit', mergeSha], mainRepoRoot);
const revertPr = await octokit.pulls.create({ owner, repo, head: revertBranch, base: landsOn, title });
```

## Gotchas

- `git diff --quiet` exits with status 1 when changes exist. Treat that as "has changes", not as a command failure.
- `git push -u` should be used only by the daemon delivery helper. Agent prompts must not instruct sessions to set upstreams.
- Pull request title matching is not enough for idempotency. Include the ProposalKey in the body so retries can find renamed proposals.
- A merged proposal may have its source branch deleted. Resume from the merge commit or base branch, not from the source branch.
- If a session writes no files but exits `completed`, record an `agent_output_invalid` failure kind so typed failure routing can decide whether to retry.
- `octokit.pulls.merge` throws when the PR is un-mergeable or required checks are not satisfied. Catch it (as `mergeL2Proposal` does) and re-park with a reason rather than failing the run — a rejected merge under branch protection is the signal to keep waiting or escalate on timeout, not a hard error.
- A squash merge creates a **new** commit on the trunk. The revert must target that returned merge/squash SHA, not the feature-branch head.
- `readDeclaredData(deploymentId, 'landing')` returns `{ kind, value }` where `value` is `unknown`. Narrow to `LandingTarget` before reading `landsOn`; a configured deployment missing a valid landing target must fail closed, never fall through to `config.branches.staging`.
- Keep `integrateToStaging` (raw push, no PR) only for the profile-less legacy path, and log it loudly as ungoverned. A configured deployment must never reach it — the not-found / not-owned guards already fail closed at integrate.
