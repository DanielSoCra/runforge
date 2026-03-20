'use server';

import { createClient } from '@/lib/supabase/server';
import { loadDashboardRegistry } from '@/lib/plugins/registry';
import Anthropic from '@anthropic-ai/sdk';

export async function togglePlugin(
  repoId: string,
  pluginId: string,
  active: boolean,
): Promise<{ ok?: true; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };
  const registry = await loadDashboardRegistry();
  if (!registry.plugins.find(p => p.id === pluginId)) {
    return { error: `Unknown plugin: ${pluginId}` };
  }
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
): Promise<{ succeeded: string[]; failed: string[] }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { succeeded: [], failed: [] };
  const { data: suggested } = await supabase
    .from('repo_plugins')
    .select('plugin_id')
    .eq('repo_id', repoId)
    .eq('recommended', true)
    .eq('active', false);
  const pluginIds = (suggested ?? []).map((r: { plugin_id: string }) => r.plugin_id);
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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
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
