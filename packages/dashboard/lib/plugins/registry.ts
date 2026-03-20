import { readFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';

const DashboardPluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
});

const DashboardRegistrySchema = z.object({
  version: z.number(),
  plugins: z.array(DashboardPluginSchema),
});

export type DashboardPlugin = z.infer<typeof DashboardPluginSchema>;
export type DashboardRegistry = z.infer<typeof DashboardRegistrySchema>;

const PLUGINS_DIR = process.env['PLUGINS_DIR'] ?? join(process.cwd(), '../..', 'plugins');

export async function loadDashboardRegistry(): Promise<DashboardRegistry> {
  const raw = await readFile(join(PLUGINS_DIR, 'registry.json'), 'utf-8');
  return DashboardRegistrySchema.parse(JSON.parse(raw));
}
