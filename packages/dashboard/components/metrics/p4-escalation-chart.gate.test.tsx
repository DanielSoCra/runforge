// G3: acceptance gate for the absent escalation-trend chart component.
// components/metrics/escalation-trend-chart.tsx does not exist yet, so the dynamic
// import guard fails at RED; it passes once the component renders the two series
// (escalations/week + operator-touches-per-delivered) from seeded trend rows and
// tolerates an empty/degraded dataset. Mirrors the recharts precedent in cost-chart.tsx.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ComponentType } from 'react';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface EscalationTrendRow {
  weekStart: string;
  deploymentId: string;
  raised: number;
  answered: number;
  autoMerges: number;
  operatorTouchesPerDelivered: number | null;
}

type EscalationTrendChart = ComponentType<{ data: EscalationTrendRow[] }>;

async function loadEscalationTrendChart(): Promise<EscalationTrendChart> {
  let mod: Record<string, unknown> = {};
  // Variable path + @vite-ignore: a literal dynamic import of a not-yet-existing
  // module fails at Vite TRANSFORM time (crashes collection) rather than runtime;
  // deferring resolution lets the try/catch below turn "absent" into a RED
  // existence assertion instead of an uncatchable transform error.
  const modulePath = './escalation-trend-chart';
  try {
    mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  } catch {
    // Component not implemented yet — fall through to the existence assertion.
  }
  const component = (mod.EscalationTrendChart ?? mod.default) as
    | EscalationTrendChart
    | undefined;
  expect(
    component,
    'EscalationTrendChart export must exist before G3 can pass',
  ).toBeTypeOf('function');
  return component!;
}

const seeded: EscalationTrendRow[] = [
  {
    weekStart: '2026-06-01',
    deploymentId: 'deploy-alpha',
    raised: 3,
    answered: 2,
    autoMerges: 2,
    operatorTouchesPerDelivered: 0.5,
  },
  {
    weekStart: '2026-06-08',
    deploymentId: 'deploy-alpha',
    raised: 1,
    answered: 1,
    autoMerges: 4,
    operatorTouchesPerDelivered: 0.2,
  },
];

describe('P4 G3 escalation-trend chart acceptance gate', () => {
  it('renders the seeded trend without throwing and produces chart output', async () => {
    const EscalationTrendChart = await loadEscalationTrendChart();
    const { container } = render(<EscalationTrendChart data={seeded} />);
    // recharts renders into an SVG (or, under jsdom's zero-width ResponsiveContainer,
    // at least a non-empty wrapper); the gate requires the component to mount and
    // emit markup rather than an empty fragment.
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it('tolerates an empty/degraded dataset without throwing', async () => {
    const EscalationTrendChart = await loadEscalationTrendChart();
    expect(() => render(<EscalationTrendChart data={[]} />)).not.toThrow();
  });
});
