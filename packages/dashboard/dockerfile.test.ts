import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DOCKERFILE = readFileSync(resolve(__dirname, 'Dockerfile'), 'utf-8');

describe('Dashboard Dockerfile', () => {
  it('should define a HEALTHCHECK to detect hung containers (#459)', () => {
    // Without HEALTHCHECK, a hung Next.js process keeps the container
    // "running" indefinitely — Docker never restarts it.
    expect(DOCKERFILE).toMatch(/HEALTHCHECK/);
    expect(DOCKERFILE).toMatch(/--interval=\d+s/);
    expect(DOCKERFILE).toMatch(/--timeout=\d+s/);
    expect(DOCKERFILE).toMatch(/--start-period=\d+s/);
  });
});
