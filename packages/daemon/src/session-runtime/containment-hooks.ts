// packages/daemon/src/session-runtime/containment-hooks.ts
import { minimatch } from 'minimatch';
import { normalize } from 'path';

export interface ContainmentPolicy {
  blockedPaths: string[];
  blockedCommands: string[];
  readOnlyPaths: string[];
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export type ContainmentResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function checkContainment(call: ToolCall, policy: ContainmentPolicy): ContainmentResult {
  // 1. Path blocking — check if any file path in the input matches blocked patterns
  const paths = extractPaths(call.input);
  for (const path of paths) {
    for (const pattern of policy.blockedPaths) {
      if (minimatch(path, pattern, { dot: true })) {
        return { allowed: false, reason: `Blocked path: ${path} matches ${pattern}` };
      }
    }
  }

  // 2. Read/write classification — write tools on read-only paths are blocked
  if (isWriteTool(call.tool)) {
    for (const path of paths) {
      for (const pattern of policy.readOnlyPaths) {
        if (minimatch(path, pattern, { dot: true })) {
          return { allowed: false, reason: `Write blocked on read-only path: ${path}` };
        }
      }
    }
  }

  // 3. Command blocking — check Bash/shell commands
  if (call.tool === 'Bash' || call.tool === 'shell') {
    const command = String(call.input.command ?? call.input.cmd ?? '');
    const normalized = normalizeShellCommand(command);
    for (const blocked of policy.blockedCommands) {
      // Check both raw and normalized forms
      if (command.includes(blocked) || normalized.includes(blocked)) {
        return { allowed: false, reason: `Blocked command pattern: ${blocked}` };
      }
    }

    // Check for variable-based indirection: `x=curl; $x ...` or `x=curl && $x ...`
    const assignmentBypass = detectCommandAssignmentBypass(normalized, policy.blockedCommands);
    if (assignmentBypass) {
      return { allowed: false, reason: `Blocked command pattern (variable indirection): ${assignmentBypass}` };
    }

    // 4. Extract path references from Bash commands and check against blocked/readOnly paths
    const commandPaths = extractCommandPaths(command);
    const commandIsWrite = WRITE_INDICATOR_RE.test(command);
    for (const p of commandPaths) {
      for (const pattern of policy.blockedPaths) {
        if (minimatch(p, pattern, { dot: true })) {
          return { allowed: false, reason: `Blocked path in command: ${p} matches ${pattern}` };
        }
      }
      if (commandIsWrite) {
        for (const pattern of policy.readOnlyPaths) {
          if (minimatch(p, pattern, { dot: true })) {
            return { allowed: false, reason: `Write blocked on read-only path in command: ${p}` };
          }
        }
      }
    }
  }

  return { allowed: true };
}

function extractPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  // Common tool input field names — normalize to prevent ../traversal bypass
  for (const key of ['file_path', 'path', 'filePath', 'target']) {
    if (typeof input[key] === 'string') paths.push(normalize(input[key] as string));
  }
  return paths;
}

/** Extract path-like tokens from a shell command string, normalized to prevent traversal bypasses. */
function extractCommandPaths(command: string): string[] {
  const tokens = command.split(/[|;&\s]+/).filter(Boolean);
  const paths: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('-') || token.startsWith('$') || token.includes('=')) continue;
    if (token.includes('/') || token.includes('.')) {
      // Strip shell redirections and surrounding quotes
      const cleaned = token.replace(/^[<>]+/, '').replace(/^["']|["']$/g, '');
      if (cleaned) paths.push(normalize(cleaned));
    }
  }
  return paths;
}

/**
 * Normalize a shell command by stripping common evasion techniques:
 * - Empty quote pairs: cu''rl → curl, cu""rl → curl
 * - Backslash escapes: cu\rl → curl
 */
function normalizeShellCommand(command: string): string {
  return command
    .replace(/''/g, '')       // remove empty single-quote pairs
    .replace(/""/g, '')       // remove empty double-quote pairs
    .replace(/\\(?=\w)/g, '') // remove backslash before word chars
    ;
}

/**
 * Detect variable assignment bypass: patterns like `x=curl; $x http://...`
 * where a variable is assigned a blocked command name and then expanded.
 * Returns the matched blocked command or null.
 */
function detectCommandAssignmentBypass(
  command: string,
  blockedCommands: string[],
): string | null {
  // Match `VAR=value` patterns (possibly after ; or && or ||)
  const assignments = command.matchAll(/\b(\w+)=(["']?)(\S+?)\2(?=\s|;|&|$)/g);
  for (const match of assignments) {
    const value = match[3];
    for (const blocked of blockedCommands) {
      // blocked entries have trailing space (e.g. "curl "), trim for comparison
      const cmd = blocked.trimEnd();
      if (value === cmd) {
        // Only flag if the variable is actually expanded later
        const varName = match[1];
        if (command.includes(`$${varName}`) || command.includes(`\${${varName}}`)) {
          return blocked;
        }
      }
    }
  }
  return null;
}

const WRITE_INDICATOR_RE = /[>]|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i\b|\bdd\b/;

export const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'shell'];

function isWriteTool(tool: string): boolean {
  return WRITE_TOOLS.includes(tool);
}

export const DEFAULT_POLICY: ContainmentPolicy = {
  blockedPaths: [
    '.specify/scenarios/**',
    '.specify/methodology/**',
    'state/**',
    'packages/daemon/src/session-runtime/**',
    'packages/daemon/src/control-plane/**',
  ],
  blockedCommands: [
    // Direct network tools
    'curl ', 'wget ', 'nc ', 'ssh ', 'scp ',
    // Network-capable alternatives (ncat, socat, telnet)
    'ncat ', 'socat ', 'telnet ',
    // Runtime interpreters — can make arbitrary outbound requests.
    // Uses trailing-space pattern (same as curl/wget) for consistency.
    // Substring matching may cause false positives on commands that
    // reference interpreter names in non-command positions; this is
    // acceptable in the autonomous agent context where agents use
    // dedicated tools (Read, Grep, Glob) rather than shell interpreters.
    'python3 ', 'python ', 'node ', 'perl ', 'ruby ', 'php ',
    // Destructive disk commands
    'rm -rf /', 'mkfs', 'dd if=',
  ],
  readOnlyPaths: [
    '.specify/**',
    '.claude/**',
    'CLAUDE.md',
    'AGENTS.md',
    'auto-claude.config.json',
  ],
};
