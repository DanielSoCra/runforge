import { describe, it, expect, vi } from 'vitest';
import { DecisionRequestSchema } from '@runforge/decision-protocol';
import type { RunState } from '../types.js';
import {
  checkDeploymentBudget,
  buildDeploymentBudgetDecisionId,
  buildDeploymentBudgetDecisionRequest,
  budgetEpoch,
  type DeploymentBudgetDeps,
} from './deployment-budget.js';

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: `run-${overrides.issueNumber ?? 500}`,
    issueNumber: overrides.issueNumber ?? 500,
    title: 'deployment budget gate run',
    phase: 'implement',
    variant: 'feature-simple',
    phaseCompletions: { detect: true, classify: true },
    checkpoints: [],
    cost: 0,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    deploymentId: 'deploy-alpha',
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

function makeAccumulator(seed: { ts: string; deploymentId: string; cost: number }[] = []) {
  const records = [...seed];
  return {
    records,
    totalForDeployment: vi.fn((deploymentId: string) =>
      records
        .filter((entry) => entry.deploymentId === deploymentId)
        .reduce((sum, entry) => sum + entry.cost, 0),
    ),
    append: vi.fn(async (entry: { ts: string; deploymentId: string; cost: number }) => {
      records.push(entry);
    }),
  };
}

function makeRegistry(budgets: Record<string, number>): DeploymentBudgetDeps['registry'] {
  return {
    readDeclaredData: vi.fn((deploymentId: string, _which: 'budget') => {
      const budget = budgets[deploymentId];
      if (typeof budget !== 'number') {
        return { kind: 'not-found' as const, deploymentId };
      }
      return { kind: 'found' as const, which: 'budget' as const, value: budget };
    }),
  } as unknown as DeploymentBudgetDeps['registry'];
}

function makeLedger() {
  return {
    raise: vi.fn(async (_request: Record<string, unknown>) => ({
      decision_id: 'deployment-budget:deploy-alpha',
      outcome: 'admitted',
    })),
  };
}

describe('deployment-budget', () => {
  describe('checkDeploymentBudget', () => {
    it('hard-aborts and raises when accumulated spend plus perRunBudget exceeds budget', async () => {
      const accumulator = makeAccumulator([
        { ts: '2026-07-02T00:00:00.000Z', deploymentId: 'deploy-alpha', cost: 95 },
      ]);
      const registry = makeRegistry({ 'deploy-alpha': 100 });
      const ledger = makeLedger();

      const result = await checkDeploymentBudget(
        makeRun({ issueNumber: 501, perRunBudget: 10 }),
        { accumulator, registry, ledger },
      );

      expect(result).toMatchObject({ proceed: false });
      expect(ledger.raise).toHaveBeenCalledTimes(1);
      const raised = ledger.raise.mock.calls[0]?.[0];
      expect(raised).toMatchObject({
        deploymentId: 'deploy-alpha',
        issueNumber: 501,
      });
      expect(
        String(raised?.reason ?? raised?.question ?? raised?.context ?? ''),
      ).toMatch(/budget/i);
    });

    it('proceeds when projected deployment spend is under budget', async () => {
      const accumulator = makeAccumulator([
        { ts: '2026-07-02T00:00:00.000Z', deploymentId: 'deploy-alpha', cost: 35 },
      ]);
      const registry = makeRegistry({ 'deploy-alpha': 100 });
      const ledger = makeLedger();

      const result = await checkDeploymentBudget(
        makeRun({ issueNumber: 502, perRunBudget: 10 }),
        { accumulator, registry, ledger },
      );

      expect(result).toMatchObject({ proceed: true });
      expect(ledger.raise).not.toHaveBeenCalled();
    });

    it('fails closed and raises when the deployment budget is not found', async () => {
      const accumulator = makeAccumulator();
      const registry = makeRegistry({});
      const ledger = makeLedger();

      const result = await checkDeploymentBudget(
        makeRun({ issueNumber: 505, perRunBudget: 10 }),
        { accumulator, registry, ledger },
      );

      expect(result).toMatchObject({
        proceed: false,
        reason: 'deployment budget not found',
        deploymentId: 'deploy-alpha',
      });
      expect(ledger.raise).toHaveBeenCalledTimes(1);
      const raised = ledger.raise.mock.calls[0]?.[0];
      expect(raised).toMatchObject({
        deploymentId: 'deploy-alpha',
        issueNumber: 505,
      });
    });
  });

  describe('buildDeploymentBudgetDecisionRequest', () => {
    it('produces a decision id that is deterministic per (deployment, issue, epoch)', () => {
      const id1 = buildDeploymentBudgetDecisionId('deploy-alpha', 42, '2026-W27');
      const id2 = buildDeploymentBudgetDecisionId('deploy-alpha', 42, '2026-W27');
      const id3 = buildDeploymentBudgetDecisionId('deploy-alpha', 43, '2026-W27');
      expect(id1).toBe(id2);
      expect(id1).not.toBe(id3);
      expect(id1).toMatch(/budget/i);
    });

    it('parses through the REAL DecisionRequestSchema', () => {
      const request = buildDeploymentBudgetDecisionRequest({
        issueNumber: 42,
        deploymentId: 'deploy-alpha',
        totalSpend: 90,
        projectedSpend: 100,
        budget: 95,
        owner: 'acme',
        repo: 'app',
        now: '2026-07-02T00:00:00.000Z',
      });
      expect(() => DecisionRequestSchema.parse(request)).not.toThrow();
      expect(request.deployment).toBe('deploy-alpha');
      expect(request.options.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('budgetEpoch', () => {
    it('returns an ISO-week token and is stable across the same week', () => {
      const monday = new Date('2026-07-06T00:00:00.000Z');
      const wednesday = new Date('2026-07-08T12:00:00.000Z');
      const sunday = new Date('2026-07-12T23:59:59.000Z');
      expect(budgetEpoch(monday)).toBe(budgetEpoch(wednesday));
      expect(budgetEpoch(monday)).toBe(budgetEpoch(sunday));
    });
  });
});
