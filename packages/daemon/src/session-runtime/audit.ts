// packages/daemon/src/session-runtime/audit.ts
import { minimatch } from 'minimatch';
import type { ContainmentPolicy } from './containment-hooks.js';

export type AuditSeverity = 'advisory' | 'fatal';

export interface AuditViolation {
  severity: AuditSeverity;
  message: string;
  redactedMatch: string;
}

export interface AuditResult {
  clean: boolean;
  violations: AuditViolation[];
}

/**
 * Redact a sensitive match for audit records: first 8 characters + total length.
 * The audit record must never itself become the leak.
 */
function redactMatch(match: string): string {
  const prefix = match.slice(0, 8);
  return `${prefix} (${match.length})`;
}

/**
 * Post-session audit (containment layer 6 — detective).
 * Scans session output for references to prohibited paths and
 * evidence of blocked command execution.
 * This catches violations that bypassed the five preventive layers.
 */
export function auditSessionOutput(output: string, policy: ContainmentPolicy): AuditResult {
  const violations: AuditViolation[] = [];

  // 1. Path reference scanning removed — preventive containment hooks (layers 1–5)
  // already block writes to blocked paths during the session. Scanning output text
  // for path-like strings caused false positives when sessions legitimately *discuss*
  // daemon internals (e.g., Tech Lead planning sessions).

  // 2. Check for evidence of blocked command execution (advisory per #489).
  const commandViolations = detectBlockedCommandEvidence(output, policy.blockedCommands);
  for (const violation of commandViolations) {
    if (!violations.some((v) => v.message === violation.message)) {
      violations.push(violation);
    }
  }

  // 3. Fatal credential-leak floor on high-precision patterns only.
  const credentialViolations = detectCredentialLeaks(output);
  for (const violation of credentialViolations) {
    if (!violations.some((v) => v.message === violation.message)) {
      violations.push(violation);
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
 *
 * Issue #489 acceptance criteria 5–6: this layer is intentionally advisory-only.
 */
function detectBlockedCommandEvidence(
  output: string,
  blockedCommands: string[],
): AuditViolation[] {
  const violations: AuditViolation[] = [];

  // Pre-compile regexes outside the line loop to avoid O(lines * commands) allocations
  const compiledPatterns = blockedCommands.map((blocked) => {
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
        if (!violations.some((v) => v.message === msg)) {
          violations.push({
            severity: 'advisory',
            message: msg,
            redactedMatch: cmd,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * High-precision credential patterns (fatal floor). Generic high-entropy assignment
 * detection is intentionally excluded from the fatal set to avoid false-positive
 * bricks on legitimate sessions.
 */
const CREDENTIAL_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'Anthropic API key', regex: /sk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: 'GitHub token', regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'GitHub PAT', regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'AWS access key ID', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'private key block', regex: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/g },
];

function detectCredentialLeaks(output: string): AuditViolation[] {
  const violations: AuditViolation[] = [];

  for (const { name, regex } of CREDENTIAL_PATTERNS) {
    const matches = output.match(regex) ?? [];
    for (const match of matches) {
      const msg = `Credential leak detected: ${name}`;
      const redacted = redactMatch(match);
      if (!violations.some((v) => v.message === msg && v.redactedMatch === redacted)) {
        violations.push({
          severity: 'fatal',
          message: msg,
          redactedMatch: redacted,
        });
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
