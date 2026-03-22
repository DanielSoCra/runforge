import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile, symlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/plugins/registry', () => ({ loadDashboardRegistry: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: vi.fn().mockResolvedValue({ content: [] }) },
  })),
}));

import { togglePlugin, enableAllSuggested, triggerRecommendation, exportPlugin } from './plugins.js';
import { createClient } from '@/lib/supabase/server';
import { loadDashboardRegistry } from '@/lib/plugins/registry';
import { requireAdmin } from '@/lib/auth';
import Anthropic from '@anthropic-ai/sdk';

const mockRegistry = { version: 1, plugins: [{ id: 'web-stack', name: 'Web Stack', description: '', tags: [] }] };

describe('togglePlugin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unauthenticated callers', async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error('Unauthorized'));
    vi.mocked(createClient).mockResolvedValue({} as never);
    const result = await togglePlugin('repo-id', 'web-stack', true);
    expect(result.error).toContain('Unauthorized');
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
  });

  it('rejects unknown plugin ids', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);
    const result = await togglePlugin('repo-id', 'unknown-plugin', true);
    expect(result.error).toContain('Unknown plugin');
  });

  it('upserts repo_plugins on valid plugin id', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({ upsert }),
    } as never);
    const result = await togglePlugin('repo-id', 'web-stack', true);
    expect(upsert).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });
});

describe('enableAllSuggested', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unauthenticated callers without querying DB', async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error('Unauthorized'));
    const fromSpy = vi.fn();
    vi.mocked(createClient).mockResolvedValue({ from: fromSpy } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.failed.length).toBe(0);
    expect(result.succeeded.length).toBe(0);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('queries DB for recommended+inactive plugins instead of accepting caller IDs', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const eqActive = vi.fn().mockResolvedValue({ data: [{ plugin_id: 'web-stack' }], error: null });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: (table: string) => (table === 'repo_plugins' ? { select, upsert } : { upsert }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(eqRecommended).toHaveBeenCalledWith('recommended', true);
    expect(eqActive).toHaveBeenCalledWith('active', false);
    expect(result.succeeded).toContain('web-stack');
    expect(result.failed).toHaveLength(0);
  });

  it('tracks plugins whose toggle failed in failed array', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: { message: 'db error' } });
    const eqActive = vi.fn().mockResolvedValue({ data: [{ plugin_id: 'web-stack' }], error: null });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: (table: string) => (table === 'repo_plugins' ? { select, upsert } : { upsert }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.failed).toContain('web-stack');
    expect(result.succeeded).toHaveLength(0);
  });

  it('succeeds for some plugins even when others fail (independent upserts)', async () => {
    const multiRegistry = {
      version: 1,
      plugins: [
        { id: 'web-stack', name: 'Web Stack', description: '', tags: [] },
        { id: 'api-tools', name: 'API Tools', description: '', tags: [] },
      ],
    };
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(multiRegistry);

    const upsert = vi.fn()
      .mockResolvedValueOnce({ error: null })        // web-stack succeeds
      .mockResolvedValueOnce({ error: { message: 'db error' } }); // api-tools fails
    const eqActive = vi.fn().mockResolvedValue({
      data: [{ plugin_id: 'web-stack' }, { plugin_id: 'api-tools' }],
      error: null,
    });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: (table: string) => (table === 'repo_plugins' ? { select, upsert } : { upsert }),
    } as never);

    const result = await enableAllSuggested('repo-id');
    expect(result.succeeded).toEqual(['web-stack']);
    expect(result.failed).toEqual(['api-tools']);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('returns empty arrays when the DB query errors', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    const eqActive = vi.fn().mockResolvedValue({ data: null, error: { message: 'rls violation' } });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({ select }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('assigns distinct activated_at timestamps to each plugin for deterministic merge order', async () => {
    const multiRegistry = {
      version: 1,
      plugins: [
        { id: 'web-stack', name: 'Web Stack', description: '', tags: [] },
        { id: 'api-tools', name: 'API Tools', description: '', tags: [] },
        { id: 'db-tools', name: 'DB Tools', description: '', tags: [] },
      ],
    };
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(multiRegistry);

    const upsertPayloads: Array<Record<string, unknown>> = [];
    const upsert = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      upsertPayloads.push(payload);
      return Promise.resolve({ error: null });
    });
    const eqActive = vi.fn().mockResolvedValue({
      data: [{ plugin_id: 'web-stack' }, { plugin_id: 'api-tools' }, { plugin_id: 'db-tools' }],
      error: null,
    });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: (table: string) => (table === 'repo_plugins' ? { select, upsert } : { upsert }),
    } as never);

    await enableAllSuggested('repo-id');

    expect(upsertPayloads).toHaveLength(3);
    const timestamps = upsertPayloads.map(p => p.activated_at as string);
    // All timestamps must be distinct
    expect(new Set(timestamps).size).toBe(3);
    // Timestamps must be in ascending order (preserving array order as activation order)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] > timestamps[i - 1]).toBe(true);
    }
  });

  it('returns empty arrays when no recommended+inactive plugins exist', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    const eqActive = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({ select }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});

describe('triggerRecommendation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns early without calling Anthropic when unauthenticated', async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error('Unauthorized'));
    vi.mocked(createClient).mockResolvedValue({} as never);
    // Should return without throwing
    await expect(triggerRecommendation('repo-id', 'owner', 'repo')).resolves.toBeUndefined();
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
    expect(vi.mocked(Anthropic)).not.toHaveBeenCalled();
  });

  it('returns early when repoOwner fails SAFE_PATTERN', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(createClient).mockResolvedValue({} as never);
    // repoOwner with spaces fails the pattern
    await expect(triggerRecommendation('repo-id', 'owner with spaces', 'repo')).resolves.toBeUndefined();
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
    expect(vi.mocked(Anthropic)).not.toHaveBeenCalled();
  });

  it('returns early when repoName fails SAFE_PATTERN', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(createClient).mockResolvedValue({} as never);
    // repoName with semicolon fails the pattern
    await expect(triggerRecommendation('repo-id', 'owner', 'repo;evil')).resolves.toBeUndefined();
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
    expect(vi.mocked(Anthropic)).not.toHaveBeenCalled();
  });

  // Helper: the fire-and-forget IIFE resolves via microtasks (all I/O is mocked).
  // Multiple ticks ensure chained await continuations all settle.
  // NOTE: The tick count (10) exceeds the IIFE's ~5 await points. If the production
  // code adds more awaits, increase this count or switch to vi.waitFor().
  const flushFireAndForget = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };

  // Setup helper for tests that exercise the LLM code path inside the IIFE.
  function setupLLMTest(llmResponse: { content: Array<{ type: string; text: string }> }) {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => ({ upsert }) } as never);
    const mockCreate = vi.fn().mockResolvedValue(llmResponse);
    // Must use mockImplementation (not mockReturnValue) — the factory's
    // mockImplementation takes precedence over mockReturnValue.
    vi.mocked(Anthropic).mockImplementation(function (this: unknown) {
      return { messages: { create: mockCreate } } as never;
    });
    return { mockCreate, upsert };
  }

  it('parses LLM JSON response and upserts recommendations matching the registry', async () => {
    const { mockCreate, upsert } = setupLLMTest({
      content: [{ type: 'text', text: '{ "recommendations": [{ "pluginId": "web-stack", "confidence": "high", "reason": "Has package.json" }] }' }],
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        repo_id: 'repo-id',
        plugin_id: 'web-stack',
        recommended: true,
        recommendation_reason: '[high] Has package.json',
      }),
      { onConflict: 'repo_id,plugin_id' },
    );
  });

  it('strips markdown code fences before parsing JSON', async () => {
    const fencedJson = '```json\n{ "recommendations": [{ "pluginId": "web-stack", "confidence": "medium", "reason": "Detected web files" }] }\n```';
    const { upsert } = setupLLMTest({
      content: [{ type: 'text', text: fencedJson }],
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ plugin_id: 'web-stack', recommendation_reason: '[medium] Detected web files' }),
      { onConflict: 'repo_id,plugin_id' },
    );
  });

  it('filters out recommendations for plugin IDs not in the registry', async () => {
    const { upsert } = setupLLMTest({
      content: [{ type: 'text', text: '{ "recommendations": [{ "pluginId": "unknown-plugin", "confidence": "high", "reason": "Hallucinated" }, { "pluginId": "web-stack", "confidence": "low", "reason": "Maybe" }] }' }],
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ plugin_id: 'web-stack' }),
      { onConflict: 'repo_id,plugin_id' },
    );
  });

  it('does not upsert when LLM returns invalid JSON', async () => {
    const { upsert } = setupLLMTest({
      content: [{ type: 'text', text: 'not valid json at all' }],
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not upsert when LLM response content array is empty (falls through to JSON parse failure)', async () => {
    const { upsert } = setupLLMTest({ content: [] });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(upsert).not.toHaveBeenCalled();
  });

  it('fails silently when Anthropic API throws', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn();
    vi.mocked(createClient).mockResolvedValue({ from: () => ({ upsert }) } as never);
    vi.mocked(Anthropic).mockImplementation(function (this: unknown) {
      return { messages: { create: vi.fn().mockRejectedValue(new Error('API rate limit')) } } as never;
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('exportPlugin', () => {
  let tmpDir: string;
  let pluginsDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(join(tmpdir(), 'export-test-'));
    pluginsDir = join(tmpDir, 'plugins');
    // Set PLUGINS_DIR so the Server Action reads from our temp directory
    process.env['PLUGINS_DIR'] = pluginsDir;
    // Set EXPORT_ALLOWED_DIRS to allow writing within our temp directory
    process.env['EXPORT_ALLOWED_DIRS'] = tmpDir;
  });

  afterEach(async () => {
    delete process.env['PLUGINS_DIR'];
    delete process.env['EXPORT_ALLOWED_DIRS'];
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated callers', async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error('Unauthorized'));
    vi.mocked(createClient).mockResolvedValue({} as never);
    const result = await exportPlugin('repo-id', 'web-stack', '/some/path');
    expect(result.error).toContain('Unauthorized');
  });

  it('rejects plugin ids with unsafe characters', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(createClient).mockResolvedValue({} as never);
    const result = await exportPlugin('repo-id', '../../etc', '/some/path');
    expect(result.error).toContain('Invalid plugin identifier');
  });

  it('rejects unknown plugin ids', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);
    const result = await exportPlugin('repo-id', 'nonexistent', '/some/path');
    expect(result.error).toContain('Unknown plugin');
  });

  it('rejects relative target paths', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);
    const result = await exportPlugin('repo-id', 'web-stack', 'relative/path');
    expect(result.error).toContain('Target path must be absolute');
  });

  it('rejects target path that does not exist', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);
    const result = await exportPlugin('repo-id', 'web-stack', '/nonexistent/path');
    expect(result.error).toContain('does not exist');
  });

  it('copies skill documents to target repo .claude/plugins/<id>/skills/', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);

    // Create a fake plugin with skills
    const skillsDir = join(pluginsDir, 'web-stack', 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'testing.md'), '# Testing Guide\nUse vitest.');
    await writeFile(join(skillsDir, 'patterns.md'), '# Patterns\nUse composition.');

    const targetRepo = join(tmpDir, 'target-repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.ok).toBe(true);

    // Verify files were copied
    const destDir = join(targetRepo, '.claude', 'plugins', 'web-stack', 'skills');
    const files = await readdir(destDir);
    expect(files.sort()).toEqual(['patterns.md', 'testing.md']);

    const content = await readFile(join(destDir, 'testing.md'), 'utf-8');
    expect(content).toBe('# Testing Guide\nUse vitest.');
  });

  it('returns error when plugin has no skill documents', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);

    // Create plugin dir with no skills
    await mkdir(join(pluginsDir, 'web-stack', 'skills'), { recursive: true });

    const targetRepo = join(tmpDir, 'target-repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.error).toContain('No skill documents');
  });

  it('only copies .md files, skipping non-markdown files', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);

    const skillsDir = join(pluginsDir, 'web-stack', 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'guide.md'), '# Guide');
    await writeFile(join(skillsDir, '.gitkeep'), '');
    await writeFile(join(skillsDir, 'notes.txt'), 'not a skill');

    const targetRepo = join(tmpDir, 'target-repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.ok).toBe(true);

    const destDir = join(targetRepo, '.claude', 'plugins', 'web-stack', 'skills');
    const files = await readdir(destDir);
    expect(files).toEqual(['guide.md']);
  });

  it('rejects when EXPORT_ALLOWED_DIRS is not set (fail closed)', async () => {
    delete process.env['EXPORT_ALLOWED_DIRS'];
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);

    const targetRepo = join(tmpDir, 'target-repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.error).toContain('EXPORT_ALLOWED_DIRS is not set');
  });

  it('rejects target path outside allowed directories', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);

    // Set allowed dirs to a different location than where we'll target
    const allowedDir = await mkdtemp(join(tmpdir(), 'allowed-'));
    process.env['EXPORT_ALLOWED_DIRS'] = allowedDir;

    const disallowedTarget = await mkdtemp(join(tmpdir(), 'disallowed-'));

    const result = await exportPlugin('repo-id', 'web-stack', disallowedTarget);
    expect(result.error).toContain('outside allowed directories');

    await rm(allowedDir, { recursive: true, force: true });
    await rm(disallowedTarget, { recursive: true, force: true });
  });

  it('rejects symlink-based path escapes', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);

    // Create an outside directory that the symlink will point to
    const outsideDir = await mkdtemp(join(tmpdir(), 'outside-'));

    // Create a symlink inside the allowed tmpDir that points outside
    const symlinkPath = join(tmpDir, 'sneaky-link');
    await symlink(outsideDir, symlinkPath);

    const result = await exportPlugin('repo-id', 'web-stack', symlinkPath);
    expect(result.error).toContain('outside allowed directories');

    await rm(outsideDir, { recursive: true, force: true });
  });

  it('allows export when target is within EXPORT_ALLOWED_DIRS', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);

    const skillsDir = join(pluginsDir, 'web-stack', 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'guide.md'), '# Guide');

    const targetRepo = join(tmpDir, 'allowed-repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.ok).toBe(true);
  });

  it('supports multiple colon-separated allowed directories', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);

    const secondAllowed = await mkdtemp(join(tmpdir(), 'second-allowed-'));
    process.env['EXPORT_ALLOWED_DIRS'] = `/nonexistent:${secondAllowed}`;

    const skillsDir = join(pluginsDir, 'web-stack', 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'guide.md'), '# Guide');

    const targetRepo = join(secondAllowed, 'repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.ok).toBe(true);

    await rm(secondAllowed, { recursive: true, force: true });
  });
});
