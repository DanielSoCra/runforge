import { describe, it, expect } from 'vitest';
import { join } from 'path';
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
