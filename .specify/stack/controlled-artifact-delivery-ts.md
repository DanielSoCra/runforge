---
id: STACK-AC-CONTROLLED-ARTIFACT-DELIVERY
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-CONTROLLED-ARTIFACT-DELIVERY
code_paths:
  - prompts/l2-designer.md
  - prompts/l3-generator.md
  - packages/daemon/src/control-plane/phases.ts
  - packages/daemon/src/control-plane/spec-pipeline/delivery.ts
  - packages/daemon/src/control-plane/spec-pipeline/park.ts
  - packages/daemon/src/control-plane/spec-pipeline/spec-chain.ts
  - packages/daemon/src/types.ts
test_paths:
  - packages/daemon/src/control-plane/phases.test.ts
  - packages/daemon/src/control-plane/spec-pipeline/delivery.test.ts
  - packages/daemon/src/control-plane/spec-pipeline/**/*.test.ts
---

# STACK-AC-CONTROLLED-ARTIFACT-DELIVERY - Controlled Artifact Delivery (TypeScript)

## Pattern

**Artifact-only prompt contract.** L2 and L3 prompt templates explicitly forbid branch, commit, push, label, comment, and pull request operations. The session exits after writing files; the daemon owns packaging.

**PhaseArtifact on RunState.** Add a typed `phaseArtifacts` field keyed by phase name. Keep artifact metadata with the run so crash resume and parked gate checks can reconcile without scraping comments.

**ProposalKey idempotency.** Build a deterministic key from owner, repo, issue number, phase, and base branch. Search open and recently merged pull requests for that key before creating a new one.

**Daemon-owned proposal creation.** A control-plane delivery helper stages changed paths, creates a phase commit, pushes the source branch, and creates or updates the pull request through Octokit.

## Key Decisions

**Use phase-specific source branches.** Use branch names like `spec/l2/<issue>` and `spec/l3/<issue>` for spec artifacts, separate from implementation branches. This keeps review history clear and prevents implementation work from inheriting stale spec-generation commits.

**Do not let prompts mention delivery commands as tasks.** The prompt still explains that the daemon handles delivery, but it does not provide shell commands for the agent to run. This avoids turning prohibited delivery operations into tempting action steps.

**Record merged artifact status before resume.** `resumeParkedRuns()` must reconcile the pull request status and update `run.phaseArtifacts[phase].status` before clearing `pausedAtPhase`.

**Reuse existing labels for gate visibility.** Labels remain the operator-visible gate signals, but proposal identity comes from `PhaseArtifact`, not labels or comment text.

## Examples

```typescript
type PhaseArtifactStatus = 'prepared' | 'proposed' | 'awaiting-review' | 'merged' | 'rejected' | 'delivery-failed';
```

```typescript
interface PhaseArtifact {
  phase: 'l2-design' | 'l3-generate';
  pullRequestNumber?: number;
  headBranch: string;
  baseBranch: string;
}
```

```typescript
const proposalKey = `${owner}/${repo}#${issueNumber}:${phase}:${baseBranch}`;
```

```typescript
await octokit.pulls.create({
  owner, repo, head: artifact.headBranch, base: artifact.baseBranch, title, body,
});
```

## Gotchas

- `git diff --quiet` exits with status 1 when changes exist. Treat that as "has changes", not as a command failure.
- `git push -u` should be used only by the daemon delivery helper. Agent prompts must not instruct sessions to set upstreams.
- Pull request title matching is not enough for idempotency. Include the ProposalKey in the body so retries can find renamed proposals.
- A merged proposal may have its source branch deleted. Resume from the merge commit or base branch, not from the source branch.
- If a session writes no files but exits `completed`, record an `agent_output_invalid` failure kind so typed failure routing can decide whether to retry.
