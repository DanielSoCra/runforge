// src/coordination/protocol-orchestrator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createProtocolOrchestrator,
  type ProtocolOrchestrator,
  type ProtocolOrchestratorDeps,
  type ProtocolOrchestratorConfig,
  type BatchPlanningInput,
  type BatchPlanningResult,
  type EscalationInput,
  type EscalationResult,
} from './protocol-orchestrator.js';

function makeConfig(overrides: Partial<ProtocolOrchestratorConfig> = {}): ProtocolOrchestratorConfig {
  return {
    protocolTimeoutMs: 60_000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ProtocolOrchestratorDeps> = {}): ProtocolOrchestratorDeps {
  return {
    poBatchPlanning: vi.fn().mockResolvedValue({
      prioritizedItems: [{ issueNumber: 1, priority: 1 }],
    }),
    tlBatchPlanning: vi.fn().mockResolvedValue({
      dependencyGraph: [],
      capacityAssessment: { available: 5 },
      healthReport: { healthy: true },
    }),
    poEscalation: vi.fn().mockResolvedValue({ decision: 'retry' }),
    tlEscalation: vi.fn().mockResolvedValue({ analysis: 'technical blocker' }),
    poStatusSync: vi.fn().mockResolvedValue(undefined),
    tlStatusSync: vi.fn().mockResolvedValue(undefined),
    poRetrospective: vi.fn().mockResolvedValue({ lessons: [] }),
    tlRetrospective: vi.fn().mockResolvedValue({ lessons: [] }),
    ...overrides,
  };
}

describe('withTimeout — timer leak regression (#453)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not leave a pending timer after the wrapped promise settles', async () => {
    vi.useFakeTimers();
    const deps = makeDeps({
      poBatchPlanning: vi.fn().mockResolvedValue({ prioritizedItems: [] }),
      tlBatchPlanning: vi.fn().mockResolvedValue({ plan: 'ok' }),
    });
    // Long timeout so it won't fire on its own during normal resolution
    const orchestrator = createProtocolOrchestrator(deps, makeConfig({ protocolTimeoutMs: 60_000 }));

    // Let the promises resolve via microtasks only — do not advance timers yet
    const resultPromise = orchestrator.batchPlanning();
    await resultPromise;

    // After the wrapped promise settled, all timer handles must be cleared.
    // A non-zero count here means withTimeout leaked a setTimeout handle.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ProtocolOrchestrator', () => {
  describe('batchPlanning()', () => {
    it('calls PO and TL services and returns combined result', async () => {
      const deps = makeDeps();
      const orchestrator = createProtocolOrchestrator(deps, makeConfig());

      const result = await orchestrator.batchPlanning();

      expect(deps.poBatchPlanning).toHaveBeenCalled();
      expect(deps.tlBatchPlanning).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.poOutput).toBeDefined();
        expect(result.value.tlOutput).toBeDefined();
      }
    });

    it('returns timeout error when protocol exceeds timeout', async () => {
      const deps = makeDeps({
        poBatchPlanning: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 120_000)),
        ),
      });
      const orchestrator = createProtocolOrchestrator(deps, makeConfig({ protocolTimeoutMs: 50 }));

      const result = await orchestrator.batchPlanning();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('timeout');
      }
    });

    it('returns error when PO service fails', async () => {
      const deps = makeDeps({
        poBatchPlanning: vi.fn().mockRejectedValue(new Error('PO unavailable')),
      });
      const orchestrator = createProtocolOrchestrator(deps, makeConfig());

      const result = await orchestrator.batchPlanning();

      expect(result.ok).toBe(false);
    });

    it('returns error when TL service fails', async () => {
      const deps = makeDeps({
        tlBatchPlanning: vi.fn().mockRejectedValue(new Error('TL unavailable')),
      });
      const orchestrator = createProtocolOrchestrator(deps, makeConfig());

      const result = await orchestrator.batchPlanning();

      expect(result.ok).toBe(false);
    });

    it('queries prospective risks and passes them to TL batch planning', async () => {
      const fakeRisks = [
        { id: 'kr-1', artifactPatterns: ['src/auth/**'], priorityTier: 'elevated' },
        { id: 'kr-2', artifactPatterns: ['src/api/**'], hitCount: 7 },
      ];
      const queryProspectiveRisks = vi.fn().mockResolvedValue(fakeRisks);
      const tlBatchPlanning = vi.fn().mockResolvedValue({ plan: 'ok' });
      const deps = makeDeps({ queryProspectiveRisks, tlBatchPlanning });
      const orchestrator = createProtocolOrchestrator(deps, makeConfig());

      const result = await orchestrator.batchPlanning();

      expect(result.ok).toBe(true);
      expect(queryProspectiveRisks).toHaveBeenCalledOnce();
      expect(tlBatchPlanning).toHaveBeenCalledWith(fakeRisks);
    });

    it('returns error when queryProspectiveRisks rejects', async () => {
      const deps = makeDeps({
        queryProspectiveRisks: vi.fn().mockRejectedValue(new Error('knowledge store unavailable')),
      });
      const orchestrator = createProtocolOrchestrator(deps, makeConfig());

      const result = await orchestrator.batchPlanning();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('knowledge store unavailable');
      }
    });

    it('passes empty array to TL when queryProspectiveRisks is not provided', async () => {
      const tlBatchPlanning = vi.fn().mockResolvedValue({ plan: 'ok' });
      const deps = makeDeps({ tlBatchPlanning });
      const orchestrator = createProtocolOrchestrator(deps, makeConfig());

      const result = await orchestrator.batchPlanning();

      expect(result.ok).toBe(true);
      expect(tlBatchPlanning).toHaveBeenCalledWith([]);
    });
  });

  describe('escalation()', () => {
    it('routes to PO for business/priority issues', async () => {
      const deps = makeDeps();
      const orchestrator = createProtocolOrchestrator(deps, makeConfig());
      const input: EscalationInput = {
        target: 'po',
        issueNumber: 42,
        reason: 'Spec ambiguity',
        options: ['retry', 'skip', 'fix_spec'],
      };

      const result = await orchestrator.escalation(input);

      expect(deps.poEscalation).toHaveBeenCalledWith(input);
      expect(result.ok).toBe(true);
    });

    it('routes to TL for technical blockers', async () => {
      const deps = makeDeps();
      const orchestrator = createProtocolOrchestrator(deps, makeConfig());
      const input: EscalationInput = {
        target: 'tl',
        issueNumber: 42,
        reason: 'Build failure',
        options: ['retry', 'skip'],
      };

      const result = await orchestrator.escalation(input);

      expect(deps.tlEscalation).toHaveBeenCalledWith(input);
      expect(result.ok).toBe(true);
    });

    it('returns timeout error when escalation exceeds timeout', async () => {
      const deps = makeDeps({
        poEscalation: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 120_000)),
        ),
      });
      const orchestrator = createProtocolOrchestrator(deps, makeConfig({ protocolTimeoutMs: 50 }));
      const input: EscalationInput = {
        target: 'po',
        issueNumber: 42,
        reason: 'test',
        options: [],
      };

      const result = await orchestrator.escalation(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('timeout');
      }
    });
  });

  describe('statusSync()', () => {
    it('calls both PO and TL status sync', async () => {
      const deps = makeDeps();
      const orchestrator = createProtocolOrchestrator(deps, makeConfig());

      const result = await orchestrator.statusSync();

      expect(deps.poStatusSync).toHaveBeenCalled();
      expect(deps.tlStatusSync).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it('returns timeout error if sync exceeds timeout', async () => {
      const deps = makeDeps({
        poStatusSync: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 120_000)),
        ),
      });
      const orchestrator = createProtocolOrchestrator(deps, makeConfig({ protocolTimeoutMs: 50 }));

      const result = await orchestrator.statusSync();

      expect(result.ok).toBe(false);
    });
  });

  describe('retrospective()', () => {
    it('calls both PO and TL retrospective and returns combined output', async () => {
      const deps = makeDeps({
        poRetrospective: vi.fn().mockResolvedValue({ lessons: ['improve estimation'] }),
        tlRetrospective: vi.fn().mockResolvedValue({ lessons: ['add retry logic'] }),
      });
      const orchestrator = createProtocolOrchestrator(deps, makeConfig());

      const result = await orchestrator.retrospective();

      expect(deps.poRetrospective).toHaveBeenCalled();
      expect(deps.tlRetrospective).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.poLessons).toEqual({ lessons: ['improve estimation'] });
        expect(result.value.tlLessons).toEqual({ lessons: ['add retry logic'] });
      }
    });

    it('returns timeout error if retrospective exceeds timeout', async () => {
      const deps = makeDeps({
        tlRetrospective: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 120_000)),
        ),
      });
      const orchestrator = createProtocolOrchestrator(deps, makeConfig({ protocolTimeoutMs: 50 }));

      const result = await orchestrator.retrospective();

      expect(result.ok).toBe(false);
    });
  });
});
