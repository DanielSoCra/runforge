// src/session-runtime/containment-hooks.ts
import { minimatch } from 'minimatch';

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
