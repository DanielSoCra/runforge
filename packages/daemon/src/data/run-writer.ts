import type {
  CostEventStore,
  JsonValue,
  RunInsert,
  RunStore,
} from '@auto-claude/db';

import type { PipelineResult } from '../control-plane/pipeline.js';
import type { SessionType } from '../types.js';

export type DbOutcome =
  | 'in-progress'
  | 'complete'
  | 'stuck'
  | 'escalated'
  | 'failed';
export type RunWriterOutcome = PipelineResult['outcome'] | 'failed';
export type DbSessionType =
  | 'planning'
  | 'implementation'
  | 'validation'
  | 'diagnosis'
  | 'fix';

export interface RunRow {
  id?: string;
  repo_id?: string | null;
  repo_owner?: string;
  repo_name?: string;
  issue_number?: number;
  issue_title?: string;
  pipeline_variant?: string;
  current_phase?: string | null;
  outcome?: DbOutcome;
  total_cost?: number;
  phases?: PhaseRecord[];
  fix_attempts?: number;
  report?: string | null;
  started_at?: string;
  completed_at?: string | null;
  active_plugins?: string[];
}

export interface PhaseRecord {
  phase: string;
  outcome: 'success' | 'failure' | 'skipped';
  completedAt: string;
}

export interface RunWriter {
  insertRun(runId: string, data: Partial<RunRow>): Promise<void>;
  upsertRun(runId: string, patch: Partial<RunRow>): Promise<void>;
  writeCostEvent(
    runId: string,
    sessionType: SessionType,
    cost: number,
  ): Promise<void>;
}

export function toDbOutcome(outcome: RunWriterOutcome): DbOutcome {
  if (outcome === 'complete') return 'complete';
  if (outcome === 'stuck') return 'stuck';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'error') return 'failed';
  if (outcome === 'parked') return 'in-progress';
  return 'in-progress';
}

export function toDbSessionType(type: SessionType): DbSessionType {
  switch (type) {
    case 'coordinator':
    case 'classifier':
      return 'planning';
    case 'worker':
    case 'bug-worker':
      return 'implementation';
    case 'reviewer-spec':
    case 'reviewer-quality':
    case 'reviewer-security':
    case 'codebase-reviewer':
      return 'validation';
    case 'diagnostician':
      return 'diagnosis';
    case 'product-owner':
    case 'tech-lead':
    case 'l2-designer':
    case 'l3-generator':
    case 'compliance-reviewer':
      return 'planning';
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown session type: ${_exhaustive}`);
    }
  }
}

export class PostgresRunWriter implements RunWriter {
  constructor(
    private readonly runs: RunStore,
    private readonly costs: CostEventStore,
  ) {}

  async insertRun(runId: string, data: Partial<RunRow>): Promise<void> {
    const mapped = toRunInsert(runId, data);
    if (!mapped) return;

    const result = await this.runs.insertRun(mapped);
    if (!result.ok) {
      console.warn(
        `[run-writer] insertRun failed for ${runId}: ${result.message}`,
      );
    }
  }

  async upsertRun(runId: string, patch: Partial<RunRow>): Promise<void> {
    const mapped = toRunPatch(patch);
    const result = await this.runs.updateRun(runId, mapped);
    if (!result.ok) {
      console.warn(
        `[run-writer] upsertRun failed for ${runId}: ${result.message}`,
      );
    }
  }

  async writeCostEvent(
    runId: string,
    sessionType: SessionType,
    cost: number,
  ): Promise<void> {
    const result = await this.costs.recordCostEvent(
      runId,
      toDbSessionType(sessionType),
      cost,
    );
    if (!result.ok) {
      console.warn(
        `[run-writer] writeCostEvent failed for ${runId}: ${result.message}`,
      );
    }
  }
}

export function toRunInsert(
  runId: string,
  data: Partial<RunRow>,
): RunInsert | null {
  const repoOwner = data.repo_owner;
  const repoName = data.repo_name;
  const issueNumber = data.issue_number;
  const issueTitle = data.issue_title;

  if (
    repoOwner === undefined ||
    repoOwner === '' ||
    repoName === undefined ||
    repoName === '' ||
    issueNumber === undefined ||
    issueTitle === undefined ||
    issueTitle === ''
  ) {
    console.warn(`[run-writer] insertRun missing required fields for ${runId}`);
    return null;
  }

  return {
    ...toRunPatch(data),
    id: runId,
    repoOwner,
    repoName,
    issueNumber,
    issueTitle,
  };
}

export function toRunPatch(patch: Partial<RunRow>): Partial<RunInsert> {
  return withoutUndefined({
    id: patch.id,
    repoId: patch.repo_id,
    repoOwner: patch.repo_owner,
    repoName: patch.repo_name,
    issueNumber: patch.issue_number,
    issueTitle: patch.issue_title,
    pipelineVariant: patch.pipeline_variant,
    currentPhase: patch.current_phase,
    outcome: patch.outcome,
    totalCost: patch.total_cost,
    phases:
      patch.phases === undefined
        ? undefined
        : (patch.phases as unknown as JsonValue),
    fixAttempts: patch.fix_attempts,
    report: patch.report,
    startedAt:
      patch.started_at === undefined ? undefined : new Date(patch.started_at),
    completedAt:
      patch.completed_at === undefined
        ? undefined
        : patch.completed_at === null
          ? null
          : new Date(patch.completed_at),
    activePlugins: patch.active_plugins,
  });
}

function withoutUndefined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
