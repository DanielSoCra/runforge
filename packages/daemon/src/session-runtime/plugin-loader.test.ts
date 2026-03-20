import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// readMarkdownFiles is not exported — test indirectly via readPluginsForContext
import { readPluginsForContext, clearRegistryCache } from './plugin-loader.js';

describe('readPluginsForContext file size cap', () => {
  let pluginsDir: string;
  let pluginDir: string;
  const PLUGIN_ID = 'big-plugin';

  beforeEach(async () => {
    pluginsDir = join(tmpdir(), `plugin-loader-test-${Date.now()}`);
    pluginDir = join(pluginsDir, PLUGIN_ID);
    await mkdir(join(pluginDir, 'skills'), { recursive: true });
    await mkdir(join(pluginDir, 'agents'), { recursive: true });
    // Registry file required by getRegistry()
    await writeFile(join(pluginsDir, 'registry.json'), JSON.stringify({
      version: 1,
      plugins: [{ id: PLUGIN_ID, name: 'Big Plugin', tags: [] }],
    }));
    await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify({
      id: PLUGIN_ID, name: 'Big Plugin', version: '1.0.0', description: 'Test',
    }));
  });

  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true });
    clearRegistryCache(); // Clear cached Promise so next test loads fresh
  });

  it('skips skill files larger than MAX_FILE_SIZE', async () => {
    // Create a file larger than 100KB
    const bigContent = 'x'.repeat(101_000);
    await writeFile(join(pluginDir, 'skills', 'big-skill.md'), bigContent);

    const orig = process.env['PLUGINS_DIR'];
    process.env['PLUGINS_DIR'] = pluginsDir;
    try {
      const result = await readPluginsForContext([PLUGIN_ID], new Map());
      const plugin = result.find(p => p.id === PLUGIN_ID);
      expect(plugin?.skills).toHaveLength(0);
    } finally {
      if (orig === undefined) delete process.env['PLUGINS_DIR'];
      else process.env['PLUGINS_DIR'] = orig;
    }
  });
});
