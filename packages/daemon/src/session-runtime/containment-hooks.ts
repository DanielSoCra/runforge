// src/session-runtime/containment-hooks.ts
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
    for (const blocked of policy.blockedCommands) {
      if (command.includes(blocked)) {
        return { allowed: false, reason: `Blocked command pattern: ${blocked}` };
      }
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
  // Common tool input field names
  for (const key of ['file_path', 'path', 'filePath', 'target']) {
    if (typeof input[key] === 'string') paths.push(input[key] as string);
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
    'src/session-runtime/**',
    'src/control-plane/**',
  ],
  blockedCommands: [
    'curl ', 'wget ', 'nc ', 'ssh ', 'scp ',
    'rm -rf /', 'mkfs', 'dd if=',
  ],
  readOnlyPaths: [
    '.specify/**',
    'CLAUDE.md',
    'AGENTS.md',
  ],
};
