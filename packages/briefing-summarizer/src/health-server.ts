import { createServer, type Server } from 'node:http';
import type { CycleRunnerStatus } from './cycle-runner.js';

export interface HealthServerOptions {
  getStatus: () => CycleRunnerStatus;
  maxCycleMs: number;
  now?: () => number;
}

export function isHealthy(
  status: CycleRunnerStatus,
  maxCycleMs: number,
  now: number = Date.now(),
): boolean {
  if (status.shuttingDown) return false;
  if (status.inFlight && status.lastStartedAt !== null) {
    return now - status.lastStartedAt <= maxCycleMs;
  }
  return true;
}

export function createHealthServer(options: HealthServerOptions): Server {
  const now = options.now ?? Date.now;
  return createServer((req, res) => {
    if (req.url !== '/health') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const status = options.getStatus();
    const healthy = isHealthy(status, options.maxCycleMs, now());
    res.statusCode = healthy ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: healthy, ...status }));
  });
}

export async function startHealthServer(
  port: number,
  options: HealthServerOptions,
): Promise<Server> {
  const server = createHealthServer(options);
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}
