import { readFile } from 'fs/promises';
import { join } from 'path';

export interface DashboardPlugin {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface DashboardRegistry {
  version: number;
  plugins: DashboardPlugin[];
}

const PLUGINS_DIR = process.env['PLUGINS_DIR'] ?? join(process.cwd(), '../..', 'plugins');

export async function loadDashboardRegistry(): Promise<DashboardRegistry> {
  const raw = await readFile(join(PLUGINS_DIR, 'registry.json'), 'utf-8');
  return JSON.parse(raw) as DashboardRegistry;
}
