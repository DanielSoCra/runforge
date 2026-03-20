---
id: STACK-AC-PLUGINS-DASHBOARD
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-PLUGINS
code_paths:
  - supabase/migrations/003_plugins.sql
  - packages/dashboard/actions/plugins.ts
  - packages/dashboard/app/repos/[id]/plugins/page.tsx
  - packages/dashboard/components/plugin-card.tsx
  - packages/dashboard/lib/plugins/registry.ts
test_paths:
  - supabase/tests/rls-plugins.test.ts
  - packages/dashboard/actions/plugins.test.ts
---

# STACK-AC-PLUGINS-DASHBOARD — Plugin Management Dashboard (TypeScript)

## Pattern

**Protected-field upsert.** The `togglePlugin` Server Action uses a Supabase upsert with an explicit conflict target of `(repo_id, plugin_id)`. Only the `active` and `activated_at` fields are updated on conflict — `recommended`, `recommendation_reason`, and `recommended_at` are never overwritten by a toggle. This ensures the recommendation record survives activation changes.

**Fire-and-forget Server Action with Realtime delivery.** The `triggerRecommendation` action dispatches the Model Provider call as a background async task and returns immediately. The dashboard subscribes to the `repo_plugins` Realtime channel; recommendation rows arrive as Realtime inserts, which update the Suggested section without polling. The subscription must be established before the action fires to avoid missing events.

**Registry-validated writes.** Before any write to `repo_plugins`, the Server Action reads the plugin catalog from the filesystem registry (`lib/plugins/registry.ts`) and verifies the supplied `pluginId` exists. Unknown identifiers are rejected with a user-facing error. This prevents orphaned rows from being created through the UI.

## Key Decisions

**Realtime over polling for recommendation delivery.** Model Provider latency is unpredictable (1–10 seconds). Polling would require a fixed interval that is either too slow (poor UX) or too fast (wasteful). Realtime delivers the rows the moment they are written, with no extra requests. The tradeoff: the Realtime subscription must be active on the page before the Server Action fires — this is guaranteed by the page mounting the subscription in a `useEffect` before the button is clickable.

**Best-effort batch for "Enable All Suggested".** Each plugin in the batch is activated via an independent upsert. There is no transaction wrapping the batch. This matches the L2 contract (partial failure returns a list) and avoids a long-held transaction that could block other writes. The UI shows which plugins succeeded and which failed; the admin can retry failed ones individually.

**`003_plugins.sql` as a separate migration.** The `repo_plugins` table and the `active_plugins` column on `runs` land in a separate migration from `001_initial.sql`. This keeps the initial migration stable (it is the basis for the RLS test suite) and makes the plugins feature independently deployable and rollback-safe.

## Examples

Protected-field upsert — only `active` and `activated_at` change on conflict:

```typescript
await supabase.from('repo_plugins').upsert(
  { repo_id: repoId, plugin_id: pluginId, active: true, activated_at: new Date().toISOString() },
  { onConflict: 'repo_id,plugin_id', ignoreDuplicates: false }
);
```

Realtime subscription established before recommendation action is callable:

```typescript
useEffect(() => {
  const channel = supabase.channel('repo_plugins')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'repo_plugins',
        filter: `repo_id=eq.${repoId}` }, () => router.refresh())
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}, [repoId]);
```

Registry validation in Server Action before any DB write:

```typescript
const registry = await loadRegistry(); // reads plugins/registry.json
if (!registry.plugins.find(p => p.id === pluginId)) {
  return { error: `Unknown plugin: ${pluginId}` };
}
```

## Gotchas

**Optimistic UI must revert on Server Action error.** `togglePlugin` fires optimistically in the UI before the Server Action resolves. If the action fails (unknown plugin, DB error), the toggle must revert. Use the Server Action return value to detect failure and reset local state — do not rely on the Realtime event to correct a failed optimistic update, because no event will arrive for a write that never happened.

**"Enable All Suggested" is not atomic.** The batch uses independent upserts. If the user navigates away mid-batch, in-flight requests complete but the UI will not reflect partial results on return. The page re-fetch on mount will show the actual DB state correctly.

**Realtime subscription timing on initial page load.** If the user opens the Plugins page immediately after adding a repo (while the recommendation background task is already running), the subscription may not be established before the first Realtime event fires. Mitigate by also re-fetching `repo_plugins` on page mount — the subscription handles updates, the initial fetch handles already-written rows.
