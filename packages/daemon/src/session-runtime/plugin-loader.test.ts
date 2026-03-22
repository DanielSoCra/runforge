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
    clearRegistryCache(); // Ensure no cached registry from previous tests
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

  it('truncates prompt-injection.md content larger than MAX_INJECTION_BYTES', async () => {
    // Create a prompt-injection.md larger than 20KB
    const bigInjection = 'y'.repeat(25_000);
    await writeFile(join(pluginDir, 'prompt-injection.md'), bigInjection);

    const orig = process.env['PLUGINS_DIR'];
    process.env['PLUGINS_DIR'] = pluginsDir;
    try {
      const result = await readPluginsForContext([PLUGIN_ID], new Map());
      const plugin = result.find(p => p.id === PLUGIN_ID);
      expect(Buffer.byteLength(plugin!.promptInjection, 'utf-8')).toBe(20_000);
    } finally {
      if (orig === undefined) delete process.env['PLUGINS_DIR'];
      else process.env['PLUGINS_DIR'] = orig;
    }
  });

  it('truncates multi-byte UTF-8 prompt-injection by byte count, not character count (#119)', async () => {
    // Each '€' is 3 bytes in UTF-8. 7000 chars × 3 bytes = 21,000 bytes > 20,000 limit.
    // Old code checked string.length (7000) against 20,000 and would NOT truncate.
    const multiByteContent = '€'.repeat(7_000);
    expect(Buffer.byteLength(multiByteContent, 'utf-8')).toBe(21_000); // sanity check
    await writeFile(join(pluginDir, 'prompt-injection.md'), multiByteContent);

    const orig = process.env['PLUGINS_DIR'];
    process.env['PLUGINS_DIR'] = pluginsDir;
    try {
      const result = await readPluginsForContext([PLUGIN_ID], new Map());
      const plugin = result.find(p => p.id === PLUGIN_ID);
      const resultBytes = Buffer.byteLength(plugin!.promptInjection, 'utf-8');
      // 6,666 complete € characters × 3 bytes = 19,998 (largest multiple of 3 ≤ 20,000)
      expect(resultBytes).toBe(19_998);
    } finally {
      if (orig === undefined) delete process.env['PLUGINS_DIR'];
      else process.env['PLUGINS_DIR'] = orig;
    }
  });
});

describe('readPluginsForContext mcpConfigs loading', () => {
  let pluginsDir: string;
  let pluginDir: string;
  const PLUGIN_ID = 'mcp-plugin';

  beforeEach(async () => {
    clearRegistryCache();
    pluginsDir = join(tmpdir(), `plugin-loader-mcp-test-${Date.now()}`);
    pluginDir = join(pluginsDir, PLUGIN_ID);
    await mkdir(join(pluginDir, 'skills'), { recursive: true });
    await mkdir(join(pluginDir, 'agents'), { recursive: true });
    await writeFile(join(pluginsDir, 'registry.json'), JSON.stringify({
      version: 1,
      plugins: [{ id: PLUGIN_ID, name: 'MCP Plugin', tags: [] }],
    }));
    await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify({
      id: PLUGIN_ID, name: 'MCP Plugin', version: '1.0.0', description: 'Test',
    }));
  });

  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true });
    clearRegistryCache();
  });

  it('returns empty array when no mcps/ directory exists', async () => {
    const orig = process.env['PLUGINS_DIR'];
    process.env['PLUGINS_DIR'] = pluginsDir;
    try {
      const result = await readPluginsForContext([PLUGIN_ID], new Map());
      expect(result[0]?.mcpConfigs).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env['PLUGINS_DIR'];
      else process.env['PLUGINS_DIR'] = orig;
    }
  });

  it('loads mcpConfigs from mcps/*.json files', async () => {
    await mkdir(join(pluginDir, 'mcps'), { recursive: true });
    await writeFile(join(pluginDir, 'mcps', 'firecrawl.json'), JSON.stringify({
      name: 'firecrawl',
      command: 'npx',
      args: ['-y', 'firecrawl-mcp'],
      env: { FIRECRAWL_API_KEY: 'test-key' },
    }));

    const orig = process.env['PLUGINS_DIR'];
    process.env['PLUGINS_DIR'] = pluginsDir;
    try {
      const result = await readPluginsForContext([PLUGIN_ID], new Map());
      expect(result[0]?.mcpConfigs).toHaveLength(1);
      expect(result[0]?.mcpConfigs[0]).toMatchObject({
        name: 'firecrawl',
        command: 'npx',
        args: ['-y', 'firecrawl-mcp'],
        env: { FIRECRAWL_API_KEY: 'test-key' },
      });
    } finally {
      if (orig === undefined) delete process.env['PLUGINS_DIR'];
      else process.env['PLUGINS_DIR'] = orig;
    }
  });

  it('loads multiple mcpConfigs', async () => {
    await mkdir(join(pluginDir, 'mcps'), { recursive: true });
    await writeFile(join(pluginDir, 'mcps', 'firecrawl.json'), JSON.stringify({
      name: 'firecrawl',
      command: 'npx',
      args: ['-y', 'firecrawl-mcp'],
    }));
    await writeFile(join(pluginDir, 'mcps', 'playwright.json'), JSON.stringify({
      name: 'playwright',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
    }));

    const orig = process.env['PLUGINS_DIR'];
    process.env['PLUGINS_DIR'] = pluginsDir;
    try {
      const result = await readPluginsForContext([PLUGIN_ID], new Map());
      expect(result[0]?.mcpConfigs).toHaveLength(2);
      const names = result[0]?.mcpConfigs.map(c => c.name);
      expect(names).toContain('firecrawl');
      expect(names).toContain('playwright');
    } finally {
      if (orig === undefined) delete process.env['PLUGINS_DIR'];
      else process.env['PLUGINS_DIR'] = orig;
    }
  });

  it('loads gate scripts from gates/ directory (#47)', async () => {
    await mkdir(join(pluginDir, 'gates'), { recursive: true });
    await writeFile(join(pluginDir, 'gates', 'lint.sh'), '#!/bin/bash\nnpx eslint .');
    await writeFile(join(pluginDir, 'gates', 'typecheck.sh'), '#!/bin/bash\ntsc --noEmit');

    const orig = process.env['PLUGINS_DIR'];
    process.env['PLUGINS_DIR'] = pluginsDir;
    try {
      const result = await readPluginsForContext([PLUGIN_ID], new Map());
      expect(result[0]?.gates).toHaveLength(2);
      expect(result[0]?.gates).toContain('#!/bin/bash\nnpx eslint .');
      expect(result[0]?.gates).toContain('#!/bin/bash\ntsc --noEmit');
    } finally {
      if (orig === undefined) delete process.env['PLUGINS_DIR'];
      else process.env['PLUGINS_DIR'] = orig;
    }
  });

  it('returns empty gates array when no gates/ directory exists (#47)', async () => {
    const orig = process.env['PLUGINS_DIR'];
    process.env['PLUGINS_DIR'] = pluginsDir;
    try {
      const result = await readPluginsForContext([PLUGIN_ID], new Map());
      expect(result[0]?.gates).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env['PLUGINS_DIR'];
      else process.env['PLUGINS_DIR'] = orig;
    }
  });

  it('skips malformed JSON files in mcps/', async () => {
    await mkdir(join(pluginDir, 'mcps'), { recursive: true });
    await writeFile(join(pluginDir, 'mcps', 'bad.json'), 'this is not valid json {{{');
    await writeFile(join(pluginDir, 'mcps', 'good.json'), JSON.stringify({
      name: 'good-mcp',
      command: 'node',
      args: ['server.js'],
    }));

    const orig = process.env['PLUGINS_DIR'];
    process.env['PLUGINS_DIR'] = pluginsDir;
    try {
      const result = await readPluginsForContext([PLUGIN_ID], new Map());
      expect(result[0]?.mcpConfigs).toHaveLength(1);
      expect(result[0]?.mcpConfigs[0]?.name).toBe('good-mcp');
    } finally {
      if (orig === undefined) delete process.env['PLUGINS_DIR'];
      else process.env['PLUGINS_DIR'] = orig;
    }
  });
});
