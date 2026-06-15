// packages/daemon/src/control-plane/lane-engine/tripwire.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateTripwire } from './tripwire.js';

describe('evaluateTripwire', () => {
  it('is in-scope when every touched path matches the allowlist', () => {
    const v = evaluateTripwire(['docs/a.md', 'README.md'], { allowedPaths: ['docs/**', '*.md'] });
    expect(v.kind).toBe('in-scope');
    expect(v.touched).toEqual(['docs/a.md', 'README.md']);
  });

  it('is out-of-scope and lists the offending paths', () => {
    const v = evaluateTripwire(['docs/a.md', 'src/secret.ts'], { allowedPaths: ['docs/**'] });
    expect(v.kind).toBe('out-of-scope');
    if (v.kind === 'out-of-scope') {
      expect(v.outside).toEqual(['src/secret.ts']);
    }
  });

  it('is in-scope for an empty change', () => {
    expect(evaluateTripwire([], { allowedPaths: ['docs/**'] }).kind).toBe('in-scope');
  });

  it('treats every path as out-of-scope when nothing matches', () => {
    const v = evaluateTripwire(['a.ts', 'b.ts'], { allowedPaths: ['docs/**'] });
    expect(v.kind).toBe('out-of-scope');
    if (v.kind === 'out-of-scope') {
      expect(v.outside).toEqual(['a.ts', 'b.ts']);
    }
  });
});
