// src/implementation/fix.ts
import { ok, err, type Result } from '../lib/result.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { ReviewFinding } from '../types.js';
import { SessionError } from '../session-runtime/session-error.js';
import { createWorktree, mergeWorktree, deleteUnitBranch } from './worktree.js';
import { git } from '../lib/git.js';

export interface FixResult {
  success: boolean;
  cost: number;
  output: string;
}

/**
 * Fix operation: creates a single-unit workspace, spawns a worker session
 * with regression-test-first protocol, and merges the fix.
 * Per L3 spec: called by Validation Service when review gates or tests fail.
 */
export async function fix(
  findings: ReviewFinding[],
  targetBranch: string,
  runtime: SessionRuntime,
  repoRoot: string,
  specContent?: string,
  verificationCommand?: string,
): Promise<Result<FixResult>> {
  const fixId = `fix-${Date.now()}`;

  // 1. Create worktree
  const worktreeResult = await createWorktree(fixId, targetBranch, repoRoot);
  if (!worktreeResult.ok) {
    return err(worktreeResult.error);
  }

  try {
    // 2. Assemble fix context with regression-test-first protocol
    const findingsText = findings
      .map((f) => `- [${f.severity}] ${f.location}: ${f.description}`)
      .join('\n');

    const taskContext = [
      '## Fix Protocol: Regression-Test-First',
      '',
      '1. Write a test that reproduces each finding below',
      '2. Confirm the test fails',
      '3. Fix the code to address the finding',
      '4. Confirm the test passes',
      '5. Run all local verification checks',
      '',
      '## Findings',
      '',
      findingsText,
    ].join('\n');

    // 3. Spawn worker session
    const sessionResult = await runtime.spawnSession(
      'worker',
      {
        variables: {
          task: taskContext,
          specs: specContent ?? '',
          findings: findingsText,
          verification: verificationCommand ?? 'pnpm -r run test',
          pitfalls: '',
        },
        workspacePath: worktreeResult.value,
        baseBranch: targetBranch,
      },
      0,
    );

    if (!sessionResult.ok) {
      const cost = sessionResult.error instanceof SessionError ? sessionResult.error.cost : 0;
      return ok({ success: false, cost, output: sessionResult.error.message });
    }

    const result = sessionResult.value;

    if (result.exitStatus !== 'completed' && result.exitStatus !== 'completed-with-concerns') {
      return ok({ success: false, cost: result.cost, output: result.output });
    }

    // 4. Merge fix into target branch
    await git(['checkout', targetBranch], repoRoot);
    const mergeResult = await mergeWorktree(fixId, targetBranch, repoRoot);
    if (!mergeResult.ok) {
      return ok({ success: false, cost: result.cost, output: `Merge failed: ${mergeResult.error.message}` });
    }

    return ok({ success: true, cost: result.cost, output: result.output });
  } catch (e) {
    return ok({
      success: false,
      cost: e instanceof SessionError ? e.cost : 0,
      output: e instanceof Error ? e.message : String(e),
    });
  } finally {
    // Always clean up worktree and branch
    await git(['worktree', 'remove', `workspaces/${fixId}`, '--force'], repoRoot).catch(() => {});
    await deleteUnitBranch(fixId, repoRoot).catch(() => {});
  }
}
