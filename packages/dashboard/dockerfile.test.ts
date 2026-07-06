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

  it('should copy shared workspace packages required by server imports (#626)', () => {
    expect(DOCKERFILE).toContain(
      'COPY packages/auth/package.json ./packages/auth/package.json',
    );
    expect(DOCKERFILE).toContain(
      'COPY packages/db/package.json ./packages/db/package.json',
    );
    expect(DOCKERFILE).toContain('COPY packages/auth/ ./packages/auth/');
    expect(DOCKERFILE).toContain('COPY packages/db/ ./packages/db/');
  });

  it('should use build-only placeholders for server-only database secrets (#626)', () => {
    expect(DOCKERFILE).toContain(
      'ENV RUNFORGE_DATABASE_URL=postgres://runforge:runforge@postgres:5432/runforge',
    );
    expect(DOCKERFILE).toContain(
      'ENV ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000',
    );
  });

  it('does not require retired Supabase build arguments (#626)', () => {
    expect(DOCKERFILE).not.toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(DOCKERFILE).not.toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  });
});
