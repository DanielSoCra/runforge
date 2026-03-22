'use server';

import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { loadDashboardRegistry } from '@/lib/plugins/registry';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, readdir, mkdir, writeFile, stat, realpath } from 'fs/promises';
import { join, resolve } from 'path';

// SAFE_PATTERN prevents prompt injection by blocking shell metacharacters, spaces, and control
// characters. It is not a strict GitHub identifier validator — use for LLM prompt safety only.
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

  // Independent per-plugin upserts — no transaction wrapping the batch.
  // Partial failures are collected; successful activations are not rolled back.
  // Each plugin gets a distinct activated_at (1ms apart) so that activation order
  // is deterministic — the L2 spec uses "earliest first" for merge conflict resolution.
  const baseMs = Date.now();
  const succeeded: string[] = [];
  const failed: string[] = [...invalidIds];

  for (let i = 0; i < validIds.length; i++) {
    const pluginId = validIds[i];
    const { error: upsertError } = await supabase.from('repo_plugins').upsert(
      {
        repo_id: repoId,
        plugin_id: pluginId,
        active: true,
        activated_at: new Date(baseMs + i).toISOString(),
      },
      { onConflict: 'repo_id,plugin_id', ignoreDuplicates: false },
    );
    if (upsertError) {
      console.error(`[plugins] enableAllSuggested upsert failed for ${pluginId}:`, upsertError);
      failed.push(pluginId);
    } else {
      succeeded.push(pluginId);
    }
  }

  return { succeeded, failed };
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

function getPluginsDir(): string {
  return process.env['PLUGINS_DIR'] ?? join(process.cwd(), '../..', 'plugins');
}

export async function exportPlugin(
  repoId: string,
  pluginId: string,
  targetRepoPath: string,
): Promise<{ ok?: true; error?: string }> {
  const supabase = await createClient();
  try { await requireAdmin(supabase); } catch { return { error: 'Unauthorized' }; }

  // Validate pluginId against SAFE_PATTERN before using in filesystem paths
  if (!SAFE_PATTERN.test(pluginId)) {
    return { error: 'Invalid plugin identifier' };
  }

  const registry = await loadDashboardRegistry();
  if (!registry.plugins.find(p => p.id === pluginId)) {
    return { error: `Unknown plugin: ${pluginId}` };
  }

  // Validate targetRepoPath: must be absolute, exist as a directory, and fall within
  // the EXPORT_ALLOWED_DIRS allowlist. Fail closed if no allowlist is configured.
  if (!targetRepoPath.startsWith('/')) {
    return { error: 'Target path must be absolute' };
  }

  const resolved = resolve(targetRepoPath);
  const targetStat = await stat(resolved).catch(() => null);
  if (!targetStat || !targetStat.isDirectory()) {
    return { error: 'Target path does not exist or is not a directory' };
  }

  // Resolve symlinks to prevent symlink-based escapes
  const realTarget = await realpath(resolved);

  // Allowlist check: EXPORT_ALLOWED_DIRS is a colon-separated list of allowed base dirs.
  // If not configured, fail closed — no exports are permitted.
  const allowedDirsRaw = process.env['EXPORT_ALLOWED_DIRS'];
  if (!allowedDirsRaw) {
    return { error: 'Export not configured: EXPORT_ALLOWED_DIRS is not set' };
  }
  const allowedDirs = allowedDirsRaw.split(':').filter(Boolean);
  // Resolve allowlist entries too (handles symlinks like /tmp → /private/tmp on macOS)
  const resolvedAllowedDirs = await Promise.all(
    allowedDirs.map(dir => realpath(dir).catch(() => dir)),
  );
  const withinAllowed = resolvedAllowedDirs.some(dir => {
    const normalizedDir = dir.endsWith('/') ? dir : dir + '/';
    return realTarget === dir || realTarget.startsWith(normalizedDir);
  });
  if (!withinAllowed) {
    return { error: 'Target path is outside allowed directories' };
  }

  const pluginsDir = getPluginsDir();
  const skillsDir = join(pluginsDir, pluginId, 'skills');
  // Use realTarget (symlink-resolved) so the write path matches the validated path
  const destDir = join(realTarget, '.claude', 'plugins', pluginId, 'skills');

  const files = await readdir(skillsDir).catch(() => [] as string[]);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  if (mdFiles.length === 0) {
    return { error: 'No skill documents found for this plugin' };
  }

  try {
    await mkdir(destDir, { recursive: true });

    for (const f of mdFiles) {
      const srcPath = join(skillsDir, f);
      const fileStat = await stat(srcPath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) continue;
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(join(destDir, f), content, 'utf-8');
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[plugins] exportPlugin failed for repo ${repoId}, plugin ${pluginId}:`, message);
    return { error: `Failed to export plugin: ${message}` };
  }

  console.log(`[plugins] Exported plugin ${pluginId} to ${destDir} for repo ${repoId}`);
  return { ok: true };
}
