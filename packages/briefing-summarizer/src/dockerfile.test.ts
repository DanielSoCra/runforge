import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DOCKERFILE = readFileSync(
  resolve(__dirname, '../Dockerfile'),
  'utf-8',
);

describe('Briefing-summarizer Dockerfile', () => {
  it('should copy sibling package.json files for lockfile validation (#243)', () => {
    // pnpm --frozen-lockfile requires all workspace importers' package.json
    // files to be present, even if only one package is being installed.
    expect(DOCKERFILE).toContain(
      'COPY packages/daemon/package.json packages/daemon/',
    );
    expect(DOCKERFILE).toContain(
      'COPY packages/dashboard/package.json packages/dashboard/',
    );
  });

  it('should scope pnpm install to briefing-summarizer package only', () => {
    expect(DOCKERFILE).toMatch(
      /pnpm install.*--filter.*@auto-claude\/briefing-summarizer/,
    );
  });
});
