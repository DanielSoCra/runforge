import { loadDashboardRegistry } from '@/lib/plugins/registry';
import { PluginCard } from '@/components/plugin-card';
import { enableAllSuggested, triggerRecommendation } from '@/actions/plugins';
import { EnableAllForm } from '@/components/enable-all-form';
import { RealtimeRefresh } from './realtime-refresh';
import { RepoTabNav } from '@/components/repo-tab-nav';
import { isDashboardAdmin } from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';
import { TriggerRecommendationForm } from '@/components/trigger-recommendation-button';
import { PageError } from '@/components/page-error';

type Confidence = 'high' | 'medium' | 'low';

function extractConfidence(reason: string | null | undefined): Confidence | null {
  if (!reason) return null;
  const match = reason.match(/^\[(high|medium|low)\]/);
  return match ? (match[1] as Confidence) : null;
}

export const dynamic = 'force-dynamic';

export default async function PluginsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [pluginState, registry, admin] = await Promise.all([
    getDashboardStores().plugins.readRepositoryPlugins(id),
    loadDashboardRegistry(),
    isDashboardAdmin(),
  ]);

  if (!pluginState.ok && pluginState.error === 'not-found') {
    return <p>Repository not found.</p>;
  }
  if (!pluginState.ok) {
    console.error('[plugins] failed to load repository plugins:', pluginState.message);
    return <PageError />;
  }

  const { plugins: repoPlugins, repo } = pluginState.value;
  const activeMap = new Map(repoPlugins.map(rp => [rp.plugin_id, rp]));
  const suggested = registry.plugins.filter(p => {
    const rp = activeMap.get(p.id);
    return rp?.recommended && !rp?.active;
  });
  const active = registry.plugins.filter(p => activeMap.get(p.id)?.active);
  const rest = registry.plugins.filter(p => !activeMap.get(p.id)?.active && !activeMap.get(p.id)?.recommended);

  return (
    <div className="max-w-2xl space-y-6">
      <RealtimeRefresh repoId={id} />
      <RepoTabNav repoId={id} />
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Plugins</h2>
        {admin && (
          <TriggerRecommendationForm action={async () => {
            'use server';
            await triggerRecommendation(id, repo.owner, repo.name);
          }} />
        )}
      </div>

      {suggested.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs uppercase tracking-wider text-zinc-500">Suggested</h3>
            {admin && (
              <EnableAllForm action={async () => {
                'use server';
                return enableAllSuggested(id);
              }} />
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {suggested.map(p => {
              const rp = activeMap.get(p.id);
              return <PluginCard key={p.id} repoId={id} pluginId={p.id} name={p.name}
                description={p.description} tags={p.tags} active={false}
                recommended recommendationReason={rp?.recommendation_reason}
                confidence={extractConfidence(rp?.recommendation_reason ?? null)}
                readOnly={!admin} />;
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
                description={p.description} tags={p.tags} active readOnly={!admin} />
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
                description={p.description} tags={p.tags} active={false} readOnly={!admin} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
