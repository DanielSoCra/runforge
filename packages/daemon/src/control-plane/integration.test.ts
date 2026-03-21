// src/control-plane/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  acquireIntegrationLock,
  releaseIntegrationLock,
  isIntegrationLocked,
  integrateToStaging,
} from './integration.js';

// Helper: run a command with array args in a given directory (no shell)
function sh(cmd: string, args: string[], cwd: string): void {
  const result = spawnSync(cmd, args, { cwd, stdio: 'pipe' });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    throw new Error(`Command "${cmd} ${args.join(' ')}" failed: ${stderr}`);
  }
}

// Helper: set up a minimal git repo with an initial commit on 'main'
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'integration-'));
  sh('git', ['init', '-b', 'main'], dir);
  sh('git', ['config', 'user.email', 'test@test.com'], dir);
  sh('git', ['config', 'user.name', 'Test'], dir);
  await writeFile(join(dir, 'README.md'), '# test\n');
  sh('git', ['add', 'README.md'], dir);
  sh('git', ['commit', '-m', 'init'], dir);
  return dir;
}

describe('integration lock', () => {
  beforeEach(() => {
    releaseIntegrationLock();
  });

  afterEach(() => {
    releaseIntegrationLock();
  });

  it('acquires the lock when free', () => {
    expect(isIntegrationLocked()).toBe(false);
    const acquired = acquireIntegrationLock();
    expect(acquired).toBe(true);
    expect(isIntegrationLocked()).toBe(true);
  });

  it('rejects second lock acquisition while locked', () => {
    acquireIntegrationLock();
    const second = acquireIntegrationLock();
    expect(second).toBe(false);
  });

  it('allows re-acquisition after release', () => {
    acquireIntegrationLock();
    releaseIntegrationLock();
    expect(isIntegrationLocked()).toBe(false);
    const reacquired = acquireIntegrationLock();
    expect(reacquired).toBe(true);
  });

  it('isIntegrationLocked reflects lock state', () => {
    expect(isIntegrationLocked()).toBe(false);
    acquireIntegrationLock();
    expect(isIntegrationLocked()).toBe(true);
    releaseIntegrationLock();
    expect(isIntegrationLocked()).toBe(false);
  });
});

describe('integrateToStaging', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeRepo();
  });

  it('merges a clean feature branch into staging with --no-ff', async () => {
    // Create staging branch from main
    sh('git', ['checkout', '-b', 'staging'], repoDir);
    sh('git', ['checkout', 'main'], repoDir);

    // Create a feature branch with a new file
    sh('git', ['checkout', '-b', 'feature/add-hello'], repoDir);
    await writeFile(join(repoDir, 'hello.ts'), 'export const hello = "world";\n');
    sh('git', ['add', 'hello.ts'], repoDir);
    sh('git', ['commit', '-m', 'add hello'], repoDir);

    const result = await integrateToStaging('feature/add-hello', 'staging', repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.success).toBe(true);
    expect(result.value.conflicted).toBe(false);

    // Verify staging has the merge commit
    const log = spawnSync('git', ['log', '--oneline', 'staging'], { cwd: repoDir });
    expect(log.stdout.toString()).toContain('integrate: feature/add-hello');
  });

  it('detects conflicts and aborts the merge', async () => {
    // Create staging with a conflicting file
    sh('git', ['checkout', '-b', 'staging'], repoDir);
    await writeFile(join(repoDir, 'conflict.ts'), 'const x = "staging";\n');
    sh('git', ['add', 'conflict.ts'], repoDir);
    sh('git', ['commit', '-m', 'staging change'], repoDir);

    // Create feature branch from main with conflicting change
    sh('git', ['checkout', 'main'], repoDir);
    sh('git', ['checkout', '-b', 'feature/conflict'], repoDir);
    await writeFile(join(repoDir, 'conflict.ts'), 'const x = "feature";\n');
    sh('git', ['add', 'conflict.ts'], repoDir);
    sh('git', ['commit', '-m', 'feature change'], repoDir);

    const result = await integrateToStaging('feature/conflict', 'staging', repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.success).toBe(false);
    expect(result.value.conflicted).toBe(true);
    expect(result.value.error).toContain('conflict');

    // Verify that the merge was aborted (staging is clean)
    const status = spawnSync('git', ['status', '--short'], { cwd: repoDir });
    expect(status.stdout.toString().trim()).toBe('');
  });

  it('returns err when staging branch does not exist', async () => {
    sh('git', ['checkout', '-b', 'feature/test'], repoDir);
    await writeFile(join(repoDir, 'new.ts'), 'export {};\n');
    sh('git', ['add', 'new.ts'], repoDir);
    sh('git', ['commit', '-m', 'new file'], repoDir);

    const result = await integrateToStaging('feature/test', 'nonexistent-staging', repoDir);
    expect(result.ok).toBe(false);
  });

  it('returns err when feature branch does not exist', async () => {
    sh('git', ['checkout', '-b', 'staging'], repoDir);
    sh('git', ['checkout', 'main'], repoDir);

    const result = await integrateToStaging('feature/does-not-exist', 'staging', repoDir);
    expect(result.ok).toBe(false);
  });

  it('acquires and releases the integration lock during merge', async () => {
    // Create staging branch from main
    sh('git', ['checkout', '-b', 'staging'], repoDir);
    sh('git', ['checkout', 'main'], repoDir);

    // Create a feature branch
    sh('git', ['checkout', '-b', 'feature/lock-test'], repoDir);
    await writeFile(join(repoDir, 'lock-test.ts'), 'export {};\n');
    sh('git', ['add', 'lock-test.ts'], repoDir);
    sh('git', ['commit', '-m', 'lock test'], repoDir);

    // Lock should be free before and after
    expect(isIntegrationLocked()).toBe(false);
    const result = await integrateToStaging('feature/lock-test', 'staging', repoDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.success).toBe(true);
    expect(isIntegrationLocked()).toBe(false);
  });

  it('rejects concurrent integration when lock is held', async () => {
    // Manually acquire the lock to simulate a concurrent run
    acquireIntegrationLock();

    sh('git', ['checkout', '-b', 'staging'], repoDir);
    sh('git', ['checkout', 'main'], repoDir);
    sh('git', ['checkout', '-b', 'feature/blocked'], repoDir);
    await writeFile(join(repoDir, 'blocked.ts'), 'export {};\n');
    sh('git', ['add', 'blocked.ts'], repoDir);
    sh('git', ['commit', '-m', 'blocked'], repoDir);

    const result = await integrateToStaging('feature/blocked', 'staging', repoDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('lock');

    // Clean up
    releaseIntegrationLock();
  });

  it('releases the lock even when merge fails', async () => {
    // No staging branch — merge will fail
    sh('git', ['checkout', '-b', 'feature/fail'], repoDir);
    await writeFile(join(repoDir, 'fail.ts'), 'export {};\n');
    sh('git', ['add', 'fail.ts'], repoDir);
    sh('git', ['commit', '-m', 'fail'], repoDir);

    expect(isIntegrationLocked()).toBe(false);
    const result = await integrateToStaging('feature/fail', 'nonexistent', repoDir);
    expect(result.ok).toBe(false);
    // Lock must be released even on failure
    expect(isIntegrationLocked()).toBe(false);
  });

  it('releases the lock after conflict detection', async () => {
    // Create staging with a conflicting file
    sh('git', ['checkout', '-b', 'staging'], repoDir);
    await writeFile(join(repoDir, 'conflict.ts'), 'const x = "staging";\n');
    sh('git', ['add', 'conflict.ts'], repoDir);
    sh('git', ['commit', '-m', 'staging change'], repoDir);

    // Create feature branch from main with conflicting change
    sh('git', ['checkout', 'main'], repoDir);
    sh('git', ['checkout', '-b', 'feature/conflict-lock'], repoDir);
    await writeFile(join(repoDir, 'conflict.ts'), 'const x = "feature";\n');
    sh('git', ['add', 'conflict.ts'], repoDir);
    sh('git', ['commit', '-m', 'feature change'], repoDir);

    expect(isIntegrationLocked()).toBe(false);
    const result = await integrateToStaging('feature/conflict-lock', 'staging', repoDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.conflicted).toBe(true);
    }
    // Lock must be released after conflict
    expect(isIntegrationLocked()).toBe(false);
  });
});
