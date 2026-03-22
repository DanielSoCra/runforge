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

    await queue.incrementAttempts(entryId);

    // Phase 1: Rebasing
    await queue.updatePhase(entryId, 'rebasing');

    const checkoutResult = await git(['checkout', entry.headRef], mergeWorktreePath);
    if (!checkoutResult.ok) {
      await queue.updateStatus(entryId, 'failed', checkoutResult.error.message);
      return err(checkoutResult.error);
    }

    const rebaseResult = await git(['rebase', integrationBranch], mergeWorktreePath);
    if (!rebaseResult.ok) {
      await queue.updateStatus(entryId, 'failed', rebaseResult.error.message);
      return err(rebaseResult.error);
    }

    // Phase 2: Merging
    await queue.updatePhase(entryId, 'merging');

    const checkoutIntResult = await git(['checkout', integrationBranch], mergeWorktreePath);
    if (!checkoutIntResult.ok) {
      await queue.updateStatus(entryId, 'failed', checkoutIntResult.error.message);
      return err(checkoutIntResult.error);
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
        await queue.updateStatus(entryId, 'needs_human', resolution.reason);
        return err(new Error(resolution.reason ?? 'needs human intervention'));
      }

      if (!resolution.resolved) {
        await queue.updateStatus(entryId, 'failed', resolution.reason ?? 'conflict resolution failed');
        return err(new Error(resolution.reason ?? 'conflict resolution failed'));
      }

      // Conflict was resolved — commit
      const commitResult = await git(['commit', '--no-edit'], mergeWorktreePath);
      if (!commitResult.ok) {
        await queue.updateStatus(entryId, 'failed', commitResult.error.message);
        return err(commitResult.error);
      }
    }

    // Get merge commit SHA
    const revParseResult = await git(['rev-parse', 'HEAD'], mergeWorktreePath);
    if (!revParseResult.ok) {
      await queue.updateStatus(entryId, 'failed', revParseResult.error.message);
      return err(revParseResult.error);
    }
    const mergeCommit = revParseResult.value.trim();
    await queue.setMergeCommit(entryId, mergeCommit);

    // Phase 3: Validating
    await queue.updatePhase(entryId, 'validating');

    const validationResult = await runValidation(entry.issueNumber, config.validationTimeoutMs);

    if (!validationResult.ok) {
      // Revert merge commit
      const revertResult = await git(['revert', '--no-edit', mergeCommit], mergeWorktreePath);
      if (!revertResult.ok) {
        // Revert failed — integration branch is in corrupted state, needs human intervention
        await queue.updatePhase(entryId, 'reverted');
        await queue.updateStatus(entryId, 'needs_human', `validation failed and revert failed: ${revertResult.error.message}`);
        return err(revertResult.error);
      }
      await queue.updatePhase(entryId, 'reverted');
      await queue.updateStatus(entryId, 'failed', validationResult.error.message);
      return err(validationResult.error);
    }

    // Success
    await queue.updateStatus(entryId, 'merged');
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
            await queue.updatePhase(entry.id, 'validating');
            const validationResult = await runValidation(entry.issueNumber, config.validationTimeoutMs);
            if (!validationResult.ok) {
              await queue.updateStatus(entry.id, 'failed', validationResult.error.message);
            } else {
              await queue.updateStatus(entry.id, 'merged');
            }
          } else {
            await queue.updatePhase(entry.id, 'queued');
          }
          break;
        }
        case 'validating': {
          // Re-run validation
          const validationResult = await runValidation(entry.issueNumber, config.validationTimeoutMs);
          if (!validationResult.ok) {
            await queue.updateStatus(entry.id, 'failed', validationResult.error.message);
          } else {
            await queue.updateStatus(entry.id, 'merged');
          }
          break;
        }
        case 'reverted': {
          await queue.updateStatus(entry.id, 'failed', 'recovered after crash in reverted phase');
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
        await queue.checkDependencyTimeouts(config.dependencyTimeoutMs);

        const next = await queue.selectNext();
        if (next) {
          await processEntry(next.id);
        }

        // Success — reset interval
        currentInterval = config.pollIntervalMs;
      } catch {
        // Error — apply exponential backoff
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
