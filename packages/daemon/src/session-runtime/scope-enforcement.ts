import micromatch from 'micromatch';
import { isAbsolute, normalize, relative } from 'path';
import type {
  DirectoryScope,
  ScopeDetectionLayer,
  ViolationRecord,
} from '../types.js';

export interface ScopeCheckContext {
  sessionId: string;
  agentType: string;
  detectionLayer: ScopeDetectionLayer;
  workspacePath?: string;
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export type ScopeToolResult =
  | { allowed: true }
  | { allowed: false; violation: ViolationRecord };

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);

export function checkWriteScope(
  filePath: string,
  scope: DirectoryScope,
  context: ScopeCheckContext,
): ViolationRecord | null {
  const normalized = normalizeWorkspacePath(filePath, context.workspacePath);
  if (matchesAny(normalized, scope.denyPaths)) {
    return makeViolation(normalized, 'access-to-denied', context);
  }
  if (scope.writePaths.length === 0 || !matchesAny(normalized, scope.writePaths)) {
    return makeViolation(normalized, 'write-outside-permitted', context);
  }
  return null;
}

export function checkToolCallScope(
  call: ToolCall,
  scope: DirectoryScope,
  context: ScopeCheckContext,
): ScopeToolResult {
  const paths = extractPathInputs(call.input);
  if (WRITE_TOOLS.has(call.tool)) {
    for (const path of paths) {
      const violation = checkWriteScope(path, scope, context);
      if (violation) return { allowed: false, violation };
    }
    return { allowed: true };
  }

  if (call.tool === 'Bash' || call.tool === 'shell') {
    const command = String(call.input.command ?? call.input.cmd ?? '');
    const writePaths = extractCommandWritePaths(command);
    for (const path of writePaths) {
      const violation = checkWriteScope(path, scope, context);
      if (violation) return { allowed: false, violation };
    }
    for (const path of extractCommandPathTokens(command)) {
      const normalized = normalizeWorkspacePath(path, context.workspacePath);
      if (matchesAny(normalized, scope.denyPaths)) {
        return { allowed: false, violation: makeViolation(normalized, 'access-to-denied', context) };
      }
    }
    return { allowed: true };
  }

  if (READ_TOOLS.has(call.tool)) {
    for (const path of paths) {
      const normalized = normalizeWorkspacePath(path, context.workspacePath);
      if (matchesAny(normalized, scope.denyPaths)) {
        return { allowed: false, violation: makeViolation(normalized, 'access-to-denied', context) };
      }
    }
  }

  return { allowed: true };
}

export function makeCliPermissionDenyEntries(scope: DirectoryScope): string[] {
  return [...new Set(scope.denyPaths)];
}

export function generateScopeHookScript(scope: DirectoryScope, context: ScopeCheckContext): string {
  return `#!/usr/bin/env node
const scope = ${JSON.stringify(scope)};
const context = ${JSON.stringify(context)};

function normalizePath(input) {
  let value = String(input || '').replace(/\\\\/g, '/');
  if (!value) return '';
  if (value.startsWith('/')) value = value.slice(1);
  const parts = [];
  let escapedWorkspace = false;
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) escapedWorkspace = true;
      else parts.pop();
    }
    else parts.push(part);
  }
  const normalized = parts.join('/');
  return escapedWorkspace ? '__outside_workspace__/' + normalized : normalized;
}

function matches(path, pattern) {
  const normalized = normalizePath(path);
  const p = String(pattern || '').replace(/\\\\/g, '/');
  if (p === '**/*' || p === '**') return true;
  if (p.endsWith('/**')) return normalized === p.slice(0, -3) || normalized.startsWith(p.slice(0, -2));
  return normalized === p;
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => matches(path, pattern));
}

function violation(path, type) {
  return {
    sessionId: context.sessionId,
    agentType: context.agentType,
    path,
    violationType: type,
    detectionLayer: context.detectionLayer,
    timestamp: new Date().toISOString(),
  };
}

function checkWrite(path) {
  const normalized = normalizePath(path);
  if (matchesAny(normalized, scope.denyPaths)) return violation(normalized, 'access-to-denied');
  if (scope.writePaths.length === 0 || !matchesAny(normalized, scope.writePaths)) {
    return violation(normalized, 'write-outside-permitted');
  }
  return null;
}

function pathsFrom(input) {
  return ['file_path', 'path', 'filePath', 'target'].flatMap((key) => (
    typeof input?.[key] === 'string' ? [input[key]] : []
  ));
}

function commandWritePaths(command) {
  const paths = [];
  for (const match of command.matchAll(/(?:^|\\s)(?:>|>>)\\s*(['"]?)([^'"\\s]+)\\1/g)) {
    if (match[2]) paths.push(match[2]);
  }
  for (const match of command.matchAll(/\\b(?:tee|cp|mv)\\b(?:\\s+-\\S+)*\\s+[^;&|]+?\\s+(['"]?)([^'"\\s]+)\\1(?=\\s|$|[;&|])/g)) {
    if (match[2]) paths.push(match[2]);
  }
  for (const match of command.matchAll(/\\bsed\\s+-i(?:\\s+\\S+)*\\s+(['"]?)([^'"\\s]+)\\1/g)) {
    if (match[2]) paths.push(match[2]);
  }
  return paths;
}

function commandPathTokens(command) {
  return command
    .split(/[|;&\\s]+/)
    .map((token) => token.replace(/^[<>]+/, '').replace(/^["']|["']$/g, ''))
    .filter((token) => token && !token.startsWith('-') && !token.startsWith('$') && !token.includes('='))
    .filter((token) => token.includes('/') || token.includes('.'));
}

function formatReason(hit) {
  return 'scope-violation: ' + hit.violationType + ' ' + hit.path;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(raw || '{}');
    const tool = event.tool_name || event.tool || event.name || '';
    const input = event.tool_input || event.input || {};
    const writeTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    const readTools = new Set(['Read', 'Glob', 'Grep', 'LS']);
    const paths = pathsFrom(input);
    if (writeTools.has(tool)) {
      for (const path of paths) {
        const hit = checkWrite(path);
        if (hit) {
          process.stderr.write(formatReason(hit) + '\\n');
          process.exit(2);
        }
      }
    }
    if (tool === 'Bash' || tool === 'shell') {
      const command = String(input.command || input.cmd || '');
      for (const path of commandWritePaths(command)) {
        const hit = checkWrite(path);
        if (hit) {
          process.stderr.write(formatReason(hit) + '\\n');
          process.exit(2);
        }
      }
      for (const path of commandPathTokens(command)) {
        const normalized = normalizePath(path);
        if (matchesAny(normalized, scope.denyPaths)) {
          process.stderr.write(formatReason(violation(normalized, 'access-to-denied')) + '\\n');
          process.exit(2);
        }
      }
    }
    if (readTools.has(tool)) {
      for (const path of paths) {
        const normalized = normalizePath(path);
        if (matchesAny(normalized, scope.denyPaths)) {
          process.stderr.write(formatReason(violation(normalized, 'access-to-denied')) + '\\n');
          process.exit(2);
        }
      }
    }
    process.exit(0);
  } catch (error) {
    // Fail closed on unparseable hook input — mirroring generate-containment-script.ts.
    // We cannot determine whether the tool is write-capable without parsing, so we
    // deny unconditionally rather than risk allowing a blocked write.
    process.stderr.write('scope hook: failed to parse input: ' + error.message + '\\n');
    process.exit(2);
  }
});
`;
}

export function normalizeWorkspacePath(filePath: string, workspacePath?: string): string {
  const withSlashes = filePath.replace(/\\/g, '/');
  let normalized = normalize(withSlashes).replace(/\\/g, '/');
  if (workspacePath && isAbsolute(normalized)) {
    normalized = relative(workspacePath, normalized).replace(/\\/g, '/');
  }
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (normalized === '..' || normalized.startsWith('../')) {
    return `__outside_workspace__/${normalized.replace(/^(\.\.\/)+/, '')}`;
  }
  return normalized === '.' ? '' : normalized;
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return micromatch.isMatch(filePath, patterns, { dot: true });
}

function makeViolation(
  path: string,
  violationType: ViolationRecord['violationType'],
  context: ScopeCheckContext,
): ViolationRecord {
  return {
    sessionId: context.sessionId,
    agentType: context.agentType,
    path,
    violationType,
    detectionLayer: context.detectionLayer,
    timestamp: new Date().toISOString(),
  };
}

function extractPathInputs(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ['file_path', 'path', 'filePath', 'target']) {
    if (typeof input[key] === 'string') paths.push(input[key] as string);
  }
  return paths;
}

function extractCommandWritePaths(command: string): string[] {
  const paths: string[] = [];
  for (const match of command.matchAll(/(?:^|\s)(?:>|>>)\s*(['"]?)([^'"\s]+)\1/g)) {
    if (match[2]) paths.push(match[2]);
  }
  for (const match of command.matchAll(/\b(?:tee|cp|mv)\b(?:\s+-\S+)*\s+[^;&|]+?\s+(['"]?)([^'"\s]+)\1(?=\s|$|[;&|])/g)) {
    if (match[2]) paths.push(match[2]);
  }
  for (const match of command.matchAll(/\bsed\s+-i(?:\s+\S+)*\s+(['"]?)([^'"\s]+)\1/g)) {
    if (match[2]) paths.push(match[2]);
  }
  return paths;
}

function extractCommandPathTokens(command: string): string[] {
  return command
    .split(/[|;&\s]+/)
    .map(token => token.replace(/^[<>]+/, '').replace(/^["']|["']$/g, ''))
    .filter(token => token && !token.startsWith('-') && !token.startsWith('$') && !token.includes('='))
    .filter(token => token.includes('/') || token.includes('.'));
}
