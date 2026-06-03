// src/session-runtime/claude-project-trust.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { seedClaudeProjectTrust } from './claude-project-trust.js';

describe('seedClaudeProjectTrust', () => {
  let home: string;
  let configPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'claude-trust-'));
    configPath = join(home, '.claude.json');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('creates ~/.claude.json with onboarding + per-project trust when absent', async () => {
    await seedClaudeProjectTrust('/app/packages/daemon', { home });
    const json = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(json.hasCompletedOnboarding).toBe(true);
    expect(json.projects['/app/packages/daemon'].hasTrustDialogAccepted).toBe(true);
    expect(json.projects['/app/packages/daemon'].hasCompletedProjectOnboarding).toBe(true);
  });

  it('preserves existing keys and other projects (upsert, not overwrite)', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        hasCompletedOnboarding: true,
        userID: 'keep-me',
        projects: {
          '/some/other/host/path': { hasTrustDialogAccepted: true, foo: 'bar' },
        },
      }),
    );
    await seedClaudeProjectTrust('/app/packages/daemon/workspaces/issue-42', { home });
    const json = JSON.parse(await readFile(configPath, 'utf-8'));
    // existing data preserved
    expect(json.userID).toBe('keep-me');
    expect(json.projects['/some/other/host/path']).toEqual({
      hasTrustDialogAccepted: true,
      foo: 'bar',
    });
    // new project trusted
    expect(
      json.projects['/app/packages/daemon/workspaces/issue-42'].hasTrustDialogAccepted,
    ).toBe(true);
  });

  it('is idempotent — seeding the same path twice yields one entry', async () => {
    await seedClaudeProjectTrust('/app/packages/daemon', { home });
    await seedClaudeProjectTrust('/app/packages/daemon', { home });
    const json = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(Object.keys(json.projects)).toEqual(['/app/packages/daemon']);
  });

  it('merges into a pre-existing entry for the same path without dropping its fields', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        projects: {
          '/app/packages/daemon': { lastUsed: '2026-01-01', allowedTools: ['Read'] },
        },
      }),
    );
    await seedClaudeProjectTrust('/app/packages/daemon', { home });
    const json = JSON.parse(await readFile(configPath, 'utf-8'));
    const entry = json.projects['/app/packages/daemon'];
    expect(entry.lastUsed).toBe('2026-01-01');
    expect(entry.allowedTools).toEqual(['Read']);
    expect(entry.hasTrustDialogAccepted).toBe(true);
  });

  it('rejects relative / non-absolute paths (refuse to trust ambiguous cwd)', async () => {
    await expect(seedClaudeProjectTrust('relative/path', { home })).rejects.toThrow(
      /absolute/i,
    );
  });
});
