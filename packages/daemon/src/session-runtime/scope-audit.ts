import { execFile } from 'child_process';
import { promisify } from 'util';
import { err, ok, type Result } from '../lib/result.js';
import type { DirectoryScope, ViolationRecord } from '../types.js';
import { checkWriteScope } from './scope-enforcement.js';

const execFileAsync = promisify(execFile);

export interface ScopeAuditInput {
  workspacePath: string;
  baseCommit?: string;
  sessionId: string;
  agentType: string;
  scope: DirectoryScope;
}

export type ScopeAuditResult = Result<void, ViolationRecord[]>;

export async function captureScopeBaseCommit(workspacePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspacePath });
  return stdout.trim();
}

export async function auditScope(input: ScopeAuditInput): Promise<ScopeAuditResult> {
  if (!input.baseCommit) {
    return err([auditUnavailable(input)]);
  }

  let paths: string[];
  try {
    paths = await collectChangedPaths(input.workspacePath, input.baseCommit);
  } catch {
    return err([auditUnavailable(input)]);
  }

  const violations = paths
    .map(path => checkWriteScope(path, input.scope, {
      sessionId: input.sessionId,
      agentType: input.agentType,
      detectionLayer: 'post-session',
      workspacePath: input.workspacePath,
    }))
    .filter((violation): violation is ViolationRecord => violation !== null);

  return violations.length > 0 ? err(violations) : ok(undefined);
}

async function collectChangedPaths(workspacePath: string, baseCommit: string): Promise<string[]> {
  const committed = await gitLines(workspacePath, ['diff', '--name-only', `${baseCommit}..HEAD`]);
  const staged = await gitLines(workspacePath, ['diff', '--name-only', '--cached', 'HEAD']);
  const unstaged = await gitLines(workspacePath, ['diff', '--name-only', 'HEAD']);
  const untracked = await gitLines(workspacePath, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...committed, ...staged, ...unstaged, ...untracked])];
}

async function gitLines(workspacePath: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync('git', args, { cwd: workspacePath });
  return stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

function auditUnavailable(input: ScopeAuditInput): ViolationRecord {
  return {
    sessionId: input.sessionId,
    agentType: input.agentType,
    path: input.workspacePath,
    violationType: 'audit-unavailable',
    detectionLayer: 'post-session',
    timestamp: new Date().toISOString(),
  };
}
