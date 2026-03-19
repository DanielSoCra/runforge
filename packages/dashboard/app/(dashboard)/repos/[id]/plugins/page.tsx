import { createClient } from '@/lib/supabase/server';
import { loadDashboardRegistry } from '@/lib/plugins/registry';
import { PluginCard } from '@/components/plugin-card';
import { enableAllSuggested, triggerRecommendation } from '@/actions/plugins';
import { Button } from '@/components/ui/button';
import { RealtimeRefresh } from './realtime-refresh';

type Confidence = 'high' | 'medium' | 'low';

function extractConfidence(reason: string | null | undefined): Confidence | null {
  if (!reason) return null;
  const match = reason.match(/^\[(high|medium|low)\]/);
  return match ? (match[1] as Confidence) : null;
}

export default async function PluginsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const [{ data: repo }, { data: repoPlugins }, registry] = await Promise.all([
    supabase.from('repos').select('id, owner, name').eq('id', id).single(),
    supabase.from('repo_plugins').select('*').eq('repo_id', id),
    loadDashboardRegistry(),
  ]);

  if (!repo) return <p>Repository not found.</p>;

  const activeMap = new Map((repoPlugins ?? []).map(rp => [rp.plugin_id, rp]));
  const suggested = registry.plugins.filter(p => {
    const rp = activeMap.get(p.id);
    return rp?.recommended && !rp?.active;
  });
  const active = registry.plugins.filter(p => activeMap.get(p.id)?.active);
  const rest = registry.plugins.filter(p => !activeMap.get(p.id)?.active && !activeMap.get(p.id)?.recommended);

  const suggestedIds = suggested.map(p => p.id);

  return (
    <div className="space-y-8">
      <RealtimeRefresh repoId={id} />
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Plugins</h2>
        <form action={async () => {
          'use server';
          await triggerRecommendation(id, repo.owner, repo.name);
        }}>
          <Button variant="outline" size="sm" type="submit">Re-analyze repo</Button>
        </form>
      </div>

      {suggested.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs uppercase tracking-wider text-zinc-500">Suggested</h3>
            <form action={async () => {
              'use server';
              await enableAllSuggested(id, suggestedIds);
            }}>
              <Button variant="ghost" size="sm" type="submit">Enable All</Button>
            </form>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {suggested.map(p => {
              const rp = activeMap.get(p.id);
              return <PluginCard key={p.id} repoId={id} pluginId={p.id} name={p.name}
                description={p.description} tags={p.tags} active={false}
                recommended recommendationReason={rp?.recommendation_reason}
                confidence={extractConfidence(rp?.recommendation_reason ?? null)} />;
            })}
          </div>
        </section>
      )}

      {active.length > 0 && (
        <section>
          <h3 className="mb-3 text-xs uppercase tracking-wider text-zinc-500">Active</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {active.map(p => (
              <PluginCard key={p.id} repoId={id} pluginId={p.id} name={p.name}
                description={p.description} tags={p.tags} active />
            ))}
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section>
          <h3 className="mb-3 text-xs uppercase tracking-wider text-zinc-500">All Plugins</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {rest.map(p => (
              <PluginCard key={p.id} repoId={id} pluginId={p.id} name={p.name}
                description={p.description} tags={p.tags} active={false} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
