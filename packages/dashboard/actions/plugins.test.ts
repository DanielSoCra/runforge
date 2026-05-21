import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
  listRecommendedInactivePluginIds: vi.fn(),
  setPluginActivation: vi.fn(),
  recordPluginRecommendation: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: mocks.requireDashboardAdmin,
}));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    plugins: {
      listRecommendedInactivePluginIds: mocks.listRecommendedInactivePluginIds,
      setPluginActivation: mocks.setPluginActivation,
      recordPluginRecommendation: mocks.recordPluginRecommendation,
    },
  }),
}));
vi.mock('@/lib/plugins/registry', () => ({ loadDashboardRegistry: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: vi.fn().mockResolvedValue({ content: [] }) },
  })),
}));

import Anthropic from '@anthropic-ai/sdk';
import { requireDashboardAdmin } from '@/lib/auth/require-session';
import { loadDashboardRegistry } from '@/lib/plugins/registry';

import {
  enableAllSuggested,
  exportPlugin,
  togglePlugin,
  triggerRecommendation,
} from './plugins.js';

const mockRegistry = {
  version: 1,
  plugins: [
    { id: 'web-stack', name: 'Web Stack', description: '', tags: [] },
  ],
};

function setAdminDefaults() {
  mocks.requireDashboardAdmin.mockResolvedValue({
    user: { id: 'admin-1', role: 'admin' },
  });
  vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
  mocks.listRecommendedInactivePluginIds.mockResolvedValue({
    ok: true,
    value: ['web-stack'],
  });
  mocks.setPluginActivation.mockResolvedValue({ ok: true, value: undefined });
  mocks.recordPluginRecommendation.mockResolvedValue({
    ok: true,
    value: undefined,
  });
}

describe('togglePlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminDefaults();
  });

  it('rejects unauthenticated callers', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Unauthorized'),
    );

    await expect(togglePlugin('repo-id', 'web-stack', true)).rejects.toThrow(
      'Unauthorized',
    );
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
  });

  it('rejects unknown plugin ids', async () => {
    const result = await togglePlugin('repo-id', 'unknown-plugin', true);
    expect(result.error).toContain('Unknown plugin');
    expect(mocks.setPluginActivation).not.toHaveBeenCalled();
  });

  it('updates plugin activation through the app-owned store', async () => {
    const result = await togglePlugin('repo-id', 'web-stack', true);

    expect(requireDashboardAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.setPluginActivation).toHaveBeenCalledWith(
      'repo-id',
      'web-stack',
      true,
      expect.any(Date),
    );
    expect(result.ok).toBe(true);
  });

  it('returns a generic error when activation update fails', async () => {
    mocks.setPluginActivation.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'db error',
    });

    const result = await togglePlugin('repo-id', 'web-stack', true);
    expect(result.error).toBe('Failed to update plugin');
  });
});

describe('enableAllSuggested', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminDefaults();
  });

  it('rejects unauthenticated callers without querying the store', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Unauthorized'),
    );

    await expect(enableAllSuggested('repo-id')).rejects.toThrow(
      'Unauthorized',
    );
    expect(mocks.listRecommendedInactivePluginIds).not.toHaveBeenCalled();
  });

  it('queries recommended inactive plugins from the app-owned store', async () => {
    const result = await enableAllSuggested('repo-id');

    expect(mocks.listRecommendedInactivePluginIds).toHaveBeenCalledWith(
      'repo-id',
    );
    expect(mocks.setPluginActivation).toHaveBeenCalledWith(
      'repo-id',
      'web-stack',
      true,
      expect.any(Date),
    );
    expect(result.succeeded).toContain('web-stack');
    expect(result.failed).toHaveLength(0);
  });

  it('tracks plugins whose activation failed in failed array', async () => {
    mocks.setPluginActivation.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'db error',
    });

    const result = await enableAllSuggested('repo-id');

    expect(result.failed).toContain('web-stack');
    expect(result.succeeded).toHaveLength(0);
  });

  it('succeeds for some plugins even when others fail', async () => {
    const multiRegistry = {
      version: 1,
      plugins: [
        { id: 'web-stack', name: 'Web Stack', description: '', tags: [] },
        { id: 'api-tools', name: 'API Tools', description: '', tags: [] },
      ],
    };
    vi.mocked(loadDashboardRegistry).mockResolvedValue(multiRegistry);
    mocks.listRecommendedInactivePluginIds.mockResolvedValueOnce({
      ok: true,
      value: ['web-stack', 'api-tools'],
    });
    mocks.setPluginActivation
      .mockResolvedValueOnce({ ok: true, value: undefined })
      .mockResolvedValueOnce({
        ok: false,
        error: 'unavailable',
        message: 'db error',
      });

    const result = await enableAllSuggested('repo-id');

    expect(result.succeeded).toEqual(['web-stack']);
    expect(result.failed).toEqual(['api-tools']);
    expect(mocks.setPluginActivation).toHaveBeenCalledTimes(2);
  });

  it('returns error field when the store read fails (#360)', async () => {
    mocks.listRecommendedInactivePluginIds.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'store unavailable',
    });

    const result = await enableAllSuggested('repo-id');

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.error).toBe('store unavailable');
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
    vi.mocked(loadDashboardRegistry).mockResolvedValue(multiRegistry);
    mocks.listRecommendedInactivePluginIds.mockResolvedValueOnce({
      ok: true,
      value: ['web-stack', 'api-tools', 'db-tools'],
    });

    await enableAllSuggested('repo-id');

    const timestamps = mocks.setPluginActivation.mock.calls.map(
      (call) => call[3] as Date,
    );
    expect(timestamps).toHaveLength(3);
    expect(new Set(timestamps.map((date) => date.toISOString())).size).toBe(3);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i].getTime() > timestamps[i - 1].getTime()).toBe(true);
    }
  });

  it('returns empty arrays when no recommended inactive plugins exist', async () => {
    mocks.listRecommendedInactivePluginIds.mockResolvedValueOnce({
      ok: true,
      value: [],
    });

    const result = await enableAllSuggested('repo-id');
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});

describe('triggerRecommendation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminDefaults();
  });

  it('returns early without calling Anthropic when unauthenticated', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Unauthorized'),
    );

    await expect(
      triggerRecommendation('repo-id', 'owner', 'repo'),
    ).rejects.toThrow('Unauthorized');
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
    expect(vi.mocked(Anthropic)).not.toHaveBeenCalled();
  });

  it('returns early when repoOwner fails SAFE_PATTERN', async () => {
    await expect(
      triggerRecommendation('repo-id', 'owner with spaces', 'repo'),
    ).resolves.toBeUndefined();
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
    expect(vi.mocked(Anthropic)).not.toHaveBeenCalled();
  });

  it('returns early when repoName fails SAFE_PATTERN', async () => {
    await expect(
      triggerRecommendation('repo-id', 'owner', 'repo;evil'),
    ).resolves.toBeUndefined();
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
    expect(vi.mocked(Anthropic)).not.toHaveBeenCalled();
  });

  const flushFireAndForget = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  function setupLLMTest(llmResponse: {
    content: Array<{ type: string; text: string }>;
  }) {
    const mockCreate = vi.fn().mockResolvedValue(llmResponse);
    vi.mocked(Anthropic).mockImplementation(function (this: unknown) {
      return { messages: { create: mockCreate } } as never;
    });
    return { mockCreate };
  }

  it('parses LLM JSON response and records recommendations matching the registry', async () => {
    const { mockCreate } = setupLLMTest({
      content: [
        {
          type: 'text',
          text: '{ "recommendations": [{ "pluginId": "web-stack", "confidence": "high", "reason": "Has package.json" }] }',
        },
      ],
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mocks.recordPluginRecommendation).toHaveBeenCalledWith(
      'repo-id',
      'web-stack',
      '[high] Has package.json',
    );
  });

  it('strips markdown code fences before parsing JSON', async () => {
    setupLLMTest({
      content: [
        {
          type: 'text',
          text: '```json\n{ "recommendations": [{ "pluginId": "web-stack", "confidence": "medium", "reason": "Detected web files" }] }\n```',
        },
      ],
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(mocks.recordPluginRecommendation).toHaveBeenCalledWith(
      'repo-id',
      'web-stack',
      '[medium] Detected web files',
    );
  });

  it('filters out recommendations for plugin IDs not in the registry', async () => {
    setupLLMTest({
      content: [
        {
          type: 'text',
          text: '{ "recommendations": [{ "pluginId": "unknown-plugin", "confidence": "high", "reason": "Hallucinated" }, { "pluginId": "web-stack", "confidence": "low", "reason": "Maybe" }] }',
        },
      ],
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(mocks.recordPluginRecommendation).toHaveBeenCalledTimes(1);
    expect(mocks.recordPluginRecommendation).toHaveBeenCalledWith(
      'repo-id',
      'web-stack',
      '[low] Maybe',
    );
  });

  it('does not record when LLM returns invalid JSON', async () => {
    setupLLMTest({
      content: [{ type: 'text', text: 'not valid json at all' }],
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(mocks.recordPluginRecommendation).not.toHaveBeenCalled();
  });

  it('does not record when LLM response content array is empty', async () => {
    setupLLMTest({ content: [] });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(mocks.recordPluginRecommendation).not.toHaveBeenCalled();
  });

  it('logs error when Anthropic API throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(Anthropic).mockImplementation(function (this: unknown) {
      return {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('API rate limit')),
        },
      } as never;
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(mocks.recordPluginRecommendation).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[plugins] triggerRecommendation background task failed:',
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('uses the app-owned store for background recommendation writes (#278)', async () => {
    setupLLMTest({
      content: [
        {
          type: 'text',
          text: '{ "recommendations": [{ "pluginId": "web-stack", "confidence": "high", "reason": "Has package.json" }] }',
        },
      ],
    });

    await triggerRecommendation('repo-id', 'owner', 'repo');
    await flushFireAndForget();

    expect(mocks.recordPluginRecommendation).toHaveBeenCalledOnce();
  });
});

describe('exportPlugin', () => {
  let tmpDir: string;
  let pluginsDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    setAdminDefaults();
    tmpDir = await mkdtemp(join(tmpdir(), 'export-test-'));
    pluginsDir = join(tmpDir, 'plugins');
    process.env['PLUGINS_DIR'] = pluginsDir;
    process.env['EXPORT_ALLOWED_DIRS'] = tmpDir;
  });

  afterEach(async () => {
    delete process.env['PLUGINS_DIR'];
    delete process.env['EXPORT_ALLOWED_DIRS'];
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated callers', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Unauthorized'),
    );

    await expect(
      exportPlugin('repo-id', 'web-stack', '/some/path'),
    ).rejects.toThrow('Unauthorized');
  });

  it('rejects plugin ids with unsafe characters', async () => {
    const result = await exportPlugin('repo-id', '../../etc', '/some/path');
    expect(result.error).toContain('Invalid plugin identifier');
  });

  it('rejects unknown plugin ids', async () => {
    const result = await exportPlugin('repo-id', 'nonexistent', '/some/path');
    expect(result.error).toContain('Unknown plugin');
  });

  it('rejects relative target paths', async () => {
    const result = await exportPlugin('repo-id', 'web-stack', 'relative/path');
    expect(result.error).toContain('Target path must be absolute');
  });

  it('rejects target path that does not exist', async () => {
    const result = await exportPlugin(
      'repo-id',
      'web-stack',
      '/nonexistent/path',
    );
    expect(result.error).toContain('does not exist');
  });

  it('copies skill documents to target repo .claude/plugins/<id>/skills/', async () => {
    const skillsDir = join(pluginsDir, 'web-stack', 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'testing.md'), '# Testing Guide\nUse vitest.');
    await writeFile(join(skillsDir, 'patterns.md'), '# Patterns\nUse composition.');

    const targetRepo = join(tmpDir, 'target-repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.ok).toBe(true);

    const destDir = join(
      targetRepo,
      '.claude',
      'plugins',
      'web-stack',
      'skills',
    );
    const files = await readdir(destDir);
    expect(files.sort()).toEqual(['patterns.md', 'testing.md']);

    const content = await readFile(join(destDir, 'testing.md'), 'utf-8');
    expect(content).toBe('# Testing Guide\nUse vitest.');
  });

  it('returns error when plugin has no skill documents', async () => {
    await mkdir(join(pluginsDir, 'web-stack', 'skills'), { recursive: true });

    const targetRepo = join(tmpDir, 'target-repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.error).toContain('No skill documents');
  });

  it('only copies .md files, skipping non-markdown files', async () => {
    const skillsDir = join(pluginsDir, 'web-stack', 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'guide.md'), '# Guide');
    await writeFile(join(skillsDir, '.gitkeep'), '');
    await writeFile(join(skillsDir, 'notes.txt'), 'not a skill');

    const targetRepo = join(tmpDir, 'target-repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.ok).toBe(true);

    const destDir = join(
      targetRepo,
      '.claude',
      'plugins',
      'web-stack',
      'skills',
    );
    const files = await readdir(destDir);
    expect(files).toEqual(['guide.md']);
  });

  it('rejects when EXPORT_ALLOWED_DIRS is not set', async () => {
    delete process.env['EXPORT_ALLOWED_DIRS'];

    const targetRepo = join(tmpDir, 'target-repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.error).toContain('EXPORT_ALLOWED_DIRS is not set');
  });

  it('rejects target path outside allowed directories', async () => {
    const allowedDir = await mkdtemp(join(tmpdir(), 'allowed-'));
    process.env['EXPORT_ALLOWED_DIRS'] = allowedDir;
    const disallowedTarget = await mkdtemp(join(tmpdir(), 'disallowed-'));

    const result = await exportPlugin('repo-id', 'web-stack', disallowedTarget);
    expect(result.error).toContain('outside allowed directories');

    await rm(allowedDir, { recursive: true, force: true });
    await rm(disallowedTarget, { recursive: true, force: true });
  });

  it('rejects symlink-based path escapes', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'outside-'));
    const symlinkPath = join(tmpDir, 'sneaky-link');
    await symlink(outsideDir, symlinkPath);

    const result = await exportPlugin('repo-id', 'web-stack', symlinkPath);
    expect(result.error).toContain('outside allowed directories');

    await rm(outsideDir, { recursive: true, force: true });
  });

  it('allows export when target is within EXPORT_ALLOWED_DIRS', async () => {
    const skillsDir = join(pluginsDir, 'web-stack', 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'guide.md'), '# Guide');

    const targetRepo = join(tmpDir, 'allowed-repo');
    await mkdir(targetRepo, { recursive: true });

    const result = await exportPlugin('repo-id', 'web-stack', targetRepo);
    expect(result.ok).toBe(true);
  });

  it('supports multiple colon-separated allowed directories', async () => {
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
