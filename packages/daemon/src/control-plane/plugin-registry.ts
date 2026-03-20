import { readFile, access } from 'fs/promises';
import { join } from 'path';

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  dir: string; // absolute path to plugin directory
}

export interface PluginRegistry {
  version: number;
  plugins: PluginEntry[];
}

const REQUIRED_MANIFEST_FIELDS = ['id', 'name', 'version', 'description'] as const;

export async function loadPluginRegistry(pluginsDir: string): Promise<PluginRegistry> {
  const registryPath = join(pluginsDir, 'registry.json');
  const raw = await readFile(registryPath, 'utf-8').catch(() => {
    throw new Error(`Plugin registry not found at ${registryPath}`);
  });
  let json: { version: number; plugins: Array<{ id: string; name: string; tags: string[] }> };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new Error(`Plugin registry at ${registryPath} is not valid JSON`);
  }

  const plugins: PluginEntry[] = [];
  for (const entry of json.plugins) {
    const dir = join(pluginsDir, entry.id);
    await access(dir).catch(() => {
      throw new Error(`Plugin directory not found: ${dir}`);
    });
    const manifestPath = join(dir, 'manifest.json');
    const manifestRaw = await readFile(manifestPath, 'utf-8');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    } catch {
      throw new Error(`Plugin ${entry.id}: manifest.json is not valid JSON`);
    }
    for (const field of REQUIRED_MANIFEST_FIELDS) {
      if (!manifest[field])
        throw new Error(`Plugin ${entry.id}: manifest missing required fields (${field})`);
    }
    plugins.push({
      id: entry.id,
      name: manifest['name'] as string,
      description: manifest['description'] as string,
      tags: entry.tags ?? [],
      dir,
    });
  }

  return { version: json.version, plugins };
}
