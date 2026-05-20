import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DOCKERFILE = readFileSync(
  resolve(__dirname, '../Dockerfile'),
  'utf-8',
);

describe('Daemon Dockerfile', () => {
  it('should pin claude-code to a specific version', () => {
    // Must have @<version> suffix — unpinned installs are non-reproducible
    expect(DOCKERFILE).toMatch(
      /npm install -g @anthropic-ai\/claude-code@\d+\.\d+\.\d+/,
    );
  });

  it('should scope pnpm install to daemon package only (#189)', () => {
    // Must use --filter to avoid installing dashboard dependencies
    expect(DOCKERFILE).toMatch(/pnpm install.*--filter.*@auto-claude\/daemon/);
  });

  it('should copy the shared db workspace package for runtime imports (#626)', () => {
    expect(DOCKERFILE).toContain(
      'COPY packages/db/package.json ./packages/db/package.json',
    );
    expect(DOCKERFILE).toContain('COPY packages/db/ ./packages/db/');
  });

  it('should NOT install claude-code without a version pin', () => {
    // Ensure there's no unpinned install line
    const lines = DOCKERFILE.split('\n');
    const installLines = lines.filter((l) =>
      l.includes('@anthropic-ai/claude-code'),
    );
    for (const line of installLines) {
      expect(line).toMatch(/@anthropic-ai\/claude-code@\d+/);
    }
  });
});
