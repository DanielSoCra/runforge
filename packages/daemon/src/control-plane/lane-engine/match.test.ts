// packages/daemon/src/control-plane/lane-engine/match.test.ts
import { describe, it, expect } from 'vitest';
import { matchesAny } from './match.js';

describe('matchesAny', () => {
  it('matches an exact path', () => {
    expect(matchesAny('package.json', ['package.json'])).toBe(true);
  });

  it('matches a recursive glob', () => {
    expect(matchesAny('docs/guide/intro.md', ['docs/**'])).toBe(true);
  });

  it('matches dotfiles (dot: true)', () => {
    expect(matchesAny('.github/workflows/ci.yml', ['.github/**'])).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    expect(matchesAny('src/index.ts', ['docs/**', '**/*.md'])).toBe(false);
  });

  it('returns false for an empty pattern list', () => {
    expect(matchesAny('anything', [])).toBe(false);
  });
});
