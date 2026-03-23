// src/supabase/run-writer.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SessionType } from '../types.js';
import type { PipelineResult } from '../control-plane/pipeline.js';

export type DbOutcome = 'in-progress' | 'complete' | 'stuck' | 'escalated';
export type DbSessionType = 'planning' | 'implementation' | 'validation' | 'diagnosis';

export function toDbOutcome(outcome: PipelineResult['outcome']): DbOutcome {
  if (outcome === 'complete') return 'complete';
  if (outcome === 'stuck')    return 'stuck';
  return 'in-progress'; // 'paused' and 'error' are non-terminal from DB perspective
}

export function toDbSessionType(type: SessionType): DbSessionType {
  switch (type) {
    case 'coordinator':
    case 'classifier':       return 'planning';
    case 'worker':
    case 'bug-worker':       return 'implementation';
    case 'reviewer-spec':
    case 'reviewer-quality':
    case 'reviewer-security':
    case 'codebase-reviewer': return 'validation';
    case 'diagnostician':    return 'diagnosis';
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown session type: ${_exhaustive}`);
    }
  }
}

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

export class SupabaseRunWriter {
  constructor(private readonly supabase: SupabaseClient) {}

  async upsertRun(runId: string, patch: Partial<RunRow>): Promise<void> {
    const { error } = await this.supabase
      .from('runs')
      .upsert({ id: runId, ...patch });
    if (error) {
      console.warn(`[run-writer] upsertRun failed for ${runId}:`, error.message);
    }
  }

  async writeCostEvent(runId: string, sessionType: SessionType, cost: number): Promise<void> {
    const { error } = await this.supabase
      .from('cost_events')
      .insert({ run_id: runId, session_type: toDbSessionType(sessionType), cost });
    if (error) {
      console.warn(`[run-writer] writeCostEvent failed for ${runId}:`, error.message);
    }
  }
}
