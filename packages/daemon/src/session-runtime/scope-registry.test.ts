import { describe, it, expect } from 'vitest';
import { DEFAULT_POLICY } from './containment-hooks.js';
import {
  buildScopeRegistry,
  DEFAULT_AGENT_SCOPES,
  resolveDirectoryScope,
} from './scope-registry.js';

describe('scope registry', () => {
  it('provides a greenfield worker implementation scope (writes anywhere but frozen specs)', () => {
    const registry = buildScopeRegistry();
    const scope = resolveDirectoryScope('worker-implement', registry, DEFAULT_POLICY);

    // Greenfield-friendly: a feature build may create project files anywhere in its
    // sandboxed worktree (root config, src, test/ OR tests/, etc.). Containment is the
    // worktree boundary + the review gate + the denied paths below — not a narrow allow-list.
    expect(scope.writePaths).toEqual(['**/*']);
    // Specs are frozen during implement; holdout + daemon internals stay blocked
    // (.specify/scenarios + .specify/methodology come in via DEFAULT_POLICY.blockedPaths).
    expect(scope.denyPaths).toEqual(expect.arrayContaining([
      '.specify/**',
      ...DEFAULT_POLICY.blockedPaths,
    ]));
  });

  it('aliases the runtime worker agent to the worker implementation default', () => {
    const registry = buildScopeRegistry();
    const scope = resolveDirectoryScope('worker', registry, DEFAULT_POLICY);

    expect(scope.writePaths).toEqual(DEFAULT_AGENT_SCOPES['worker-implement']!.writePaths);
  });

  it('matches reviewer agents through glob lookup', () => {
    const registry = buildScopeRegistry();
    const scope = resolveDirectoryScope('reviewer-quality', registry, DEFAULT_POLICY);

    expect(scope.writePaths).toEqual([]);
    expect(scope.readPaths).toEqual(['**/*']);
  });

  it('lets config override built-in defaults', () => {
    const registry = buildScopeRegistry({
      worker: {
        readPaths: ['src/**'],
        writePaths: ['src/generated/**'],
        denyPaths: ['src/generated/secret/**'],
      },
    });
    const scope = resolveDirectoryScope('worker', registry, DEFAULT_POLICY);

    expect(scope.readPaths).toEqual(['src/**']);
    expect(scope.writePaths).toEqual(['src/generated/**']);
    expect(scope.denyPaths).toContain('src/generated/secret/**');
  });

  it('falls back to system-wide deny paths for unscoped agent types', () => {
    const registry = buildScopeRegistry();
    const scope = resolveDirectoryScope('custom-agent', registry, DEFAULT_POLICY);

    expect(scope.writePaths).toEqual(['**/*']);
    expect(scope.denyPaths).toEqual(DEFAULT_POLICY.blockedPaths);
  });
});
