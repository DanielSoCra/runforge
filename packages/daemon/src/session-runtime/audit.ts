// packages/daemon/src/session-runtime/audit.ts
import { minimatch } from 'minimatch';
import type { ContainmentPolicy } from './containment-hooks.js';

export interface AuditResult {
  clean: boolean;
  violations: string[];
}

/**
 * Post-session audit (containment layer 6 — detective).
 * Scans session output for references to prohibited paths.
 * This catches violations that bypassed the five preventive layers.
 */
export function auditSessionOutput(output: string, policy: ContainmentPolicy): AuditResult {
  const violations: string[] = [];

  // Extract path-like tokens from the output text
  const paths = extractPathReferences(output);

  for (const path of paths) {
    for (const pattern of policy.blockedPaths) {
      if (minimatch(path, pattern, { dot: true })) {
        const msg = `Prohibited path reference: ${path} matches ${pattern}`;
        if (!violations.includes(msg)) {
          violations.push(msg);
        }
      }
    }
  }

  return violations.length === 0
    ? { clean: true, violations: [] }
    : { clean: false, violations };
}

/**
 * Extract path-like references from session output text.
 * Looks for file paths that could indicate a session accessed prohibited resources.
 */
function extractPathReferences(output: string): string[] {
  const paths = new Set<string>();

  // Match file paths: relative (./foo, .specify/..., state/...) and absolute (/home/...)
  // Covers: .specify/scenarios/foo.md, state/runs/42.json, packages/daemon/src/...
  const pathRegex = /(?:^|[\s"'`([\]=])(\/?[.\w-]+\/[\w./-]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(output)) !== null) {
    if (match[1]) paths.add(match[1]);
  }

  return [...paths];
}
