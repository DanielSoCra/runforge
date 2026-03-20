import type { SupabaseClient } from '@supabase/supabase-js';

export type CheckpointMode = 'auto' | 'checkpoint';

export interface AgencyCheckpoints {
  intelligence: CheckpointMode;
  brand: CheckpointMode;
  design: CheckpointMode;
  seo: CheckpointMode;
  content: CheckpointMode;
  assets: CheckpointMode;
  build: CheckpointMode;
  qa: CheckpointMode;
  launch: CheckpointMode;
}

export interface AgencyConfig {
  client: string;
  language: string;
  stack: 'astro' | 'native';
  deploy_target: 'github-pages' | 'hetzner';
  source_url: string | null;
  start_from: string | null;
  features: string[];
  checkpoints: AgencyCheckpoints;
}

const DEFAULTS: AgencyConfig = {
  client: '',
  language: 'de',
  stack: 'astro',
  deploy_target: 'github-pages',
  source_url: null,
  start_from: null,
  features: [],
  checkpoints: {
    intelligence: 'checkpoint',
    brand: 'checkpoint',
    design: 'checkpoint',
    seo: 'auto',
    content: 'checkpoint',
    assets: 'auto',
    build: 'auto',
    qa: 'auto',
    launch: 'checkpoint',
  },
};

export function mergeAgencyConfig(
  base: AgencyConfig,
  overrides: Partial<AgencyConfig> & { checkpoints?: Partial<AgencyCheckpoints> },
): AgencyConfig {
  return {
    ...base,
    ...overrides,
    checkpoints: {
      ...base.checkpoints,
      ...(overrides.checkpoints ?? {}),
    },
  };
}

export async function readAgencyConfig(
  supabase: SupabaseClient | null,
  repoId: string,
): Promise<AgencyConfig> {
  if (!supabase) return { ...DEFAULTS };

  // Read global plugin defaults
  const { data: globalData } = await supabase
    .from('plugin_global_settings')
    .select('settings')
    .eq('plugin_id', 'agency')
    .single();

  // Read per-repo overrides
  const { data: repoData } = await supabase
    .from('repo_plugins')
    .select('config')
    .eq('repo_id', repoId)
    .eq('plugin_id', 'agency')
    .single();

  const globalSettings = (globalData?.settings as Partial<AgencyConfig> | null) ?? {};
  const repoConfig = (repoData?.config as Partial<AgencyConfig> | null) ?? {};

  // Normalize global settings keys (database uses default_stack etc.)
  // Only include keys that are actually present to avoid overriding defaults with undefined
  const normalizedGlobal: Partial<AgencyConfig> = {};
  const gs = globalSettings as any;
  if (gs?.default_stack != null) normalizedGlobal.stack = gs.default_stack;
  if (gs?.default_language != null) normalizedGlobal.language = gs.default_language;
  if (gs?.deploy_target != null) normalizedGlobal.deploy_target = gs.deploy_target;
  if (gs?.checkpoints != null) normalizedGlobal.checkpoints = gs.checkpoints;

  const withGlobal = mergeAgencyConfig(DEFAULTS, normalizedGlobal);
  return mergeAgencyConfig(withGlobal, repoConfig);
}
