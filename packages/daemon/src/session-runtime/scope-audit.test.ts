import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import type { DirectoryScope } from '../types.js';
import { auditScope, captureScopeBaseCommit } from './scope-audit.js';

const scope: DirectoryScope = {
  readPaths: ['**/*'],
  writePaths: ['src/**'],
  denyPaths: ['secret/**'],
};

describe('scope audit', () => {
  let dir: string;
  let baseCommit: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scope-audit-'));
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/app.ts'), 'export const ok = true;\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    baseCommit = await captureScopeBaseCommit(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes when modified files are within write scope', async () => {
    await writeFile(join(dir, 'src/app.ts'), 'export const ok = false;\n');

    const result = await auditScope({
      workspacePath: dir,
      baseCommit,
      sessionId: 's1',
      agentType: 'worker',
      scope,
    });

    expect(result.ok).toBe(true);
  });

  it('fails when unstaged files are outside write scope', async () => {
    await writeFile(join(dir, 'README.md'), 'changed\n');

    const result = await auditScope({
      workspacePath: dir,
      baseCommit,
      sessionId: 's1',
      agentType: 'worker',
      scope,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]).toMatchObject({
        path: 'README.md',
        violationType: 'write-outside-permitted',
        detectionLayer: 'post-session',
      });
    }
  });

  it('fails when staged files are denied even if write scope is broad', async () => {
    await mkdir(join(dir, 'secret'), { recursive: true });
    await writeFile(join(dir, 'secret/value.txt'), 'changed\n');
    execFileSync('git', ['add', 'secret/value.txt'], { cwd: dir });

    const result = await auditScope({
      workspacePath: dir,
      baseCommit,
      sessionId: 's1',
      agentType: 'worker',
      scope: { ...scope, writePaths: ['**/*'] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]).toMatchObject({
        path: 'secret/value.txt',
        violationType: 'access-to-denied',
      });
    }
  });

  it('returns audit-unavailable when git diff cannot run', async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), 'scope-nongit-'));
    try {
      const result = await auditScope({
        workspacePath: nonGitDir,
        baseCommit: 'HEAD',
        sessionId: 's1',
        agentType: 'worker',
        scope,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error[0]).toMatchObject({
          path: nonGitDir,
          violationType: 'audit-unavailable',
        });
      }
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });
});
