import { resolve } from 'node:path';
import type { Config } from '../config.js';
import { git } from '../lib/git.js';
import type {
  RuntimeSourceFailureKind,
  RuntimeSourcePolicy,
  RuntimeSourceStatus,
} from '../types.js';

export function buildRuntimeSourcePolicy(
  config: Config,
  defaultSourceRoot: string,
): RuntimeSourcePolicy {
  const sourceRoot = resolve(config.runtimeSource.sourceRoot ?? defaultSourceRoot);
  const expectedRef =
    config.runtimeSource.expectedRef ??
    (config.runtimeSource.requireExpectedRef
      ? `origin/${config.branches.staging}`
      : undefined);
  return {
    enabled: config.runtimeSource.enabled,
    sourceRoot,
    expectedRef,
    requireClean: config.runtimeSource.requireClean,
    requireExpectedRef: config.runtimeSource.requireExpectedRef,
    onUnhealthy: config.runtimeSource.onUnhealthy,
    ignoredDirtyPaths: config.runtimeSource.ignoredDirtyPaths,
  };
}

export async function validateRuntimeSource(
  policy: RuntimeSourcePolicy,
): Promise<RuntimeSourceStatus> {
  const checkedAt = new Date().toISOString();
  if (!policy.enabled) {
    return {
      enabled: false,
      healthy: true,
      sourceRoot: policy.sourceRoot,
      expectedRef: policy.expectedRef,
      clean: true,
      dirtyPaths: [],
      synchronized: 'unknown',
      checkedAt,
      action: 'warn',
      failureKind: 'runtime-source-disabled',
      message: 'Runtime source validation is disabled',
    };
  }

  const head = await git(['rev-parse', 'HEAD'], policy.sourceRoot);
  if (!head.ok) {
    return unhealthy(policy, checkedAt, 'validation-unavailable', head.error.message);
  }

  const currentRef = await git(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    policy.sourceRoot,
  );
  const dirtyPaths = await getDirtyPaths(policy);
  if (!dirtyPaths.ok) {
    return unhealthy(policy, checkedAt, 'validation-unavailable', dirtyPaths.error.message, {
      head: head.value.trim(),
      currentRef: currentRef.ok ? currentRef.value.trim() : undefined,
    });
  }

  const clean = dirtyPaths.value.length === 0;
  const baseStatus = {
    head: head.value.trim(),
    currentRef: currentRef.ok ? currentRef.value.trim() : undefined,
    clean,
    dirtyPaths: dirtyPaths.value,
  };

  if (policy.requireClean && !clean) {
    return unhealthy(
      policy,
      checkedAt,
      'dirty-runtime-source',
      `Runtime source has uncommitted changes (${dirtyPaths.value.length} path${dirtyPaths.value.length === 1 ? '' : 's'})`,
      baseStatus,
    );
  }

  const sync = await validateExpectedRef(policy);
  if ('failureKind' in sync) {
    return unhealthy(policy, checkedAt, sync.failureKind, sync.message, {
      ...baseStatus,
      synchronized: sync.synchronized,
    });
  }

  return {
    enabled: true,
    healthy: true,
    sourceRoot: policy.sourceRoot,
    expectedRef: policy.expectedRef,
    clean,
    dirtyPaths: dirtyPaths.value,
    synchronized: sync.synchronized,
    checkedAt,
    action: policy.onUnhealthy,
    head: baseStatus.head,
    currentRef: baseStatus.currentRef,
  };
}

async function getDirtyPaths(
  policy: RuntimeSourcePolicy,
): Promise<{ ok: true; value: string[] } | { ok: false; error: Error }> {
  const status = await git(['status', '--porcelain=v1'], policy.sourceRoot);
  if (!status.ok) return status;
  const paths = status.value
    .split('\n')
    .map((line) => parsePorcelainPath(line))
    .filter((path): path is string => path !== undefined)
    .filter((path) => !isIgnoredDirtyPath(path, policy.ignoredDirtyPaths));
  return { ok: true, value: paths };
}

async function validateExpectedRef(policy: RuntimeSourcePolicy): Promise<{
  synchronized: boolean | 'unknown';
} | {
  synchronized: false | 'unknown';
  failureKind: RuntimeSourceFailureKind;
  message: string;
}> {
  if (!policy.expectedRef) {
    if (!policy.requireExpectedRef) return { synchronized: 'unknown' };
    return {
      synchronized: 'unknown',
      failureKind: 'missing-expected-ref',
      message: 'Runtime source expectedRef is required but missing',
    };
  }

  const expected = await git(
    ['rev-parse', '--verify', policy.expectedRef],
    policy.sourceRoot,
  );
  if (!expected.ok) {
    return {
      synchronized: false,
      failureKind: 'missing-expected-ref',
      message: `Runtime source expectedRef is unavailable: ${policy.expectedRef}`,
    };
  }

  const ancestor = await git(
    ['merge-base', '--is-ancestor', policy.expectedRef, 'HEAD'],
    policy.sourceRoot,
  );
  if (!ancestor.ok) {
    return {
      synchronized: false,
      failureKind: 'behind-expected-ref',
      message: `Runtime source HEAD is not at or ahead of ${policy.expectedRef}`,
    };
  }

  return { synchronized: true };
}

function unhealthy(
  policy: RuntimeSourcePolicy,
  checkedAt: string,
  failureKind: RuntimeSourceFailureKind,
  message: string,
  partial: Partial<RuntimeSourceStatus> = {},
): RuntimeSourceStatus {
  return {
    enabled: policy.enabled,
    healthy: false,
    sourceRoot: policy.sourceRoot,
    expectedRef: policy.expectedRef,
    clean: partial.clean ?? false,
    dirtyPaths: partial.dirtyPaths ?? [],
    synchronized: partial.synchronized ?? 'unknown',
    checkedAt,
    action: policy.onUnhealthy,
    failureKind,
    message,
    head: partial.head,
    currentRef: partial.currentRef,
  };
}

function parsePorcelainPath(line: string): string | undefined {
  if (!line.trim()) return undefined;
  // Trim-robust: runCommand() .trim()s git output, stripping the leading space of
  // an unstaged-modified (" M …") first line. A fixed slice(3) would then eat the
  // path's first char. Strip ≤2 status chars + the one separator space instead.
  const rawPath = line.replace(/^.{0,2}[ \t]/, '');
  const renameIndex = rawPath.indexOf(' -> ');
  return renameIndex === -1 ? rawPath : rawPath.slice(renameIndex + 4);
}

function isIgnoredDirtyPath(path: string, ignoredPaths: string[]): boolean {
  const normalized = path.replace(/^\/+/, '');
  return ignoredPaths.some((ignoredPath) => {
    const ignored = ignoredPath.replace(/^\/+/, '');
    if (ignored.endsWith('/')) return normalized.startsWith(ignored);
    return normalized === ignored;
  });
}
