import { readFile } from 'fs/promises';
import { join } from 'path';
import type { LoadedPlugin, SkillDoc } from './plugin-injection.js';

const PLUGINS_DIR = process.env['PLUGINS_DIR'] ?? join(import.meta.dirname, '../../../../plugins');

async function readMarkdownFiles(dir: string): Promise<SkillDoc[]> {
  const { readdir } = await import('fs/promises');
  const files = await readdir(dir).catch(() => [] as string[]);
  return Promise.all(
    files.filter(f => f.endsWith('.md')).map(async f => ({
      name: f,
      content: await readFile(join(dir, f), 'utf-8'),
      pluginId: '',
    })),
  );
}

// Cached registry loaded once at startup — avoids per-session disk reads.
let _registryCache: Awaited<ReturnType<typeof import('../control-plane/plugin-registry.js').loadPluginRegistry>> | null = null;
async function getRegistry() {
  if (!_registryCache) {
    const { loadPluginRegistry } = await import('../control-plane/plugin-registry.js');
    _registryCache = await loadPluginRegistry(PLUGINS_DIR);
  }
  return _registryCache;
}

export async function readPluginsForContext(
  pluginIds: string[],
  pluginActivations: Map<string, string>, // pluginId → activated_at ISO string
): Promise<LoadedPlugin[]> {
  const registry = await getRegistry();
  const knownIds = new Set(registry.plugins.map(p => p.id));
  const results: LoadedPlugin[] = [];

  for (const id of pluginIds) {
    // Skip orphaned plugin IDs gracefully (plugin removed from codebase after DB row created)
    if (!knownIds.has(id)) {
      console.warn(`[plugins] Skipping unknown plugin id at spawn time: ${id}`);
      continue;
    }
    const dir = join(PLUGINS_DIR, id);
    const skills = (await readMarkdownFiles(join(dir, 'skills'))).map(s => ({ ...s, pluginId: id }));
    const agents = (await readMarkdownFiles(join(dir, 'agents'))).map(a => ({ ...a, pluginId: id }));
    const injection = await readFile(join(dir, 'prompt-injection.md'), 'utf-8').catch(() => '');
    results.push({
      id,
      activatedAt: pluginActivations.get(id) ?? new Date(0).toISOString(),
      promptInjection: injection,
      skills,
      agents,
      mcpConfigs: [],
      gates: [],
    });
  }

  return results;
}
