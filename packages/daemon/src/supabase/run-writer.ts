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
    case 'product-owner':
    case 'tech-lead':
    case 'l2-designer':
    case 'l3-generator':
    case 'compliance-reviewer': return 'planning';
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

  /**
   * Insert a new run row. Use for the initial creation only.
   * All required fields (repo_owner, repo_name, etc.) must be provided.
   */
  async insertRun(runId: string, data: Partial<RunRow>): Promise<void> {
    const { error } = await this.supabase
      .from('runs')
      .insert({ id: runId, ...data });
    if (error) {
      console.warn(`[run-writer] insertRun failed for ${runId}:`, error.message);
    }
  }

  /**
   * Update an existing run row. Use for phase transitions and completion.
   * Only updates provided fields — does not null out missing ones.
   */
  async upsertRun(runId: string, patch: Partial<RunRow>): Promise<void> {
    const { error } = await this.supabase
      .from('runs')
      .update(patch)
      .eq('id', runId);
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
