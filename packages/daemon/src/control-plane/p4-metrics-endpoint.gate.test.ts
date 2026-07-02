// G2: acceptance gate for the absent GET /metrics/escalation control-plane route.
// The route + its handler do not exist yet, so booting the REAL createControlServer
// and hitting the path fails at HEAD; it passes once server.ts dispatches the route
// to an injected getEscalationMetrics handler (parity with GET /decisions/pending).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createControlServer, type ControlHandlers } from './server.js';

let serverRef: Server | undefined;

afterEach(async () => {
  if (serverRef !== undefined) {
    const server = serverRef;
    serverRef = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type MetricsHandlerResult = { status: number; body: unknown };
type EscalationMetricsHandler = (
  query: URLSearchParams,
) => MetricsHandlerResult | Promise<MetricsHandlerResult>;

// getEscalationMetrics is NOT yet a member of ControlHandlers — inject it via a
// loosely-typed handlers object so this file typechecks at RED without a static
// dependency on a not-yet-existing field.
function baseHandlers(): ControlHandlers {
  return {
    getStatus: () => ({ activeRuns: 0, paused: false }),
    pause: () => undefined,
    resume: () => undefined,
    drain: () => undefined,
    cancelDrain: () => undefined,
    retry: async (issueNumber: number) => ({
      status: 404,
      body: { error: `no retry fixture for ${issueNumber}` },
    }),
  };
}

async function bootWithMetrics(
  getEscalationMetrics: EscalationMetricsHandler,
): Promise<number> {
  const handlers = {
    ...baseHandlers(),
    getEscalationMetrics,
  } as unknown as ControlHandlers;
  const { server, start } = createControlServer(0, handlers);
  serverRef = server;
  const result = await start();
  expect(result.ok).toBe(true);
  return (server.address() as AddressInfo).port;
}

const sampleTrend = {
  weeks: [
    {
      weekStart: '2026-06-01',
      deploymentId: 'deploy-alpha',
      raised: 2,
      answered: 1,
      autoMerges: 1,
      operatorTouchesPerDelivered: 0.5,
    },
  ],
};

describe('P4 G2 GET /metrics/escalation acceptance gate', () => {
  it('dispatches the route to the escalation-metrics handler and returns its trend payload', async () => {
    const handler = vi.fn<EscalationMetricsHandler>(() => ({
      status: 200,
      body: sampleTrend,
    }));
    const port = await bootWithMetrics(handler);

    const res = await fetch(`http://127.0.0.1:${port}/metrics/escalation`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleTrend);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes an unavailable-flagged (degraded) handler response through as 200, not 500', async () => {
    const degraded = { weeks: [], unavailable: true };
    const port = await bootWithMetrics(() => ({ status: 200, body: degraded }));

    const res = await fetch(`http://127.0.0.1:${port}/metrics/escalation`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unavailable: true });
  });

  it('returns 503 (not 500, not 404) when the handler throws — the route exists and catches, parity with /decisions/pending', async () => {
    const port = await bootWithMetrics(() => {
      throw new Error('escalation metric source unavailable');
    });

    const res = await fetch(`http://127.0.0.1:${port}/metrics/escalation`);
    // 503 = the route exists and gracefully caught. At HEAD the route is absent
    // (404), so this fails until server.ts implements the dispatch + try/catch.
    expect(res.status).toBe(503);
  });
});
