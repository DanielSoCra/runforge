// src/control-plane/pipeline.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPipeline, type PhaseHandlerMap } from './pipeline.js';
import { getPipeline } from './fsm.js';
import { StateManager } from './state.js';
import { CostTracker } from '../session-runtime/cost.js';
import type { RunState, PhaseEvent } from '../types.js';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Full handler maps for each variant — used in tests that provide partial handlers
// but need all phases covered for the pre-flight validation check.
const featureSimpleAllSuccess: PhaseHandlerMap = {
  detect: async () => 'success' as PhaseEvent,
  classify: async () => 'success:simple' as PhaseEvent,
  implement: async () => 'success' as PhaseEvent,
  review: async () => 'success' as PhaseEvent,
  holdout: async () => 'success' as PhaseEvent,
  integrate: async () => 'success' as PhaseEvent,
  deploy: async () => 'success' as PhaseEvent,
  test: async () => 'success' as PhaseEvent,
  report: async () => 'success' as PhaseEvent,
};

const bugAllSuccess: PhaseHandlerMap = {
  detect: async () => 'success' as PhaseEvent,
  implement: async () => 'success' as PhaseEvent,
  review: async () => 'success' as PhaseEvent,
  integrate: async () => 'success' as PhaseEvent,
  deploy: async () => 'success' as PhaseEvent,
  test: async () => 'success' as PhaseEvent,
  report: async () => 'success' as PhaseEvent,
};

const specDrivenAllSuccess: PhaseHandlerMap = {
  detect: async () => 'success' as PhaseEvent,
  'l2-design': async () => 'success' as PhaseEvent,
  'l2-gate': async () => 'success' as PhaseEvent,
  'l3-generate': async () => 'success' as PhaseEvent,
  'l3-compliance': async () => 'success' as PhaseEvent,
  implement: async () => 'success' as PhaseEvent,
  review: async () => 'success' as PhaseEvent,
  holdout: async () => 'success' as PhaseEvent,
  integrate: async () => 'success' as PhaseEvent,
  report: async () => 'success' as PhaseEvent,
};

const makeRun = (variant: 'feature' | 'feature-simple' | 'bug' | 'spec-driven' = 'feature-simple'): RunState => ({
  id: 'test-run-id',
  issueNumber: 1,
  title: 'Test',
  phase: 'detect',
  variant,
  phaseCompletions: {},
  checkpoints: [],
  cost: 0,
  perRunBudget: 10,
  fixAttempts: [],
  errorHashes: {},
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe('runPipeline', () => {
  let stateMgr: StateManager;
  let costTracker: CostTracker;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pipeline-'));
    stateMgr = new StateManager(dir);
    await stateMgr.initialize();
    costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
  });

  it('runs feature-simple pipeline to completion with all-success handlers', async () => {
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
      classify: async () => 'success:simple' as PhaseEvent,
      implement: async () => 'success' as PhaseEvent,
      review: async () => 'success' as PhaseEvent,
      holdout: async () => 'success' as PhaseEvent,
      integrate: async () => 'success' as PhaseEvent,
      deploy: async () => 'success' as PhaseEvent,
      test: async () => 'success' as PhaseEvent,
      report: async () => 'success' as PhaseEvent,
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('complete');
  });

  it('transitions to stuck after max retries on implement failure', async () => {
    let attempts = 0;
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => { attempts++; return 'failure' as PhaseEvent; },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    expect(attempts).toBe(3); // default max retries
  });

  it('pauses when budget exceeded', async () => {
    costTracker.recordCost(1, 51); // exceed daily budget
    const handlers: PhaseHandlerMap = { ...featureSimpleAllSuccess };
    const run = makeRun();
    run.phase = 'implement';
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('paused');
  });

  it('transitions to stuck when per-run budget exceeded (#92)', async () => {
    costTracker.recordCost(1, 11); // exceed per-run budget of 10
    const handlers: PhaseHandlerMap = { ...featureSimpleAllSuccess };
    const run = makeRun();
    run.phase = 'implement';
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    expect(run.phase).toBe('stuck');
  });

  it('pauses on budget-exceeded event from handler', async () => {
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => 'budget-exceeded' as PhaseEvent,
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('paused');
  });

  it('transitions to stuck on per-run-budget-exceeded event from handler (#92)', async () => {
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => 'per-run-budget-exceeded' as PhaseEvent,
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    expect(run.phase).toBe('stuck');
  });

  it('saves state after each phase transition', async () => {
    const saveSpy = vi.spyOn(stateMgr, 'saveRunState');
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
      classify: async () => 'success:simple' as PhaseEvent,
      implement: async () => 'success' as PhaseEvent,
      review: async () => 'success' as PhaseEvent,
      holdout: async () => 'success' as PhaseEvent,
      integrate: async () => 'success' as PhaseEvent,
      deploy: async () => 'success' as PhaseEvent,
      test: async () => 'success' as PhaseEvent,
      report: async () => 'success' as PhaseEvent,
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(saveSpy.mock.calls.length).toBeGreaterThan(5);
  });

  it('handles exceptions in phase handlers as failures', async () => {
    let attempts = 0;
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => { attempts++; throw new Error('boom'); },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    expect(attempts).toBe(3);
  });

  it('preserves error context from thrown exceptions in stuck result (#12)', async () => {
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => { throw new Error('database connection refused'); },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    expect(result.error).toBeDefined();
    expect(result.error).toContain('database connection refused');
  });

  it('preserves error context from non-Error thrown values (#12)', async () => {
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => { throw 'string error'; },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    expect(result.error).toBeDefined();
    expect(result.error).toContain('string error');
  });

  it('transitions to stuck on circular error before exhausting retries (#88)', async () => {
    let attempts = 0;
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => { attempts++; throw new Error('connection refused at db:5432'); },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    // Set maxAttempts to 5 so circular detection (threshold 3) fires before retries exhaust
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker, {
      maxAttempts: { implement: 5 },
    });
    expect(result.outcome).toBe('stuck');
    expect(result.error).toContain('Circular error detected');
    expect(attempts).toBe(3); // stopped at 3 (circular), not 5 (max retries)
    expect(Object.values(run.errorHashes).some((count) => count >= 3)).toBe(true);
  });

  it('does not trigger circular detection for distinct errors (#88)', async () => {
    let attempts = 0;
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => {
        attempts++;
        // Each attempt throws a different error — no circular pattern
        throw new Error(`unique error ${attempts}`);
      },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    // Should exhaust retries, not circular detection
    expect(result.error).not.toContain('Circular error detected');
    expect(attempts).toBe(3);
  });

  it('records error hashes on run.errorHashes across failures (#88)', async () => {
    let attempts = 0;
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => { attempts++; throw new Error('same error every time'); },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    await runPipeline(run, table, handlers, stateMgr, costTracker);
    // errorHashes should be populated (not empty as before the fix)
    expect(Object.keys(run.errorHashes).length).toBeGreaterThan(0);
  });

  it('resets retry counter when phase advances then loops back (#103)', async () => {
    // Scenario: implement fails twice → succeeds → review fails → back to implement
    // The implement retry counter must be reset when moving to review,
    // so implement gets a fresh 3 retries after review sends it back.
    let implementCalls = 0;
    let reviewCalls = 0;
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => {
        implementCalls++;
        // Fail twice, then succeed, then after review failure, fail 3 more times
        if (implementCalls <= 2) return 'failure' as PhaseEvent;
        if (implementCalls === 3) return 'success' as PhaseEvent;
        // After review→implement loop, fail to eventually hit stuck
        return 'failure' as PhaseEvent;
      },
      review: async () => {
        reviewCalls++;
        // First review always fails → sends back to implement
        return 'failure' as PhaseEvent;
      },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);

    // implement: fail(1), fail(2), success(3) → review: fail → implement: fail(4), fail(5), fail(6) → stuck
    // If retry counter were NOT reset, implement would have stuck after call 4 (3rd retry overall).
    // With reset, implement gets 3 fresh retries after review, so calls 4,5,6 all execute.
    expect(implementCalls).toBe(6);
    expect(reviewCalls).toBe(1);
    expect(result.outcome).toBe('stuck');
  });

  it('resets retry counter across multiple review→implement cycles (#103)', async () => {
    // implement succeeds → review fails → implement succeeds → review fails → ...
    // Retry counter resets each time, so this never gets stuck from retries
    let implementCalls = 0;
    let reviewCalls = 0;
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
      classify: async () => 'success:simple' as PhaseEvent,
      implement: async () => {
        implementCalls++;
        return 'success' as PhaseEvent;
      },
      review: async () => {
        reviewCalls++;
        if (reviewCalls <= 3) return 'failure' as PhaseEvent;
        return 'success' as PhaseEvent;
      },
      holdout: async () => 'success' as PhaseEvent,
      integrate: async () => 'success' as PhaseEvent,
      deploy: async () => 'success' as PhaseEvent,
      test: async () => 'success' as PhaseEvent,
      report: async () => 'success' as PhaseEvent,
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);

    // implement(1)→review(1,fail)→implement(2)→review(2,fail)→implement(3)→review(3,fail)→implement(4)→review(4,pass)→...→complete
    expect(implementCalls).toBe(4);
    expect(reviewCalls).toBe(4);
    expect(result.outcome).toBe('complete');
  });

  it('syncs run.cost from costTracker after every phase (#132)', async () => {
    // Simulate sessions recording costs during implement + review phases.
    // Before this fix, only implement costs were accumulated in run.cost.
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
      implement: async () => {
        // Simulates runtime.spawnSession recording implementation cost
        costTracker.recordCost(1, 2.00);
        return 'success' as PhaseEvent;
      },
      review: async () => {
        // Simulates runtime.spawnSession recording review cost
        costTracker.recordCost(1, 0.75);
        return 'success' as PhaseEvent;
      },
      integrate: async () => 'success' as PhaseEvent,
      deploy: async () => 'success' as PhaseEvent,
      test: async () => 'success' as PhaseEvent,
      report: async () => 'success' as PhaseEvent,
    };
    const run = makeRun('bug');
    const table = getPipeline('bug');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('complete');
    // run.cost must include ALL phase costs, not just implement
    expect(run.cost).toBe(2.75); // 2.00 + 0.75
  });

  it('transitions to stuck on containment-breach event from handler (#208)', async () => {
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => 'containment-breach' as PhaseEvent,
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    expect(run.phase).toBe('stuck');
  });

  describe('handler existence validation', () => {
    it('returns stuck when transition table has phase with no handler', async () => {
      // Build a minimal table that references 'missing_phase' but provide no handler for it
      const table = {
        detect: { success: { next: 'missing_phase' as any } },
        missing_phase: { success: { next: 'report' as any } },
        report: { success: { next: 'report' as any } },
      };
      const handlers: PhaseHandlerMap = {
        detect: async () => 'success' as PhaseEvent,
        report: async () => 'success' as PhaseEvent,
        // missing_phase intentionally absent
      };
      const run = makeRun('feature-simple');
      const result = await runPipeline(run, table as any, handlers, stateMgr, costTracker);
      expect(result.outcome).toBe('stuck');
      expect(result.error).toMatch(/Missing handlers.*missing_phase/);
    });
  });

  describe('parked outcome', () => {
    it('returns parked when handler sets pausedAtPhase', async () => {
      const handlers: PhaseHandlerMap = {
        ...featureSimpleAllSuccess,
        detect: async (run) => {
          run.pausedAtPhase = 'detect';
          return 'success' as PhaseEvent;
        },
      };
      const run = makeRun('feature-simple');
      const table = getPipeline('feature-simple');
      const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
      expect(result.outcome).toBe('parked');
      expect(run.phase).toBe('paused');
    });

    it('budget-exceeded still returns paused (not parked)', async () => {
      const handlers: PhaseHandlerMap = {
        ...featureSimpleAllSuccess,
        implement: async () => 'budget-exceeded' as PhaseEvent,
      };
      const run = makeRun('feature-simple');
      const table = getPipeline('feature-simple');
      const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
      expect(result.outcome).toBe('paused');
    });
  });

  it('containment-breach bypasses retry logic — no second attempt (#208)', async () => {
    let attempts = 0;
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => { attempts++; return 'containment-breach' as PhaseEvent; },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    expect(attempts).toBe(1); // terminal — no retries
  });

  // Regression for #449: spec-driven holdout.failure must route to implement (not stuck).
  // Without the fix, the FSM had no transition for holdout:failure and pipeline.ts would
  // force run.phase = 'stuck'. This test drives the full path through runPipeline.
  it('spec-driven: holdout failure routes to implement retry, then completes (regression #449)', async () => {
    let holdoutCalls = 0;
    let implementCallsAfterHoldout = 0;
    let holdoutDone = false;
    const handlers: PhaseHandlerMap = {
      ...specDrivenAllSuccess,
      holdout: async () => {
        holdoutCalls++;
        if (holdoutCalls === 1) return 'failure' as PhaseEvent; // Type A: retry via implement
        return 'success' as PhaseEvent;
      },
      implement: async () => {
        if (holdoutDone) implementCallsAfterHoldout++;
        else holdoutDone = holdoutCalls > 0; // first holdout failure has fired
        return 'success' as PhaseEvent;
      },
    };
    const run = makeRun('spec-driven');
    const table = getPipeline('spec-driven');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('complete');
    expect(run.phase).not.toBe('stuck');
    expect(holdoutCalls).toBe(2); // failed once, then passed on retry
  });

  it('calls runWriter.upsertRun on phase transitions', async () => {
    const upsertRun = vi.fn().mockResolvedValue(undefined);
    const runWriter = { upsertRun, writeCostEvent: vi.fn() } as any;

    const run = makeRun();
    const handlers: PhaseHandlerMap = { ...featureSimpleAllSuccess };
    await runPipeline(run, getPipeline('feature-simple'), handlers, stateMgr, costTracker, undefined, runWriter);
    expect(upsertRun).toHaveBeenCalled();
    const firstCall = upsertRun.mock.calls[0]!;
    expect(firstCall[0]).toBe('test-run-id');
    expect(firstCall[1]).toHaveProperty('current_phase');
    expect(firstCall[1]).toHaveProperty('phases');
    expect(Array.isArray(firstCall[1].phases)).toBe(true);
  });

  // Cross-phase loop integration test (#437): drives the FSM through a real
  // l3-compliance ↔ l3-generate cycle to prove the cap actually terminates.
  // pipeline.ts's retry tracker only counts SELF-loops, so the cross-phase
  // bound must come from run.l3ComplianceAttempts + the 'escalated' outcome.
  // Without that, this test would run forever.
  describe('l3-compliance ↔ l3-generate cross-phase loop is capped (#437)', () => {
    it('loops at most MAX_L3_COMPLIANCE_ATTEMPTS times then routes to stuck', async () => {
      let l3GenerateCalls = 0;
      let l3ComplianceCalls = 0;
      const seenFeedback: string[] = [];

      const handlers: PhaseHandlerMap = {
        // All other spec-driven phases need handlers for pre-flight validation,
        // even though the run terminates in l3-compliance before reaching them.
        detect: async () => 'success' as PhaseEvent,
        'l2-design': async () => 'success' as PhaseEvent,
        'l2-gate': async () => 'success' as PhaseEvent,
        implement: async () => 'success' as PhaseEvent,
        review: async () => 'success' as PhaseEvent,
        holdout: async () => 'success' as PhaseEvent,
        integrate: async () => 'success' as PhaseEvent,
        report: async () => 'success' as PhaseEvent,

        // The two phases under test:
        'l3-generate': async (r) => {
          l3GenerateCalls += 1;
          seenFeedback.push(r.l3Feedback ?? '');
          return 'success' as PhaseEvent;
        },
        'l3-compliance': async (r) => {
          l3ComplianceCalls += 1;
          // Simulate a noncompliance finding every time. Increment the
          // cross-phase counter and stash feedback for the next l3-generate.
          const nextAttempt = (r.l3ComplianceAttempts ?? 0) + 1;
          r.l3Feedback = `attempt ${nextAttempt}: missing field X`.slice(0, 4000);
          r.l3ComplianceAttempts = nextAttempt;
          // Third failure escalates → stuck (matches phases.ts MAX cap of 3)
          return nextAttempt >= 3 ? ('escalated' as PhaseEvent) : ('failure' as PhaseEvent);
        },
      };

      const run = makeRun('spec-driven');
      run.phase = 'l3-generate'; // start mid-pipeline
      const table = getPipeline('spec-driven');
      const result = await runPipeline(run, table, handlers, stateMgr, costTracker);

      // FSM terminated rather than infinite-looping
      expect(result.outcome).toBe('stuck');
      expect(run.phase).toBe('stuck');

      // Both phases ran exactly 3 times (initial + 2 retries before escalation)
      expect(l3GenerateCalls).toBe(3);
      expect(l3ComplianceCalls).toBe(3);

      // Feedback flows from each compliance failure into the next l3-generate
      expect(seenFeedback[0]).toBe(''); // first generate, no prior feedback
      expect(seenFeedback[1]).toContain('attempt 1'); // sees first failure
      expect(seenFeedback[2]).toContain('attempt 2'); // sees second failure
    });
  });
});
