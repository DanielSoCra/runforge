'use server';

import { createServerClient } from '@/lib/supabase/server';
import { loadDashboardRegistry } from '@/lib/plugins/registry';
import Anthropic from '@anthropic-ai/sdk';
import { readdir } from 'fs/promises';
import { join } from 'path';

const PLUGINS_DIR = process.env['PLUGINS_DIR'] ?? join(process.cwd(), '../..', 'plugins');

export async function togglePlugin(
  repoId: string,
  pluginId: string,
  active: boolean,
): Promise<{ ok?: true; error?: string }> {
  const registry = await loadDashboardRegistry();
  if (!registry.plugins.find(p => p.id === pluginId)) {
    return { error: `Unknown plugin: ${pluginId}` };
  }
  const supabase = createServerClient();
  // Only update active + activated_at on conflict — never overwrite recommendation fields.
  const { error } = await supabase.from('repo_plugins').upsert(
    {
      repo_id: repoId,
      plugin_id: pluginId,
      active,
      activated_at: active ? new Date().toISOString() : null,
    },
    { onConflict: 'repo_id,plugin_id', ignoreDuplicates: false },
  );
  if (error) return { error: error.message };
  return { ok: true };
}

export async function enableAllSuggested(
  repoId: string,
  pluginIds: string[],
): Promise<{ succeeded: string[]; failed: string[] }> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const pluginId of pluginIds) {
    const result = await togglePlugin(repoId, pluginId, true);
    if (result.ok) succeeded.push(pluginId);
    else failed.push(pluginId);
  }
  return { succeeded, failed };
}

export async function triggerRecommendation(repoId: string, repoOwner: string, repoName: string): Promise<void> {
  // Fire-and-forget: returns immediately, writes to DB asynchronously
  void (async () => {
    try {
      const registry = await loadDashboardRegistry();
      const catalog = registry.plugins.map(p => `- ${p.id}: ${p.description} [${p.tags.join(', ')}]`).join('\n');

      const client = new Anthropic();
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are recommending plugins for a software repository.\n\nRepository: ${repoOwner}/${repoName}\n\nAvailable plugins:\n${catalog}\n\nReturn JSON: { "recommendations": [{ "pluginId": string, "confidence": "high"|"medium"|"low", "reason": string }] }`,
        }],
      });

      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = JSON.parse(text) as { recommendations: Array<{ pluginId: string; confidence: string; reason: string }> };
      const supabase = createServerClient();

      for (const rec of parsed.recommendations) {
        if (!registry.plugins.find(p => p.id === rec.pluginId)) continue;
        await supabase.from('repo_plugins').upsert(
          { repo_id: repoId, plugin_id: rec.pluginId, recommended: true,
            recommendation_reason: `[${rec.confidence}] ${rec.reason}`, recommended_at: new Date().toISOString() },
          { onConflict: 'repo_id,plugin_id' },
        );
      }
    } catch {
      // Fail silently — user can re-trigger via dashboard
    }
  })();
}

export async function exportPlugin(repoId: string, pluginId: string, targetRepoPath: string): Promise<{ ok?: true; error?: string }> {
  const registry = await loadDashboardRegistry();
  if (!registry.plugins.find(p => p.id === pluginId)) {
    return { error: `Unknown plugin: ${pluginId}` };
  }
  const { mkdir, copyFile } = await import('fs/promises');
  const pluginDir = join(PLUGINS_DIR, pluginId, 'skills');
  const destDir = join(targetRepoPath, '.claude', 'plugins', pluginId, 'skills');
  await mkdir(destDir, { recursive: true });
  const files = await readdir(pluginDir).catch(() => [] as string[]);
  for (const f of files) await copyFile(join(pluginDir, f), join(destDir, f));
  return { ok: true };
}
