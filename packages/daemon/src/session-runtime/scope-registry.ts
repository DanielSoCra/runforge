import micromatch from 'micromatch';
import type { Config } from '../config.js';
import type { DirectoryScope } from '../types.js';
import type { ContainmentPolicy } from './containment-hooks.js';

export type ScopeRegistry = ReadonlyMap<string, DirectoryScope>;

const workerScope: DirectoryScope = Object.freeze({
  readPaths: Object.freeze(['**/*']) as unknown as string[],
  // Greenfield-friendly: a feature build may create project files anywhere in its
  // sandboxed worktree (root config like package.json/tsconfig, src, test/ OR tests/,
  // public/, bin/, …). The real containment is the worktree boundary + the review
  // gate + denyPaths below + policy.blockedPaths (merged in by resolveDirectoryScope).
  // Build artifacts (node_modules, …) are dropped by the scope AUDIT, not denied here.
  writePaths: Object.freeze(['**/*']) as unknown as string[],
  // Specs are frozen during implement — the worker implements FROM them and never
  // edits them. (Holdout dirs .specify/scenarios + .specify/methodology also come in
  // via policy.blockedPaths, so they stay denied even independent of this.)
  denyPaths: Object.freeze(['.specify/**']) as unknown as string[],
});

export const DEFAULT_AGENT_SCOPES: Readonly<Record<string, DirectoryScope>> = Object.freeze({
  'worker-implement': workerScope,
  worker: workerScope,
  'bug-worker': workerScope,
  'reviewer-*': Object.freeze({
    readPaths: Object.freeze(['**/*']) as unknown as string[],
    writePaths: Object.freeze([]) as unknown as string[],
    denyPaths: Object.freeze([]) as unknown as string[],
  }),
  'merge-agent': Object.freeze({
    readPaths: Object.freeze(['**/*']) as unknown as string[],
    writePaths: Object.freeze(['.github/**', 'package.json', '**/*.lock']) as unknown as string[],
    denyPaths: Object.freeze(['src/**', '.specify/**']) as unknown as string[],
  }),
});

export function buildScopeRegistry(
  configScopes: Config['agentScopes'] = {},
): ScopeRegistry {
  const entries = new Map<string, DirectoryScope>();
  for (const [key, scope] of Object.entries(DEFAULT_AGENT_SCOPES)) {
    entries.set(key, freezeScope(scope));
  }
  for (const [key, scope] of Object.entries(configScopes)) {
    entries.set(key, freezeScope(scope));
  }
  return entries;
}

export function resolveDirectoryScope(
  agentType: string,
  registry: ScopeRegistry,
  policy: ContainmentPolicy,
): DirectoryScope {
  const exact = registry.get(agentType);
  const matched = exact ?? findGlobScope(agentType, registry);
  if (!matched) {
    console.warn(`[scope-registry] no directory scope configured for ${agentType}; using system-wide deny paths only`);
    return freezeScope({
      readPaths: ['**/*'],
      writePaths: ['**/*'],
      denyPaths: dedupe(policy.blockedPaths),
    });
  }
  return freezeScope({
    readPaths: [...matched.readPaths],
    writePaths: [...matched.writePaths],
    denyPaths: dedupe([...matched.denyPaths, ...policy.blockedPaths]),
  });
}

function findGlobScope(agentType: string, registry: ScopeRegistry): DirectoryScope | undefined {
  for (const [key, scope] of registry.entries()) {
    if (key === agentType) continue;
    if (micromatch.isMatch(agentType, key, { dot: true })) {
      return scope;
    }
  }
  return undefined;
}

function freezeScope(scope: DirectoryScope): DirectoryScope {
  return Object.freeze({
    readPaths: Object.freeze(dedupe(scope.readPaths)) as unknown as string[],
    writePaths: Object.freeze(dedupe(scope.writePaths)) as unknown as string[],
    denyPaths: Object.freeze(dedupe(scope.denyPaths)) as unknown as string[],
  });
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
