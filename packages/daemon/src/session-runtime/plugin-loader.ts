import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { LoadedPlugin, McpConfig, SkillDoc } from './plugin-injection.js';
import type { PluginRegistry } from '../control-plane/plugin-registry.js';

const MAX_FILE_BYTES = 100_000;    // 100KB per markdown skill/agent file
const MAX_INJECTION_BYTES = 20_000; // 20KB per prompt-injection.md

// Read env at call time so tests can override process.env['PLUGINS_DIR'] after module load
function getPluginsDir(): string {
  return process.env['PLUGINS_DIR'] ?? join(import.meta.dirname, '../../../../plugins');
}

async function readMarkdownFiles(dir: string): Promise<SkillDoc[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const results: SkillDoc[] = [];
  for (const f of files.filter(f => f.endsWith('.md'))) {
    const filePath = join(dir, f);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || fileStat.size > MAX_FILE_BYTES) {
      if (!fileStat) {
        console.warn(`[plugins] Skipping unreadable file: ${filePath} (stat failed)`);
      } else {
        console.warn(
          `[plugins] Skipping oversized file: ${filePath} (${fileStat.size} bytes > ${MAX_FILE_BYTES} limit)`,
        );
      }
      continue;
    }
    results.push({
      name: f,
      content: await readFile(filePath, 'utf-8'),
      pluginId: '',
    });
  }
  return results;
}

async function readMcpConfigs(dir: string): Promise<McpConfig[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const results: McpConfig[] = [];
  for (const f of files.filter(f => f.endsWith('.json'))) {
    const filePath = join(dir, f);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>)['name'] !== 'string' ||
        typeof (parsed as Record<string, unknown>)['command'] !== 'string' ||
        !Array.isArray((parsed as Record<string, unknown>)['args'])
      ) {
        console.warn(`[plugins] Skipping MCP config with missing required fields: ${filePath}`);
        continue;
      }
      results.push(parsed as McpConfig);
    } catch {
      console.warn(`[plugins] Skipping malformed MCP config JSON: ${filePath}`);
    }
  }
  return results;
}

// Cached registry loaded once at startup — avoids per-session disk reads.
// The Promise itself is cached so concurrent callers await the same operation
// rather than each triggering a separate load. If loading fails, the cache is
// cleared so the next caller can retry.
let _registryCachePromise: Promise<PluginRegistry> | null = null;
function getRegistry(): Promise<PluginRegistry> {
  if (!_registryCachePromise) {
    _registryCachePromise = import('../control-plane/plugin-registry.js')
      .then(({ loadPluginRegistry }) => loadPluginRegistry(getPluginsDir()))
      .catch((err: unknown) => {
        _registryCachePromise = null;
        throw err;
      });
  }
  return _registryCachePromise;
}

/** For testing only — clears the cached registry Promise so the next call reloads from disk. */
export function clearRegistryCache(): void {
  _registryCachePromise = null;
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
    const dir = join(getPluginsDir(), id);
    const skills = (await readMarkdownFiles(join(dir, 'skills'))).map(s => ({ ...s, pluginId: id }));
    const agents = (await readMarkdownFiles(join(dir, 'agents'))).map(a => ({ ...a, pluginId: id }));
    const injectionRaw = await readFile(join(dir, 'prompt-injection.md'), 'utf-8').catch(() => '');
    const injection = injectionRaw.length > MAX_INJECTION_BYTES
      ? (() => {
          console.warn(`[plugins] prompt-injection.md for ${id} truncated (${injectionRaw.length} chars > ${MAX_INJECTION_BYTES} limit)`);
          return injectionRaw.slice(0, MAX_INJECTION_BYTES);
        })()
      : injectionRaw;
    results.push({
      id,
      activatedAt: pluginActivations.get(id) ?? new Date(0).toISOString(),
      promptInjection: injection,
      skills,
      agents,
      mcpConfigs: await readMcpConfigs(join(dir, 'mcps')),
      gates: [],
    });
  }

  return results;
}
