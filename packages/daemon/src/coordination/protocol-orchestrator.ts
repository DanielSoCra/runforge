// src/coordination/protocol-orchestrator.ts — Protocol triggering/sequencing for PO/TL protocols
import { ok, err, type Result } from '../lib/result.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProtocolOrchestratorConfig {
  protocolTimeoutMs: number; // default 60_000
}

export interface BatchPlanningInput {
  prioritizedItems: Array<{ issueNumber: number; priority: number }>;
}

export interface BatchPlanningResult {
  poOutput: unknown;
  tlOutput: unknown;
}

export interface EscalationInput {
  target: 'po' | 'tl';
  issueNumber: number;
  reason: string;
  options: string[];
}

export interface EscalationResult {
  decision: unknown;
}

export interface RetrospectiveResult {
  poLessons: unknown;
  tlLessons: unknown;
}

export interface ProtocolOrchestratorDeps {
  poBatchPlanning: () => Promise<unknown>;
  tlBatchPlanning: (prospectiveRisks: unknown[]) => Promise<unknown>;
  queryProspectiveRisks?: () => Promise<unknown[]>;
  poEscalation: (input: EscalationInput) => Promise<unknown>;
  tlEscalation: (input: EscalationInput) => Promise<unknown>;
  poStatusSync: () => Promise<void>;
  tlStatusSync: () => Promise<void>;
  poRetrospective: () => Promise<unknown>;
  tlRetrospective: () => Promise<unknown>;
}

export interface ProtocolOrchestrator {
  batchPlanning: () => Promise<Result<BatchPlanningResult>>;
  escalation: (input: EscalationInput) => Promise<Result<EscalationResult>>;
  statusSync: () => Promise<Result<void>>;
  retrospective: () => Promise<Result<RetrospectiveResult>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}

export function createProtocolOrchestrator(
  deps: ProtocolOrchestratorDeps,
  config: ProtocolOrchestratorConfig,
): ProtocolOrchestrator {

  async function batchPlanning(): Promise<Result<BatchPlanningResult>> {
    try {
      // Query prospective risks before batch planning so the Tech Lead
      // can factor historical failures into effort estimates and risk assessments.
      // The entire sequence (risk query + planning) is covered by the timeout.
      const run = async () => {
        const prospectiveRisks = deps.queryProspectiveRisks
          ? await deps.queryProspectiveRisks()
          : [];
        const [poOutput, tlOutput] = await Promise.all([
          deps.poBatchPlanning(),
          deps.tlBatchPlanning(prospectiveRisks),
        ]);
        return { poOutput, tlOutput };
      };

      const result = await withTimeout(run(), config.protocolTimeoutMs, 'Batch Planning protocol');
      return ok(result);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async function escalation(input: EscalationInput): Promise<Result<EscalationResult>> {
    try {
      const handler = input.target === 'po' ? deps.poEscalation : deps.tlEscalation;
      const decision = await withTimeout(
        handler(input),
        config.protocolTimeoutMs,
        'Escalation protocol',
      );
      return ok({ decision });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async function statusSync(): Promise<Result<void>> {
    try {
      await withTimeout(
        Promise.all([deps.poStatusSync(), deps.tlStatusSync()]),
        config.protocolTimeoutMs,
        'Status Sync protocol',
      );
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async function retrospective(): Promise<Result<RetrospectiveResult>> {
    try {
      const [poLessons, tlLessons] = await withTimeout(
        Promise.all([deps.poRetrospective(), deps.tlRetrospective()]),
        config.protocolTimeoutMs,
        'Retrospective protocol',
      );
      return ok({ poLessons, tlLessons });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  return { batchPlanning, escalation, statusSync, retrospective };
}
