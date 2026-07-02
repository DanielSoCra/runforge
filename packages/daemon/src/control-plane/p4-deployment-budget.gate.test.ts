import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../types.js';

type DeploymentSpendEntry = {
  ts: string;
  deploymentId: string;
  cost: number;
};

type DeploymentSpendAccumulator = {
  totalForDeployment: (deploymentId: string) => number;
  append: (entry: DeploymentSpendEntry) => void | Promise<void>;
};

type DeploymentBudgetRegistry = {
  readDeclaredData: (
    deploymentId: string,
    which: 'budget',
  ) =>
    | { kind: 'found'; which: 'budget'; value: number }
    | { kind: 'not-found'; deploymentId: string };
};

type DeploymentBudgetLedger = {
  raise: (
    request: Record<string, unknown>,
  ) => Promise<{ decision_id: string; outcome: string }>;
};

type DeploymentBudgetDeps = {
  accumulator: DeploymentSpendAccumulator;
  registry: DeploymentBudgetRegistry;
  ledger: DeploymentBudgetLedger;
};

type DeploymentBudgetDecision = {
  proceed: boolean;
  reason?: string;
  deploymentId?: string;
  projectedSpend?: number;
  budget?: number;
};

type CheckDeploymentBudget = (
  run: RunState,
  deps: DeploymentBudgetDeps,
) => DeploymentBudgetDecision | Promise<DeploymentBudgetDecision>;

type RecordDeploymentSpend = (
  run: RunState,
  deps: Pick<DeploymentBudgetDeps, 'accumulator'>,
) => void | Promise<void>;

afterEach(() => {
  vi.useRealTimers();
});

// Contract choice: deps are the trailing arg; hard aborts return { proceed: false } and raise through deps.ledger.
async function importOptionalModule(
  modulePath: string,
): Promise<Record<string, unknown>> {
  try {
    const loaded: unknown = await import(/* @vite-ignore */ modulePath);
    return loaded as Record<string, unknown>;
  } catch (error: unknown) {
    if (isMissingModuleError(error, modulePath)) return {};
    throw error;
  }
}

function isMissingModuleError(error: unknown, modulePath: string): boolean {
  const requested = modulePath.startsWith('./') ? modulePath.slice(2) : modulePath;
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (
    (text.includes(modulePath) || text.includes(requested)) &&
    (text.includes('Cannot find module') ||
      text.includes('ERR_MODULE_NOT_FOUND') ||
      text.includes('Failed to load url') ||
      text.includes('Does the file exist'))
  );
}

async function loadCheckDeploymentBudget(): Promise<CheckDeploymentBudget> {
  const modulePath: string = './deployment-budget.js';
  const module = await importOptionalModule(modulePath);
  const checkDeploymentBudget = module.checkDeploymentBudget as
    | CheckDeploymentBudget
    | undefined;

  expect(
    checkDeploymentBudget,
    'checkDeploymentBudget export must exist before G4 can pass',
  ).toBeTypeOf('function');

  return checkDeploymentBudget!;
}

async function loadRecordDeploymentSpend(): Promise<RecordDeploymentSpend> {
  const modulePath: string = './deployment-budget.js';
  const module = await importOptionalModule(modulePath);
  const recordDeploymentSpend = module.recordDeploymentSpend as
    | RecordDeploymentSpend
    | undefined;

  expect(
    recordDeploymentSpend,
    'recordDeploymentSpend export must exist before G4 can pass',
  ).toBeTypeOf('function');

  return recordDeploymentSpend!;
}

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

function makeAccumulator(
  seed: DeploymentSpendEntry[] = [],
): DeploymentSpendAccumulator & { records: DeploymentSpendEntry[] } {
  const records = [...seed];
  return {
    records,
    totalForDeployment: vi.fn((deploymentId: string) =>
      records
        .filter((entry) => entry.deploymentId === deploymentId)
        .reduce((sum, entry) => sum + entry.cost, 0),
    ),
    append: vi.fn(async (entry: DeploymentSpendEntry) => {
      records.push(entry);
    }),
  };
}

function makeRegistry(budgets: Record<string, number>): DeploymentBudgetRegistry {
  return {
    readDeclaredData: vi.fn((deploymentId: string, which: 'budget') => {
      const budget = budgets[deploymentId];
      if (typeof budget !== 'number') {
        return { kind: 'not-found' as const, deploymentId };
      }
      return { kind: 'found' as const, which, value: budget };
    }),
  };
}

function makeLedger() {
  return {
    raise: vi.fn(async (_request: Record<string, unknown>) => ({
      decision_id: 'deployment-budget:deploy-alpha',
      outcome: 'admitted',
    })),
  };
}

describe('P4 G4 deployment budget acceptance gate', () => {
  it('hard-aborts and raises fail-closed escalation when accumulated spend plus perRunBudget exceeds budget', async () => {
    const checkDeploymentBudget = await loadCheckDeploymentBudget();
    const accumulator = makeAccumulator([
      {
        ts: '2026-07-02T00:00:00.000Z',
        deploymentId: 'deploy-alpha',
        cost: 95,
      },
    ]);
    const registry = makeRegistry({ 'deploy-alpha': 100 });
    const ledger = makeLedger();

    const result = await checkDeploymentBudget(
      makeRun({ issueNumber: 501, perRunBudget: 10 }),
      { accumulator, registry, ledger },
    );

    expect(result).toMatchObject({ proceed: false });
    expect(registry.readDeclaredData).toHaveBeenCalledWith('deploy-alpha', 'budget');
    expect(accumulator.totalForDeployment).toHaveBeenCalledWith('deploy-alpha');
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

  it('proceeds and does not raise when projected deployment spend is under budget', async () => {
    const checkDeploymentBudget = await loadCheckDeploymentBudget();
    const accumulator = makeAccumulator([
      {
        ts: '2026-07-02T00:00:00.000Z',
        deploymentId: 'deploy-alpha',
        cost: 35,
      },
    ]);
    const registry = makeRegistry({ 'deploy-alpha': 100 });
    const ledger = makeLedger();

    const result = await checkDeploymentBudget(
      makeRun({ issueNumber: 502, perRunBudget: 10 }),
      { accumulator, registry, ledger },
    );

    expect(result).toMatchObject({ proceed: true });
    expect(registry.readDeclaredData).toHaveBeenCalledWith('deploy-alpha', 'budget');
    expect(accumulator.totalForDeployment).toHaveBeenCalledWith('deploy-alpha');
    expect(ledger.raise).not.toHaveBeenCalled();
  });

  it('records completed spend and a subsequent budget check enforces the increased deployment total', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-02T10:00:00.000Z'));

    const checkDeploymentBudget = await loadCheckDeploymentBudget();
    const recordDeploymentSpend = await loadRecordDeploymentSpend();
    const accumulator = makeAccumulator();
    const registry = makeRegistry({ 'deploy-alpha': 50 });
    const ledger = makeLedger();

    await recordDeploymentSpend(
      makeRun({ issueNumber: 503, cost: 45, perRunBudget: 10 }),
      { accumulator },
    );

    expect(accumulator.records).toEqual([
      expect.objectContaining({
        ts: '2026-07-02T10:00:00.000Z',
        deploymentId: 'deploy-alpha',
        cost: 45,
      }),
    ]);
    expect(accumulator.totalForDeployment('deploy-alpha')).toBe(45);

    // Wiring invariant: every runPipeline entry (fresh, crash-resume, parked-resume) must call this guard before dispatch.
    const result = await checkDeploymentBudget(
      makeRun({ issueNumber: 504, cost: 0, perRunBudget: 10 }),
      { accumulator, registry, ledger },
    );

    expect(result).toMatchObject({ proceed: false });
    expect(ledger.raise).toHaveBeenCalledTimes(1);
  });
});
