import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadPluginRegistry } from './plugin-registry.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('loadPluginRegistry', () => {
  it('loads a valid registry and returns plugins', async () => {
    const registry = await loadPluginRegistry(join(FIXTURES, 'plugins'));
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]!.id).toBe('test-plugin');
    expect(registry.plugins[0]!.dir).toContain('test-plugin');
  });

  it('throws when a plugin directory is missing', async () => {
    await expect(loadPluginRegistry(join(FIXTURES, 'plugins-missing-dir'))).rejects.toThrow(
      'Plugin directory not found',
    );
  });

  it('throws when manifest is missing required fields', async () => {
    await expect(loadPluginRegistry(join(FIXTURES, 'plugins-bad-manifest'))).rejects.toThrow(
      'missing required fields',
    );
  });
});

describe('loadPluginRegistry malformed JSON', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-registry-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws a descriptive error when registry.json is malformed JSON', async () => {
    await writeFile(join(dir, 'registry.json'), '{ not valid json }');
    await expect(loadPluginRegistry(dir)).rejects.toThrow('is not valid JSON');
  });

  it('throws a descriptive error when a plugin manifest.json is malformed JSON', async () => {
    const pluginDir = join(dir, 'my-plugin');
    await mkdir(pluginDir);
    await writeFile(join(dir, 'registry.json'), JSON.stringify({
      version: 1,
      plugins: [{ id: 'my-plugin', name: 'Test', tags: [] }],
    }));
    await writeFile(join(pluginDir, 'manifest.json'), '{ bad json }');
    await expect(loadPluginRegistry(dir)).rejects.toThrow('my-plugin');
  });
});
