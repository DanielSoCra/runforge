import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DOCKERFILE = readFileSync(resolve(__dirname, '../Dockerfile'), 'utf-8');

describe('DB migration Dockerfile', () => {
  it('uses the pinned workspace package manager via corepack', () => {
    expect(DOCKERFILE).toContain('corepack enable');
    expect(DOCKERFILE).not.toContain('pnpm@latest');
  });

  it('installs and runs only the db workspace package', () => {
    expect(DOCKERFILE).toContain(
      'COPY packages/db/package.json ./packages/db/package.json',
    );
    expect(DOCKERFILE).toMatch(/pnpm install.*--filter @auto-claude\/db/);
    expect(DOCKERFILE).toContain(
      'CMD ["pnpm", "--filter", "@auto-claude/db", "db:migrate"]',
    );
  });
});
