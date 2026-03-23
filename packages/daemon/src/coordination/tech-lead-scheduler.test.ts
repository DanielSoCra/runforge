// src/coordination/tech-lead-scheduler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTechLeadScheduler,
  type TechLeadSchedulerDeps,
  type TechLeadSchedulerConfig,
} from './tech-lead-scheduler.js';

function makeConfig(overrides: Partial<TechLeadSchedulerConfig> = {}): TechLeadSchedulerConfig {
  return {
    intervalMs: 7200000,
    eventDebounceMs: 300000,
    proposalExpiryMs: 7 * 24 * 60 * 60 * 1000,
    lookbackWindowMs: 48 * 60 * 60 * 1000,
    maxEntriesPerSection: 50,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TechLeadSchedulerDeps> = {}): TechLeadSchedulerDeps {
  return {
    assembleDigest: vi.fn().mockResolvedValue({ id: 'digest-1', trigger: 'scheduled', proposals: [], protocolTriggers: [], reviewFindings: [], runOutcomes: [], driftIndicators: [], deferredWork: [], testHealth: [], dependencyRisks: [], activeProposals: [], priorRejections: [], missingSources: [], assembledAt: new Date().toISOString() }),
    spawnTechLeadSession: vi.fn().mockResolvedValue('{"proposals":[],"protocolTriggers":[]}'),
    storeProposals: vi.fn().mockResolvedValue(0),
    sweepExpiredProposals: vi.fn().mockResolvedValue(0),
    routeToProtocol: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('TechLeadScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a cycle on configured interval', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    await vi.advanceTimersByTimeAsync(1100);

    expect(deps.assembleDigest).toHaveBeenCalledTimes(1);
    expect(deps.spawnTechLeadSession).toHaveBeenCalledTimes(1);
    stop();
  });

  it('sweeps expired proposals before each cycle', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    await vi.advanceTimersByTimeAsync(1100);

    expect(deps.sweepExpiredProposals).toHaveBeenCalledTimes(1);
    // sweep should be called before assembleDigest
    const sweepOrder = (deps.sweepExpiredProposals as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const digestOrder = (deps.assembleDigest as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(sweepOrder).toBeLessThan(digestOrder);
    stop();
  });

  it('stores proposals from session output', async () => {
    const deps = makeDeps({
      spawnTechLeadSession: vi.fn().mockResolvedValue(JSON.stringify({
        proposals: [{ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', proposalType: 'debt_reduction', title: 'Fix debt', evidence: [], affectedAreas: ['src/'], riskAssessment: 'low', effortEstimate: '2h', status: 'generated', poDecision: null, operatorDecision: null, priorRejectionId: null, expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString() }],
        protocolTriggers: [],
      })),
    });
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    await vi.advanceTimersByTimeAsync(1100);

    expect(deps.storeProposals).toHaveBeenCalledTimes(1);
    const storedProposals = (deps.storeProposals as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(storedProposals).toHaveLength(1);
    stop();
  });

  it('routes protocol triggers from session output', async () => {
    const deps = makeDeps({
      spawnTechLeadSession: vi.fn().mockResolvedValue(JSON.stringify({
        proposals: [],
        protocolTriggers: ['escalation', 'batch_planning'],
      })),
    });
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    await vi.advanceTimersByTimeAsync(1100);

    expect(deps.routeToProtocol).toHaveBeenCalledTimes(2);
    expect(deps.routeToProtocol).toHaveBeenCalledWith('escalation');
    expect(deps.routeToProtocol).toHaveBeenCalledWith('batch_planning');
    stop();
  });

  it('debounces event-triggered cycles', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 60000, eventDebounceMs: 500 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    // Trigger events rapidly
    scheduler.triggerEvent('run_failure');
    await vi.advanceTimersByTimeAsync(200);
    scheduler.triggerEvent('new_findings');
    await vi.advanceTimersByTimeAsync(600);

    // Only one event-triggered cycle should fire (debounced)
    expect(deps.assembleDigest).toHaveBeenCalledTimes(1);
    expect(deps.assembleDigest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({}));
    stop();
  });

  it('does not run concurrent cycles', async () => {
    let resolveSession: (() => void) | null = null;
    const deps = makeDeps({
      spawnTechLeadSession: vi.fn().mockImplementation(() => {
        return new Promise<string>((resolve) => {
          resolveSession = () => resolve('{"proposals":[],"protocolTriggers":[]}');
        });
      }),
    });
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    // First tick starts a session
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnTechLeadSession).toHaveBeenCalledTimes(1);

    // Second tick while first is running
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnTechLeadSession).toHaveBeenCalledTimes(1); // still 1

    // Resolve first
    resolveSession!();
    await vi.advanceTimersByTimeAsync(0);

    // Third tick should now run
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnTechLeadSession).toHaveBeenCalledTimes(2);

    stop();
  });

  it('stop() prevents further cycles', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    stop();

    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.assembleDigest).not.toHaveBeenCalled();
  });

  it('stop() also cancels pending event debounce', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 60000, eventDebounceMs: 500 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    scheduler.triggerEvent('run_failure');
    stop();

    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.assembleDigest).not.toHaveBeenCalled();
  });

  it('handles session failure gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({
      spawnTechLeadSession: vi.fn().mockRejectedValue(new Error('session failed')),
    });
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    await vi.advanceTimersByTimeAsync(1100);

    // Should not throw — logged and continued
    expect(consoleSpy).toHaveBeenCalled();
    // Should still schedule next cycle
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.sweepExpiredProposals).toHaveBeenCalledTimes(2);

    stop();
    consoleSpy.mockRestore();
  });

  it('handles malformed session output gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({
      spawnTechLeadSession: vi.fn().mockResolvedValue('not valid json'),
    });
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    await vi.advanceTimersByTimeAsync(1100);

    // Should not throw — treats as zero proposals
    expect(deps.storeProposals).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();

    stop();
    consoleSpy.mockRestore();
  });

  it('getStatus returns cycle count and running state', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    expect(scheduler.getStatus().cyclesRun).toBe(0);

    await vi.advanceTimersByTimeAsync(1100);
    expect(scheduler.getStatus().cyclesRun).toBe(1);

    await vi.advanceTimersByTimeAsync(1100);
    expect(scheduler.getStatus().cyclesRun).toBe(2);

    stop();
  });

  it('passes trigger type through to assembleDigest for event cycles', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 60000, eventDebounceMs: 200 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    scheduler.triggerEvent('run_failure');
    await vi.advanceTimersByTimeAsync(300);

    const callArgs = (deps.assembleDigest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(callArgs[0]).toBe('run_failure');
    stop();
  });

  it('scheduled cycles use "scheduled" trigger type', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createTechLeadScheduler(deps, config);
    const stop = scheduler.start();

    await vi.advanceTimersByTimeAsync(1100);

    const callArgs = (deps.assembleDigest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(callArgs[0]).toBe('scheduled');
    stop();
  });
});
