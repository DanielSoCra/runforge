# Design: Daemon Supabase Config Sync and Run Writes

Date: 2026-03-20

## Problem

The daemon loads configuration from a local JSON file and never writes execution data back to Supabase. This breaks the end-to-end architecture in three ways:

- The dashboard has no run history, cost data, or active-plugin transparency to display.
- Each daemon instance requires manual config file management instead of reading from the shared database.
- Plugin state in the daemon is disconnected from the plugin toggles users set in the dashboard.

## Goal

Replace local JSON config with Supabase-backed config reads. Wire run and cost writes into the daemon pipeline at the points where execution state changes.

## Scope

This design covers one gap area from the 2026-03-20 spec-implementation gap analysis: the missing daemon ↔ Supabase data layer. It does not address FSM phase implementation, bug triage, learning pipelines, or dashboard UI gaps.

## Approach

Two focused modules with distinct responsibilities:

- **`SupabaseConfigReader`** — polls Supabase for config on a 60-second interval, caches results in memory, and exposes a synchronous `getConfig()` method the daemon calls everywhere config was previously read from JSON.
- **`SupabaseRunWriter`** — exposes `upsertRun()` and `writeCostEvent()`, called inline at known phase and session boundaries. No polling. No background process.

A shared `client.ts` module constructs the Supabase service-role client once and exports it to both.

## Schema Changes

New migration `006_global_settings_extensions.sql` adds two columns to `global_settings`:

```sql
ALTER TABLE global_settings
  ADD COLUMN daily_budget_limit numeric(10,4),
  ADD COLUMN default_model text NOT NULL DEFAULT 'claude-sonnet-4-6';
```

`daily_budget_limit` is nullable — null means no global daily cap. `default_model` defaults to `claude-sonnet-4-6` so the existing seeded row stays valid without a data migration.

## SupabaseConfigReader

### Interface

```typescript
class SupabaseConfigReader {
  start(): Promise<void>   // initial fetch + schedules 60s poll
  stop(): void             // clears timer for clean shutdown
  getConfig(): DaemonConfig
}
```

### Fetch cycle

Each cycle reads:

| Source | Fields used |
|---|---|
| `global_settings` | `concurrency_limit`, `daily_budget_limit`, `default_model` |
| `repos` where `enabled = true` and `deleted_at IS NULL` | all per-repo config fields |
| `api_keys` per enabled repo | decrypted via existing Supabase RPC |
| `repo_plugins` per enabled repo where `active = true` | `plugin_id` list |

### Cache behaviour

- `start()` performs one synchronous fetch before returning. If Supabase is unreachable at startup, `start()` throws and the daemon does not start. A daemon with no config cannot safely operate.
- On subsequent poll failures, the reader logs a warning and continues serving the last successful cache. The daemon keeps running.
- Each successful poll replaces the cache atomically.

### What it replaces

- `config.ts` JSON file loading logic
- `DAEMON_CONFIG_PATH` environment variable

The `DaemonConfig` type shape is unchanged. The reader populates the same structure, so nothing else in the daemon requires modification.

## SupabaseRunWriter

### Interface

```typescript
class SupabaseRunWriter {
  upsertRun(runId: string, patch: Partial<RunRow>): Promise<void>
  writeCostEvent(runId: string, sessionType: SessionType, cost: number): Promise<void>
}
```

### Callsites

| Event | File | Patch fields |
|---|---|---|
| Run created | `control-plane/daemon.ts` | `repo_id`, `repo_owner`, `repo_name`, `issue_number`, `issue_title`, `pipeline_variant`, `outcome: 'in-progress'` |
| Phase transition | `control-plane/pipeline.ts` | `current_phase`, `phases` |
| Session cost | `session-runtime/cost.ts` | via `writeCostEvent()` |
| Run complete | `control-plane/phases.ts` | `outcome`, `completed_at`, `report`, `total_cost`, `active_plugins` |

### repo_id resolution

Before upserting, the writer resolves `repo_id` from the config cache by matching `owner/name`. If no match exists, it inserts with `repo_id: null`. Run records are never silently dropped.

### Error behaviour

Write failures log a warning but do not abort the run. A failed cost write is not grounds for stopping execution. The run continues; the Supabase record may be incomplete.

## File List

**New files:**

```
packages/daemon/src/supabase/client.ts
packages/daemon/src/supabase/config-reader.ts
packages/daemon/src/supabase/run-writer.ts
supabase/migrations/006_global_settings_extensions.sql
```

**Modified files:**

```
packages/daemon/src/config.ts                     replace JSON load with configReader.getConfig()
packages/daemon/src/main.ts                       start/stop configReader on daemon lifecycle
packages/daemon/src/control-plane/daemon.ts       inject runWriter on run create and complete
packages/daemon/src/control-plane/pipeline.ts     inject runWriter on phase transitions
packages/daemon/src/control-plane/phases.ts       inject runWriter on final outcome
packages/daemon/src/session-runtime/cost.ts       inject runWriter.writeCostEvent()
```

**Unchanged:** all FSM tables, implementation coordinator, validation, diagnosis, dashboard, plugins.

## Data Flow

```
daemon startup
  → configReader.start()
      → fetch global_settings, repos, api_keys, repo_plugins
      → populate cache
      → schedule 60s poll

daemon loop
  → configReader.getConfig()       (synchronous, from cache)
  → claim issue → runWriter.upsertRun(id, { ...initial fields })
  → runPipeline()
      → each phase → runWriter.upsertRun(id, { current_phase, phases })
      → each session → runWriter.writeCostEvent(id, type, cost)
  → final outcome → runWriter.upsertRun(id, { outcome, completed_at, ... })

every 60s
  → configReader poll cycle
  → fetch from Supabase → replace cache (or log warning on failure)
```

## Out of Scope

- Supabase Realtime subscriptions
- Dashboard UI changes (those depend on this work but are a separate gap)
- FSM phase implementation
- Plugin recommendation or export flows
- Traceability.yml updates (separate reconciliation task)
