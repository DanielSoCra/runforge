import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import type { DirectoryScope } from '../types.js';
import { auditScope, captureScopeBaseCommit } from './scope-audit.js';
import { buildScopeRegistry, resolveDirectoryScope } from './scope-registry.js';
import { DEFAULT_POLICY } from './containment-hooks.js';

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

  it('ignores build artifacts (node_modules) even when outside the write scope', async () => {
    // A narrow scope (only src/** writable). `pnpm install` writes node_modules,
    // which is a build artifact, not a deliverable — it must NOT count as a violation.
    await mkdir(join(dir, 'node_modules/dep'), { recursive: true });
    await writeFile(join(dir, 'node_modules/dep/index.js'), 'module.exports = {};\n');
    await writeFile(join(dir, 'src/app.ts'), 'export const ok = 2;\n'); // in scope

    const result = await auditScope({
      workspacePath: dir,
      baseCommit,
      sessionId: 's1',
      agentType: 'worker',
      scope, // writePaths: ['src/**']
    });

    expect(result.ok).toBe(true);
  });

  it('greenfield worker scope: allows project scaffolding, denies only frozen specs', async () => {
    const workerScope = resolveDirectoryScope('worker', buildScopeRegistry(), DEFAULT_POLICY);
    // a real greenfield feature: root config + tests + installed deps
    await writeFile(join(dir, 'package.json'), '{"name":"feat"}\n');
    await writeFile(join(dir, 'tsconfig.json'), '{}\n');
    await mkdir(join(dir, 'test/feed'), { recursive: true });
    await writeFile(join(dir, 'test/feed/rss.test.ts'), 'export const t = 1;\n');
    await mkdir(join(dir, 'node_modules/dep'), { recursive: true });
    await writeFile(join(dir, 'node_modules/dep/index.js'), 'x\n');
    // a spec write IS denied — specs are frozen during implement
    await mkdir(join(dir, '.specify/architecture'), { recursive: true });
    await writeFile(join(dir, '.specify/architecture/ARCH-X.md'), '# spec\n');

    const result = await auditScope({
      workspacePath: dir,
      baseCommit,
      sessionId: 's1',
      agentType: 'worker',
      scope: workerScope,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.error.map((v) => v.path);
      expect(paths).toContain('.specify/architecture/ARCH-X.md'); // frozen spec → denied
      expect(paths).not.toContain('package.json'); // greenfield config → allowed
      expect(paths).not.toContain('tsconfig.json');
      expect(paths).not.toContain('test/feed/rss.test.ts'); // test/ allowed
      expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false); // ignored
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
