// packages/daemon/src/session-runtime/audit.ts
import { minimatch } from 'minimatch';
import type { ContainmentPolicy } from './containment-hooks.js';

export interface AuditResult {
  clean: boolean;
  violations: string[];
}

/**
 * Post-session audit (containment layer 6 — detective).
 * Scans session output for references to prohibited paths and
 * evidence of blocked command execution.
 * This catches violations that bypassed the five preventive layers.
 */
export function auditSessionOutput(output: string, policy: ContainmentPolicy): AuditResult {
  const violations: string[] = [];

  // 1. Check for prohibited path references
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

  // 2. Check for evidence of blocked command execution
  const commandViolations = detectBlockedCommandEvidence(output, policy.blockedCommands);
  for (const msg of commandViolations) {
    if (!violations.includes(msg)) {
      violations.push(msg);
    }
  }

  return violations.length === 0
    ? { clean: true, violations: [] }
    : { clean: false, violations };
}

/**
 * Detect evidence of blocked command execution in session output.
 * Scans for command invocations that appear in shell-like contexts:
 * lines starting with `$ cmd`, `> cmd`, or bare `cmd` at line start.
 * This is a detective check — false positives are acceptable because
 * this layer only fires after a session already completed.
 */
function detectBlockedCommandEvidence(output: string, blockedCommands: string[]): string[] {
  const violations: string[] = [];

  // Pre-compile regexes outside the line loop to avoid O(lines * commands) allocations
  const compiledPatterns = blockedCommands.map(blocked => {
    const cmd = blocked.trimEnd();
    const cmdEscaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match command at line start, after shell prompts ($ or >), or after pipe/semicolon
    // Trailing anchor includes shell operators so "curl|nc" and "curl;echo" are caught
    // Known limitation: commands after sudo/env/command prefixes are not detected
    const re = new RegExp(`(?:^|[$>]\\s*|[|;&]\\s*)${cmdEscaped}(?:\\s|[|;&]|$)`);
    return { cmd, re };
  });

  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const { cmd, re } of compiledPatterns) {
      if (re.test(trimmed)) {
        const msg = `Blocked command evidence: '${cmd}' found in output`;
        if (!violations.includes(msg)) {
          violations.push(msg);
        }
      }
    }
  }

  return violations;
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
