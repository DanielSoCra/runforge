'use server';

import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { loadDashboardRegistry } from '@/lib/plugins/registry';
import Anthropic from '@anthropic-ai/sdk';

const SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

export async function togglePlugin(
  repoId: string,
  pluginId: string,
  active: boolean,
): Promise<{ ok?: true; error?: string }> {
  const supabase = await createClient();
  // Plugin toggle is admin-only (viewers have read-only access)
  try { await requireAdmin(supabase); } catch { return { error: 'Unauthorized' }; }
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
  if (error) {
    console.error('[plugins] togglePlugin upsert failed:', error);
    return { error: 'Failed to update plugin' };
  }
  return { ok: true };
}

export async function enableAllSuggested(
  repoId: string,
): Promise<{ succeeded: string[]; failed: string[]; error?: string }> {
  const supabase = await createClient();
  // Admin-only — same enforcement as togglePlugin
  try { await requireAdmin(supabase); } catch { return { succeeded: [], failed: [], error: 'Unauthorized' }; }

  const { data: suggested, error: selectError } = await supabase
    .from('repo_plugins')
    .select('plugin_id')
    .eq('repo_id', repoId)
    .eq('recommended', true)
    .eq('active', false);
  if (selectError) {
    console.error('[plugins] enableAllSuggested select failed:', selectError);
    return { succeeded: [], failed: [] };
  }

  const allIds = (suggested ?? []).map((r: { plugin_id: string }) => r.plugin_id);
  if (allIds.length === 0) return { succeeded: [], failed: [] };

  // Validate plugin IDs against registry in a single registry load
  const registry = await loadDashboardRegistry();
  const validIds = allIds.filter(id => registry.plugins.find(p => p.id === id));
  const invalidIds = allIds.filter(id => !validIds.includes(id));

  if (validIds.length === 0) return { succeeded: [], failed: invalidIds };

  // Batch upsert — single DB call instead of N calls via togglePlugin
  const now = new Date().toISOString();
  const { error: upsertError } = await supabase.from('repo_plugins').upsert(
    validIds.map(pluginId => ({
      repo_id: repoId,
      plugin_id: pluginId,
      active: true,
      activated_at: now,
    })),
    { onConflict: 'repo_id,plugin_id', ignoreDuplicates: false },
  );

  if (upsertError) {
    console.error('[plugins] enableAllSuggested upsert failed:', upsertError);
    return { succeeded: [], failed: validIds.concat(invalidIds) };
  }

  return { succeeded: validIds, failed: invalidIds };
}

export async function triggerRecommendation(repoId: string, repoOwner: string, repoName: string): Promise<void> {
  const supabase = await createClient();
  // Admin-only — same enforcement as togglePlugin
  try { await requireAdmin(supabase); } catch { return; }

  // Validate before interpolating into LLM prompt
  if (!SAFE_PATTERN.test(repoOwner) || !SAFE_PATTERN.test(repoName)) {
    console.warn('[plugins] triggerRecommendation: invalid repoOwner or repoName — aborting');
    return;
  }

  // Fire-and-forget: returns immediately, writes to DB asynchronously
  void (async () => {
    try {
      const registry = await loadDashboardRegistry();
      const catalog = registry.plugins.map(p => `- ${p.id}: ${p.description} [${p.tags.join(', ')}]`).join('\n');

      // TODO(I5): Use the repo's stored `model-provider` credential from api_keys.encrypted_value
      // once a decryption utility exists. For now falls back to process.env.ANTHROPIC_API_KEY.
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
      const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      let parsed: { recommendations: Array<{ pluginId: string; confidence: string; reason: string }> };
      try {
        parsed = JSON.parse(cleaned) as typeof parsed;
      } catch {
        return;
      }

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
