// src/implementation/batch.ts
import type { Unit, SessionResult, ExitStatus, PitfallMarker, PipelineVariant } from '../types.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import type { GotchaStore } from '../knowledge/gotcha-store.js';
import type { KnowledgeStore } from '../knowledge/knowledge-store.js';
import { extractKnowledgeMarkers } from '../knowledge/extractor.js';
import { SessionError } from '../session-runtime/session-error.js';
import { createWorktree, getWorktreeDiffSize } from './worktree.js';
import { git } from '../lib/git.js';
import { runCommand } from '../lib/process.js';

export interface UnitResult {
  unitId: string;
  exitStatus: ExitStatus;
  cost: number;
  output: string;
  pitfallMarkers: PitfallMarker[];
  error?: string;
  handoffNote?: string;
  containmentBreach?: boolean;
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
  runWriter?: SupabaseRunWriter,
  runId?: string,
  unitPitfalls?: Map<string, string>,
  gotchaStore?: GotchaStore,
  unitHandoffs?: Map<string, string>,
  variant?: PipelineVariant,
  bugContext?: { bugReport: string; diagnosis: string },
  activePlugins?: Array<{ id: string; activatedAt: string }>,
  knowledgeStore?: KnowledgeStore,
): Promise<BatchResult> {
  const staggerMs = options?.staggerMs ?? 2000;
  const maxDiffLines = options?.maxDiffLines ?? 300;

  const promises = units.map(async (unit, index) => {
    // Stagger delay between starts
    if (index > 0) await delay(index * staggerMs);
    const pitfalls = unitPitfalls?.get(unit.id) ?? '';
    return executeUnit(unit, featureBranch, issueNumber, runtime, repoRoot, maxDiffLines, runWriter, runId, pitfalls, gotchaStore, unitHandoffs?.get(unit.id), variant, bugContext, activePlugins, knowledgeStore);
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
      pitfallMarkers: [],
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
  runWriter?: SupabaseRunWriter,
  runId?: string,
  pitfalls?: string,
  gotchaStore?: GotchaStore,
  handoffNote?: string,
  variant?: PipelineVariant,
  bugContext?: { bugReport: string; diagnosis: string },
  activePlugins?: Array<{ id: string; activatedAt: string }>,
  knowledgeStore?: KnowledgeStore,
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
      pitfallMarkers: [],
      error: `Worktree creation failed: ${worktreeResult.error.message}`,
    };
  }
  console.log(`[batch] Worktree created at ${worktreeResult.value}`);

  // Install dependencies in the worktree so test commands can find local packages.
  // Use --no-frozen-lockfile because worker commits may add new dependencies.
  const installResult = await runCommand('pnpm', ['install', '--no-frozen-lockfile'], {
    cwd: worktreeResult.value,
    timeoutMs: 120_000,
  });
  if (!installResult.ok) {
    console.warn(`[batch] pnpm install failed for ${unit.id}: ${installResult.error.message}`);
  }

  try {
    // 2. Spawn worker session (bug-worker for bug pipeline, worker otherwise)
    const sessionType = variant === 'bug' ? 'bug-worker' : 'worker';
    console.log(`[batch] Spawning ${sessionType} session for ${unit.id}`);
    // Prepend handoff note from previous attempt (ARCH-AC-HANDOFF step 7)
    const taskContext = handoffNote
      ? `[PREVIOUS ATTEMPT]\n${handoffNote}\n\n${unit.context}`
      : unit.context;
    const variables: Record<string, string> = variant === 'bug' && bugContext
      ? {
          bugReport: handoffNote
            ? `[PREVIOUS ATTEMPT]\n${handoffNote}\n\n${bugContext.bugReport}`
            : bugContext.bugReport,
          diagnosis: bugContext.diagnosis,
          specs: unit.specContent,
          pitfalls: pitfalls || '',
        }
      : {
          task: taskContext,
          specs: unit.specContent,
          verification: unit.verificationCommand,
          pitfalls: pitfalls || '',
        };

    const sessionResult = await runtime.spawnSession(
      sessionType,
      {
        variables,
        workspacePath: worktreeResult.value,
        baseBranch: featureBranch,
        activePlugins,
      },
      issueNumber,
      undefined,
      runWriter,
      runId,
    );

    if (!sessionResult.ok) {
      console.error(`[batch] Session failed for ${unit.id}:`, sessionResult.error.message);
      const isContainmentBreach = sessionResult.error instanceof SessionError
        && sessionResult.error.containmentBreach;
      return {
        unitId: unit.id,
        exitStatus: 'failed',
        cost: sessionResult.error instanceof SessionError ? sessionResult.error.cost : 0,
        output: '',
        pitfallMarkers: [],
        error: sessionResult.error.message,
        containmentBreach: isContainmentBreach || undefined,
      };
    }
    console.log(`[batch] Session result for ${unit.id}: ${sessionResult.value.exitStatus}`);

    const result = sessionResult.value;

    // 3. Store pitfall markers as gotchas (v1 knowledge capture)
    if (gotchaStore && result.pitfallMarkers.length > 0) {
      try {
        const stored = await gotchaStore.store(result.pitfallMarkers, issueNumber);
        if (stored > 0) console.log(`[batch] Stored ${stored} new gotchas from ${unit.id}`);
      } catch (e) {
        console.warn(`[batch] Failed to store gotchas for ${unit.id}:`, e);
      }
    }

    // 3b. Extract and store v2 knowledge markers from session output (ARCH-AC-KNOWLEDGE: Record capture flow)
    if (knowledgeStore && result.output) {
      try {
        const knowledgeMarkers = extractKnowledgeMarkers(result.output);
        if (knowledgeMarkers.length > 0) {
          const stored = await knowledgeStore.storeRecord(
            knowledgeMarkers,
            `issue-${issueNumber}`,
            'autonomous',
            'technical_pitfall',
          );
          if (stored > 0) console.log(`[batch] Stored ${stored} new knowledge records from ${unit.id}`);
        }
      } catch (e) {
        console.warn(`[batch] Failed to store knowledge records for ${unit.id}:`, e);
      }
    }

    // 4. Check diff size
    const diffSize = await getWorktreeDiffSize(unit.id, featureBranch, repoRoot);
    if (!diffSize.ok) {
      console.error(`[batch] Diff size check failed for ${unit.id}:`, diffSize.error.message);
      return {
        unitId: unit.id,
        exitStatus: 'failed',
        cost: result.cost,
        output: result.output,
        pitfallMarkers: result.pitfallMarkers,
        handoffNote: result.handoffNote,
        error: `Diff size check failed: ${diffSize.error.message}`,
      };
    }
    if (diffSize.value > maxDiffLines) {
      return {
        unitId: unit.id,
        exitStatus: 'failed',
        cost: result.cost,
        output: result.output,
        pitfallMarkers: result.pitfallMarkers,
        handoffNote: result.handoffNote,
        error: `Diff size ${diffSize.value} exceeds limit of ${maxDiffLines}`,
      };
    }

    return {
      unitId: unit.id,
      exitStatus: result.exitStatus,
      cost: result.cost,
      output: result.output,
      pitfallMarkers: result.pitfallMarkers,
      handoffNote: result.handoffNote,
    };
  } finally {
    // Remove worktree directory but keep branch alive for merge by coordinator
    await git(['worktree', 'remove', `workspaces/${unit.id}`, '--force'], repoRoot).catch(() => {});
  }
}
