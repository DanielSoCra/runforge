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

  it('should NOT use pnpm@latest — must use corepack enable to read pinned version (#244)', () => {
    expect(DOCKERFILE).not.toContain('pnpm@latest');
    expect(DOCKERFILE).toContain('corepack enable');
  });

  it('should scope pnpm install to briefing-summarizer package only', () => {
    expect(DOCKERFILE).toMatch(
      /pnpm install.*--filter.*@auto-claude\/briefing-summarizer/,
    );
  });

  it('should install git for git-based signals (#362)', () => {
    // signals.ts calls `git log` and index.ts calls `git remote get-url origin`.
    // Without git installed, these fail silently and degrade briefing quality.
    expect(DOCKERFILE).toMatch(/apk add.*git/);
  });

  it('should define a HEALTHCHECK for the local health endpoint (#418)', () => {
    expect(DOCKERFILE).toMatch(/apk add.*curl/);
    expect(DOCKERFILE).toMatch(/HEALTHCHECK/);
    expect(DOCKERFILE).toMatch(/curl -f http:\/\/127\.0\.0\.1:\d+\/health \|\| exit 1/);
  });
});
