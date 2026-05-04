import { describe, it, expect } from 'vitest';
import { createHealthServer, isHealthy } from './health-server.js';
import type { CycleRunnerStatus } from './cycle-runner.js';

const healthyStatus = (overrides: Partial<CycleRunnerStatus> = {}): CycleRunnerStatus => ({
  inFlight: false,
  shuttingDown: false,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastFailedAt: null,
  ...overrides,
});

describe('isHealthy', () => {
  it('returns true for idle or recently running cycles', () => {
    expect(isHealthy(healthyStatus(), 1_000, 10_000)).toBe(true);
    expect(isHealthy(healthyStatus({ inFlight: true, lastStartedAt: 9_500 }), 1_000, 10_000)).toBe(true);
  });

  it('returns false when shutting down or a cycle is stale (#418)', () => {
    expect(isHealthy(healthyStatus({ shuttingDown: true }), 1_000, 10_000)).toBe(false);
    expect(isHealthy(healthyStatus({ inFlight: true, lastStartedAt: 8_000 }), 1_000, 10_000)).toBe(false);
  });
});

describe('createHealthServer', () => {
  it('serves 200 for healthy status and 503 for stale cycles (#418)', async () => {
    let status = healthyStatus();
    const server = createHealthServer({
      getStatus: () => status,
      maxCycleMs: 1_000,
      now: () => 10_000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      let response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);

      status = healthyStatus({ inFlight: true, lastStartedAt: 8_000 });
      response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
