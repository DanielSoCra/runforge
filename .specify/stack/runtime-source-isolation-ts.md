---
id: STACK-AC-RUNTIME-SOURCE-ISOLATION
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-RUNTIME-SOURCE-ISOLATION
code_paths:
  - packages/daemon/src/config.ts
  - packages/daemon/src/main.ts
  - packages/daemon/src/control-plane/daemon.ts
  - packages/daemon/src/control-plane/phases.ts
  - packages/daemon/src/control-plane/runtime-source.ts
  - packages/daemon/src/control-plane/server.ts
  - packages/daemon/src/control-plane/workspace.ts
  - packages/daemon/src/implementation/worktree.ts
  - packages/daemon/src/types.ts
test_paths:
  - packages/daemon/src/config.test.ts
  - packages/daemon/src/control-plane/daemon.test.ts
  - packages/daemon/src/control-plane/phases.test.ts
  - packages/daemon/src/control-plane/runtime-source.test.ts
  - packages/daemon/src/control-plane/server.test.ts
  - packages/daemon/src/control-plane/workspace.test.ts
  - packages/daemon/src/implementation/worktree.test.ts
---

# STACK-AC-RUNTIME-SOURCE-ISOLATION - Runtime Source Isolation (TypeScript)

## Pattern

**Runtime source preflight module.** Add a control-plane module that shells out to git through the existing `git()` wrapper and returns a typed `RuntimeSourceStatus`.

**Config-backed source policy.** Add runtime source fields to daemon config with safe defaults: require clean source, require explicit base branch, and disallow self-repair unless configured.

**Source status in control API.** Extend `/status` with sanitized runtime source health fields. Do not include credentials or remote URLs with embedded tokens.

**Workspace source plan.** Extend workspace reconciliation options with `sourceRef` so worktrees are created from explicit refs like `origin/dev` or an immutable merge commit.

## Key Decisions

**Validate before schedulers start.** Run preflight before repo pollers, review scheduler, product-owner scheduler, tech-lead scheduler, and crash resumption can spawn sessions.

**Use porcelain-free git checks.** Prefer `git status --porcelain=v1`, `git rev-parse`, and `git merge-base --is-ancestor` for stable parsing.

**Default to paused on drift.** Existing local development setups may be dirty. The first implementation should support a "warn and pause" mode before enforcing hard startup failure everywhere.

**Keep prompt cache source explicit.** Prompt cache pre-warming should read from the validated runtime source, not whichever branch the process happens to have checked out after earlier operations.

## Examples

```typescript
interface RuntimeSourceStatus {
  clean: boolean;
  head: string;
  expectedRef: string;
  healthy: boolean;
}
```

```typescript
const clean = (await git(['status', '--porcelain=v1'], repoRoot)).value.trim() === '';
```

```typescript
await git(['merge-base', '--is-ancestor', expectedRef, 'HEAD'], repoRoot);
```

```typescript
const workspace = await reconcileWorkspace({
  repoRoot, workspaceDir, featureBranch, stagingBranch, sourceRef: 'origin/dev',
});
```

## Gotchas

- `git status --porcelain` can show generated state files. Runtime policy must define ignored daemon-owned paths before declaring a source dirty.
- A branch can be clean but still behind. Cleanliness and synchronization are separate checks.
- A worktree path under the runtime source root is not automatically safe. Validate that agent workspaces are disposable and not the daemon runtime root.
- Do not log full remote URLs. Local remotes may contain credentials.
- If prompt cache pre-warming happens before source validation, the daemon can cache prompts from the wrong branch for the entire process lifetime.
