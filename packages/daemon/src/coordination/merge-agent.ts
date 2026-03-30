// src/coordination/merge-agent.ts — Merge agent queue consumer with phase pipeline and crash recovery
import type { Result } from '../lib/result.js';
import { ok, err } from '../lib/result.js';
import type { ConflictResolverConfig, ConflictResolution } from './conflict-resolver.js';
import type { MergeQueue } from './merge-queue.js';

export interface MergeAgentDeps {
  queue: MergeQueue;
  git: (args: string[], cwd?: string) => Promise<Result<string>>;
  resolveConflicts: (
    cwd: string,
    config: ConflictResolverConfig,
    resolveSession: (files: string[], cwd: string) => Promise<Result<void>>,
  ) => Promise<ConflictResolution>;
  validate: (issueNumber: number, signal: AbortSignal) => Promise<Result<void>>;
  resolveSession: (files: string[], cwd: string) => Promise<Result<void>>;
  integrationBranch: string;
  mergeWorktreePath: string;
}

export interface MergeAgentConfig {
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  validationTimeoutMs: number;
  conflictFileThreshold: number;
  conflictLineThreshold: number;
  dependencyTimeoutMs: number;
}

export interface MergeAgent {
  processEntry(entryId: string): Promise<Result<void>>;
  recoverStuckEntries(): Promise<void>;
  start(): () => void;
}

export function createMergeAgent(deps: MergeAgentDeps, config: MergeAgentConfig): MergeAgent {
  const { queue, git, resolveConflicts, validate, resolveSession, integrationBranch, mergeWorktreePath } = deps;

  async function processEntry(entryId: string): Promise<Result<void>> {
    const entry = await queue.getEntry(entryId);
    if (!entry) {
      return err(new Error(`Entry ${entryId} not found`));
    }

    const incResult = await queue.incrementAttempts(entryId);
    if (!incResult.ok) return incResult;

    // Phase 1: Rebasing
    const rebasingPhaseResult = await queue.updatePhase(entryId, 'rebasing');
    if (!rebasingPhaseResult.ok) return rebasingPhaseResult;

    const checkoutResult = await git(['checkout', entry.headRef], mergeWorktreePath);
    if (!checkoutResult.ok) {
      const statusResult = await queue.updateStatus(entryId, 'failed', checkoutResult.error.message);
      return !statusResult.ok ? statusResult : err(checkoutResult.error);
    }

    const rebaseResult = await git(['rebase', integrationBranch], mergeWorktreePath);
    if (!rebaseResult.ok) {
      // Best-effort: clean up dirty worktree state
      await git(['rebase', '--abort'], mergeWorktreePath);
      const statusResult = await queue.updateStatus(entryId, 'failed', rebaseResult.error.message);
      return !statusResult.ok ? statusResult : err(rebaseResult.error);
    }

    // Phase 2: Merging
    const mergingPhaseResult = await queue.updatePhase(entryId, 'merging');
    if (!mergingPhaseResult.ok) return mergingPhaseResult;

    const checkoutIntResult = await git(['checkout', integrationBranch], mergeWorktreePath);
    if (!checkoutIntResult.ok) {
      const statusResult = await queue.updateStatus(entryId, 'failed', checkoutIntResult.error.message);
      return !statusResult.ok ? statusResult : err(checkoutIntResult.error);
    }
    const mergeResult = await git(['merge', '--no-ff', entry.headRef], mergeWorktreePath);

    if (!mergeResult.ok) {
      // Merge conflict — attempt resolution
      const conflictConfig: ConflictResolverConfig = {
        conflictFileThreshold: config.conflictFileThreshold,
        conflictLineThreshold: config.conflictLineThreshold,
      };
      const resolution = await resolveConflicts(mergeWorktreePath, conflictConfig, resolveSession);

      if (resolution.needsHuman) {
        // Best-effort: clean up dirty worktree state
        await git(['merge', '--abort'], mergeWorktreePath);
        const statusResult = await queue.updateStatus(entryId, 'needs_human', resolution.reason);
        if (!statusResult.ok) return statusResult;
        return err(new Error(resolution.reason ?? 'needs human intervention'));
      }

      if (!resolution.resolved) {
        // Best-effort: clean up dirty worktree state
        await git(['merge', '--abort'], mergeWorktreePath);
        const statusResult = await queue.updateStatus(entryId, 'failed', resolution.reason ?? 'conflict resolution failed');
        if (!statusResult.ok) return statusResult;
        return err(new Error(resolution.reason ?? 'conflict resolution failed'));
      }

      // Conflict was resolved — commit
      const commitResult = await git(['commit', '--no-edit'], mergeWorktreePath);
      if (!commitResult.ok) {
        const statusResult = await queue.updateStatus(entryId, 'failed', commitResult.error.message);
        return !statusResult.ok ? statusResult : err(commitResult.error);
      }
    }

    // Get merge commit SHA
    const revParseResult = await git(['rev-parse', 'HEAD'], mergeWorktreePath);
    if (!revParseResult.ok) {
      const statusResult = await queue.updateStatus(entryId, 'failed', revParseResult.error.message);
      return !statusResult.ok ? statusResult : err(revParseResult.error);
    }
    const mergeCommit = revParseResult.value.trim();
    const setCommitResult = await queue.setMergeCommit(entryId, mergeCommit);
    if (!setCommitResult.ok) return setCommitResult;

    // Phase 3: Validating
    const validatingPhaseResult = await queue.updatePhase(entryId, 'validating');
    if (!validatingPhaseResult.ok) return validatingPhaseResult;

    const validationResult = await runValidation(entry.issueNumber, config.validationTimeoutMs);

    if (!validationResult.ok) {
      // Revert merge commit
      const revertResult = await git(['revert', '--no-edit', mergeCommit], mergeWorktreePath);
      if (!revertResult.ok) {
        // Revert failed — integration branch is in corrupted state, needs human intervention
        const phaseResult = await queue.updatePhase(entryId, 'reverted');
        if (!phaseResult.ok) return phaseResult;
        const statusResult = await queue.updateStatus(entryId, 'needs_human', `validation failed and revert failed: ${revertResult.error.message}`);
        if (!statusResult.ok) return statusResult;
        return err(revertResult.error);
      }
      const revertedPhaseResult = await queue.updatePhase(entryId, 'reverted');
      if (!revertedPhaseResult.ok) return revertedPhaseResult;
      const failedStatusResult = await queue.updateStatus(entryId, 'failed', validationResult.error.message);
      if (!failedStatusResult.ok) return failedStatusResult;
      return err(validationResult.error);
    }

    // Success — if this fails, the entry is never marked as merged and retries infinitely
    const mergedResult = await queue.updateStatus(entryId, 'merged');
    if (!mergedResult.ok) return mergedResult;
    return ok(undefined);
  }

  async function runValidation(issueNumber: number, timeoutMs: number): Promise<Result<void>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await validate(issueNumber, controller.signal);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function recoverStuckEntries(): Promise<void> {
    const entries = await queue.list();

    for (const entry of entries) {
      switch (entry.mergePhase) {
        case 'rebasing':
        case 'merging': {
          // Per L2 spec: check if merge commit exists on integration branch.
          // If yes, advance to validating. If no, reset to queued and retry.
          if (entry.mergeCommit) {
            const phaseResult = await queue.updatePhase(entry.id, 'validating');
            if (!phaseResult.ok) continue;
            const validationResult = await runValidation(entry.issueNumber, config.validationTimeoutMs);
            if (!validationResult.ok) {
              const revertedPhaseResult = await queue.updatePhase(entry.id, 'reverted');
              if (!revertedPhaseResult.ok) continue;
              const statusResult = await queue.updateStatus(entry.id, 'failed', validationResult.error.message);
              if (!statusResult.ok) continue;
            } else {
              const statusResult = await queue.updateStatus(entry.id, 'merged');
              if (!statusResult.ok) continue;
            }
          } else {
            // Clean up potentially dirty worktree state before retry (best-effort)
            await git(['rebase', '--abort'], mergeWorktreePath);
            await git(['merge', '--abort'], mergeWorktreePath);
            await git(['checkout', integrationBranch], mergeWorktreePath);
            const phaseResult = await queue.updatePhase(entry.id, 'queued');
            if (!phaseResult.ok) continue;
          }
          break;
        }
        case 'validating': {
          // Re-run validation
          const validationResult = await runValidation(entry.issueNumber, config.validationTimeoutMs);
          if (!validationResult.ok) {
            const phaseResult = await queue.updatePhase(entry.id, 'reverted');
            if (!phaseResult.ok) continue;
            const statusResult = await queue.updateStatus(entry.id, 'failed', validationResult.error.message);
            if (!statusResult.ok) continue;
          } else {
            const statusResult = await queue.updateStatus(entry.id, 'merged');
            if (!statusResult.ok) continue;
          }
          break;
        }
        case 'reverted': {
          const statusResult = await queue.updateStatus(entry.id, 'failed', 'recovered after crash in reverted phase');
          if (!statusResult.ok) continue;
          break;
        }
        // 'queued' — nothing to recover
      }
    }
  }

  function start(): () => void {
    let currentInterval = config.pollIntervalMs;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    async function tick() {
      if (stopped) return;

      try {
        await recoverStuckEntries();
        await queue.checkDependencyTimeouts(config.dependencyTimeoutMs);

        const next = await queue.selectNext();
        if (next) {
          await processEntry(next.id);
        }

        // Success — reset interval
        currentInterval = config.pollIntervalMs;
      } catch (tickError) {
        // Log the error so failures are observable (#389), then apply exponential backoff
        console.error('[merge-agent] tick error:', tickError instanceof Error ? tickError.message : tickError);
        currentInterval = Math.min(currentInterval * 2, config.maxPollIntervalMs);
      }

      if (!stopped) {
        timerId = setTimeout(tick, currentInterval);
      }
    }

    timerId = setTimeout(tick, currentInterval);

    return () => {
      stopped = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
  }

  return { processEntry, recoverStuckEntries, start };
}
