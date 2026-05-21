import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { LoadedPlugin, McpConfig, SkillDoc } from './plugin-injection.js';
import type { PluginRegistry } from '../control-plane/plugin-registry.js';

const MAX_FILE_BYTES = 100_000;    // 100KB per markdown skill/agent file
const MAX_INJECTION_BYTES = 20_000; // 20KB per prompt-injection.md

interface PluginContent {
  promptInjection: string;
  skills: SkillDoc[];
  agents: SkillDoc[];
  mcpConfigs: McpConfig[];
  gates: string[];
}

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

async function readGateScripts(dir: string): Promise<string[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const results: string[] = [];
  for (const f of files) {
    const filePath = join(dir, f);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) {
      if (fileStat && fileStat.size > MAX_FILE_BYTES) {
        console.warn(`[plugins] Skipping oversized gate script: ${filePath} (${fileStat.size} bytes > ${MAX_FILE_BYTES} limit)`);
      }
      continue;
    }
    results.push(await readFile(filePath, 'utf-8'));
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

const _pluginContentCache = new Map<string, Promise<PluginContent>>();

function cloneMcpConfig(config: McpConfig): McpConfig {
  const cloned: McpConfig = {
    ...config,
    args: [...config.args],
  };
  if (config.env) cloned.env = { ...config.env };
  return cloned;
}

function clonePluginContent(content: PluginContent): PluginContent {
  return {
    promptInjection: content.promptInjection,
    skills: content.skills.map((skill) => ({ ...skill })),
    agents: content.agents.map((agent) => ({ ...agent })),
    mcpConfigs: content.mcpConfigs.map(cloneMcpConfig),
    gates: [...content.gates],
  };
}

async function loadPluginContent(id: string, dir: string): Promise<PluginContent> {
  const [skillsRaw, agentsRaw, injectionRaw, mcpConfigs, gates] = await Promise.all([
    readMarkdownFiles(join(dir, 'skills')),
    readMarkdownFiles(join(dir, 'agents')),
    readFile(join(dir, 'prompt-injection.md'), 'utf-8').catch(() => ''),
    readMcpConfigs(join(dir, 'mcps')),
    readGateScripts(join(dir, 'gates')),
  ]);
  const injectionByteLen = Buffer.byteLength(injectionRaw, 'utf-8');
  const promptInjection = injectionByteLen > MAX_INJECTION_BYTES
    ? (() => {
        console.warn(`[plugins] prompt-injection.md for ${id} truncated (${injectionByteLen} bytes > ${MAX_INJECTION_BYTES} limit)`);
        const buf = Buffer.from(injectionRaw, 'utf-8');
        // Walk back from cut point to avoid splitting a multi-byte character
        let end = MAX_INJECTION_BYTES;
        while (end > 0 && (buf[end]! & 0xC0) === 0x80) end--;
        return buf.subarray(0, end).toString('utf-8');
      })()
    : injectionRaw;

  return {
    promptInjection,
    skills: skillsRaw.map(s => ({ ...s, pluginId: id })),
    agents: agentsRaw.map(a => ({ ...a, pluginId: id })),
    mcpConfigs,
    gates,
  };
}

async function getPluginContent(id: string): Promise<PluginContent> {
  const dir = join(getPluginsDir(), id);
  let contentPromise = _pluginContentCache.get(dir);
  if (!contentPromise) {
    contentPromise = loadPluginContent(id, dir).catch((err: unknown) => {
      _pluginContentCache.delete(dir);
      throw err;
    });
    _pluginContentCache.set(dir, contentPromise);
  }
  return clonePluginContent(await contentPromise);
}

/** For testing only — clears cached plugin data so the next call reloads from disk. */
export function clearRegistryCache(): void {
  _registryCachePromise = null;
  _pluginContentCache.clear();
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
    const content = await getPluginContent(id);
    results.push({
      id,
      activatedAt: pluginActivations.get(id) ?? new Date(0).toISOString(),
      ...content,
    });
  }

  return results;
}
