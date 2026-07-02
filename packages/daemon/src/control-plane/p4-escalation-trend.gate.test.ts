// G1: acceptance gate for the absent pure escalation trend aggregation module.
import { afterEach, describe, expect, it, vi } from 'vitest';

type MetricEvent = {
  ts: string | number;
  deploymentId: string;
};

type EscalationTrendInput = {
  raisedEvents: MetricEvent[];
  answeredEvents: MetricEvent[];
  autoMergeEvents: MetricEvent[];
};

type EscalationTrendOptions = {
  weeks: number;
};

type EscalationTrendRow = {
  weekStart: string;
  deploymentId: string;
  raised: number;
  answered: number;
  autoMerges: number;
  operatorTouchesPerDelivered: number | null;
};

type ComputeEscalationTrend = (
  events: EscalationTrendInput,
  opts: EscalationTrendOptions,
) => EscalationTrendRow[];

afterEach(() => {
  vi.useRealTimers();
});

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

async function loadComputeEscalationTrend(): Promise<ComputeEscalationTrend> {
  const modulePath: string = './escalation-metrics.js';
  const module = await importOptionalModule(modulePath);
  const computeEscalationTrend = module.computeEscalationTrend as
    | ComputeEscalationTrend
    | undefined;

  expect(
    computeEscalationTrend,
    'computeEscalationTrend export must exist before G1 can pass',
  ).toBeTypeOf('function');

  return computeEscalationTrend!;
}

function normalizeWeekStart(value: string): string {
  return value.slice(0, 10);
}

function normalizeRows(rows: EscalationTrendRow[]): EscalationTrendRow[] {
  return rows
    .map((row) => ({
      weekStart: normalizeWeekStart(row.weekStart),
      deploymentId: row.deploymentId,
      raised: row.raised,
      answered: row.answered,
      autoMerges: row.autoMerges,
      operatorTouchesPerDelivered: row.operatorTouchesPerDelivered,
    }))
    .sort((a, b) =>
      `${a.weekStart}:${a.deploymentId}`.localeCompare(
        `${b.weekStart}:${b.deploymentId}`,
      ),
    );
}

describe('P4 G1 escalation trend acceptance gate', () => {
  it('computes weekly per-deployment counts and uses null for zero delivered rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));

    const computeEscalationTrend = await loadComputeEscalationTrend();

    const rows = computeEscalationTrend(
      {
        raisedEvents: [
          { ts: '2026-06-02T10:00:00.000Z', deploymentId: 'deploy-alpha' },
          { ts: '2026-06-03T10:00:00.000Z', deploymentId: 'deploy-alpha' },
          { ts: '2026-06-04T10:00:00.000Z', deploymentId: 'deploy-beta' },
          { ts: '2026-06-10T09:00:00.000Z', deploymentId: 'deploy-alpha' },
        ],
        answeredEvents: [
          { ts: '2026-06-05T12:00:00.000Z', deploymentId: 'deploy-alpha' },
          { ts: '2026-06-06T09:00:00.000Z', deploymentId: 'deploy-beta' },
          { ts: '2026-06-06T11:00:00.000Z', deploymentId: 'deploy-beta' },
          { ts: '2026-06-12T15:00:00.000Z', deploymentId: 'deploy-beta' },
        ],
        autoMergeEvents: [
          { ts: '2026-06-07T08:00:00.000Z', deploymentId: 'deploy-alpha' },
          { ts: '2026-06-09T10:00:00.000Z', deploymentId: 'deploy-beta' },
          { ts: '2026-06-10T10:00:00.000Z', deploymentId: 'deploy-beta' },
        ],
      },
      { weeks: 2 },
    );

    expect(normalizeRows(rows)).toEqual([
      {
        weekStart: '2026-06-01',
        deploymentId: 'deploy-alpha',
        raised: 2,
        answered: 1,
        autoMerges: 1,
        operatorTouchesPerDelivered: 0.5,
      },
      {
        weekStart: '2026-06-01',
        deploymentId: 'deploy-beta',
        raised: 1,
        answered: 2,
        autoMerges: 0,
        operatorTouchesPerDelivered: 1,
      },
      {
        weekStart: '2026-06-08',
        deploymentId: 'deploy-alpha',
        raised: 1,
        answered: 0,
        autoMerges: 0,
        operatorTouchesPerDelivered: null,
      },
      {
        weekStart: '2026-06-08',
        deploymentId: 'deploy-beta',
        raised: 0,
        answered: 1,
        autoMerges: 2,
        operatorTouchesPerDelivered: 1 / 3,
      },
    ]);

    const zeroDelivered = rows.find(
      (row) =>
        normalizeWeekStart(row.weekStart) === '2026-06-08' &&
        row.deploymentId === 'deploy-alpha',
    );
    expect(zeroDelivered?.operatorTouchesPerDelivered).toBeNull();
    expect(Number.isNaN(zeroDelivered?.operatorTouchesPerDelivered)).toBe(false);
  });
});
