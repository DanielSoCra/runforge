// packages/daemon/src/control-plane/lane-engine/match.ts
import { minimatch } from 'minimatch';

/**
 * True if `path` matches any of the glob patterns. Uses `{ dot: true }` to
 * match dotfiles — the same dialect used by the containment path rules, so
 * one glob behavior serves the whole codebase.
 */
export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}
