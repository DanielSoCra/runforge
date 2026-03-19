// src/implementation/batch.ts
import type { Unit, SessionResult, ExitStatus } from '../types.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import { createWorktree, getWorktreeDiffSize } from './worktree.js';
import { git } from '../lib/git.js';
import { ok, err, type Result } from '../lib/result.js';

export interface UnitResult {
  unitId: string;
  exitStatus: ExitStatus;
  cost: number;
  output: string;
  error?: string;
}

export interface BatchResult {
  results: UnitResult[];
  totalCost: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeBatch(
  units: Unit[],
  featureBranch: string,
  issueNumber: number,
  runtime: SessionRuntime,
  repoRoot: string,
  options?: { staggerMs?: number; maxDiffLines?: number },
): Promise<BatchResult> {
  const staggerMs = options?.staggerMs ?? 2000;
  const maxDiffLines = options?.maxDiffLines ?? 300;

  const promises = units.map(async (unit, index) => {
    // Stagger delay between starts
    if (index > 0) await delay(index * staggerMs);
    return executeUnit(unit, featureBranch, issueNumber, runtime, repoRoot, maxDiffLines);
  });

  const settled = await Promise.allSettled(promises);

  const results: UnitResult[] = settled.map((s, i) => {
    const unit = units[i]!;
    if (s.status === 'fulfilled') return s.value;
    return {
      unitId: unit.id,
      exitStatus: 'failed' as ExitStatus,
      cost: 0,
      output: '',
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });

  return {
    results,
    totalCost: results.reduce((sum, r) => sum + r.cost, 0),
  };
}

async function executeUnit(
  unit: Unit,
  featureBranch: string,
  issueNumber: number,
  runtime: SessionRuntime,
  repoRoot: string,
  maxDiffLines: number,
): Promise<UnitResult> {
  // 1. Create worktree
  console.log(`[batch] Creating worktree for ${unit.id} from ${featureBranch}`);
  const worktreeResult = await createWorktree(unit.id, featureBranch, repoRoot);
  if (!worktreeResult.ok) {
    console.error(`[batch] Worktree failed for ${unit.id}:`, worktreeResult.error.message);
    return {
      unitId: unit.id,
      exitStatus: 'failed',
      cost: 0,
      output: '',
      error: `Worktree creation failed: ${worktreeResult.error.message}`,
    };
  }
  console.log(`[batch] Worktree created at ${worktreeResult.value}`);

  try {
    // 2. Spawn worker session
    console.log(`[batch] Spawning worker session for ${unit.id}`);
    const sessionResult = await runtime.spawnSession(
      'worker',
      {
        variables: {
          task: unit.context,
          specs: unit.specContent,
          verification: unit.verificationCommand,
        },
        workspacePath: worktreeResult.value,
        baseBranch: featureBranch,
      },
      issueNumber,
    );

    if (!sessionResult.ok) {
      console.error(`[batch] Session failed for ${unit.id}:`, sessionResult.error.message);
      return {
        unitId: unit.id,
        exitStatus: 'failed',
        cost: 0,
        output: '',
        error: sessionResult.error.message,
      };
    }
    console.log(`[batch] Session result for ${unit.id}: ${sessionResult.value.exitStatus}`);

    const result = sessionResult.value;

    // 3. Check diff size
    const diffSize = await getWorktreeDiffSize(unit.id, featureBranch, repoRoot);
    if (diffSize.ok && diffSize.value > maxDiffLines) {
      return {
        unitId: unit.id,
        exitStatus: 'failed',
        cost: result.cost,
        output: result.output,
        error: `Diff size ${diffSize.value} exceeds limit of ${maxDiffLines}`,
      };
    }

    return {
      unitId: unit.id,
      exitStatus: result.exitStatus,
      cost: result.cost,
      output: result.output,
    };
  } finally {
    // 4. Remove worktree directory but keep the branch for merging
    await git(['worktree', 'remove', `workspaces/${unit.id}`, '--force'], repoRoot).catch(() => {});
  }
}
