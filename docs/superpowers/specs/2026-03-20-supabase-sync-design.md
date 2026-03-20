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

## Current State

`daemon.ts` already has partial Supabase support. When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, it creates a `RepoManager` that polls Supabase for enabled repos and manages per-repo GitHub polling. When those env vars are absent, it falls back to a legacy single-repo mode using `config.repo` from the local JSON file.

What is still missing:
- Per-repo settings (branches, budget, poll interval, plugins) are read from local JSON, not Supabase.
- No run rows or cost events are written back to Supabase at any point.
- `SUPABASE_SERVICE_ROLE_KEY` in `daemon.ts` does not match the env var name in `.env` (`SUPABASE_SECRET_KEY`), so DB mode silently falls through to legacy mode today.
- `RunState` has no `id` field, so there is no run UUID to use when writing to Supabase.

## Approach

Two focused modules with distinct responsibilities:

- **`SupabaseConfigReader`** — polls Supabase for per-repo config and global settings on a 60-second interval, caches results in memory, and exposes a `getRepoConfig(owner, name)` method that returns per-repo configuration.
- **`SupabaseRunWriter`** — exposes `upsertRun()` and `writeCostEvent()`, called inline at known phase and session boundaries.

A shared `client.ts` module constructs the Supabase service-role client once and exports it to both. The existing Supabase client created inside `daemon.ts` for `RepoManager` will migrate to use this shared client.

## Schema Changes

New migration `006_global_settings_extensions.sql` adds two columns to `global_settings`:

```sql
ALTER TABLE global_settings
  ADD COLUMN daily_budget_limit numeric(10,4),
  ADD COLUMN default_model text NOT NULL DEFAULT 'claude-sonnet-4-6';
```

`daily_budget_limit` is nullable — null means no global daily cap. `default_model` defaults to `claude-sonnet-4-6` so the existing seeded row stays valid without a data migration.

`default_model` maps to a new `defaultModel: string` field in `GlobalConfig` (see Config types below). It replaces the need for `adapter: 'cli' | 'sdk'` in future sessions, but `adapter` stays in `Config` for backward compatibility during this transition.

## Config Types

The existing `Config` type from `config.ts` is a flat, single-repo shape. This work introduces two new types alongside it:

```typescript
// Per-repo configuration read from Supabase
export interface RepoConfig {
  id: string;                   // Supabase UUID
  owner: string;
  name: string;
  branches: { staging: string; production: string };
  budgetLimit: number | null;   // null = use global default
  concurrencyLimit: number;
  pollIntervalMs: number | null;
  apiKeys: {
    sourceControl: string | null;
    modelProvider: string | null;
  };
  activePlugins: string[];
}

// Global settings read from Supabase
export interface GlobalConfig {
  concurrencyLimit: number;
  dailyBudgetLimit: number | null;
  defaultModel: string;
}
```

`SupabaseConfigReader` returns these types. Phase handlers receive `RepoConfig` instead of `Config` for repo-specific fields (branches, budget). Global fields come from `GlobalConfig`.

## SupabaseConfigReader

### Interface

```typescript
class SupabaseConfigReader {
  start(): Promise<void>                          // initial fetch + schedules 60s poll
  stop(): void                                    // clears timer for clean shutdown
  getRepoConfig(owner: string, name: string): RepoConfig | undefined
  getGlobalConfig(): GlobalConfig
  getAllRepoConfigs(): RepoConfig[]
}
```

### Fetch cycle

Each cycle runs these queries:

1. `SELECT * FROM global_settings LIMIT 1` → populates `GlobalConfig`
2. `SELECT * FROM repos WHERE enabled = true AND deleted_at IS NULL` → one `RepoConfig` per row
3. For each enabled repo: call `decrypt_api_key(repo.id, 'source-control')` and `decrypt_api_key(repo.id, 'model-provider')` → populate `apiKeys`. Null return from the RPC means no key configured for that type — not an error.
4. `SELECT repo_id, plugin_id FROM repo_plugins WHERE active = true` → populate `activePlugins` per repo

The fetch issues 2N+2 round trips (where N = number of enabled repos). For typical installs (1–5 repos) this is acceptable at a 60-second interval.

### Cache behaviour

- `start()` performs one synchronous fetch before returning. If Supabase is unreachable at startup, `start()` throws and the daemon does not start.
- On subsequent poll failures, the reader logs a warning and continues serving the last successful cache.
- Each successful poll replaces the cache atomically.

### Env var fix

The daemon currently reads `SUPABASE_URL` (URL) and `SUPABASE_SERVICE_ROLE_KEY` (key). The `.env` file uses `NEXT_PUBLIC_SUPABASE_URL` (URL) and `SUPABASE_SECRET_KEY` (key).

`client.ts` will read:
- URL: `process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL` — supports both daemon-specific and shared env var
- Key: `process.env.SUPABASE_SECRET_KEY` — matches the `.env` file

The `RepoManager` constructor will be updated to accept the shared client rather than creating its own.

## SupabaseRunWriter

### RunRow type

```typescript
interface RunRow {
  id: string;
  repo_id: string | null;
  repo_owner: string;
  repo_name: string;
  issue_number: number;
  issue_title: string;
  pipeline_variant: string;
  current_phase: string | null;
  outcome: 'in-progress' | 'complete' | 'stuck' | 'escalated';
  total_cost: number;
  phases: object[];
  fix_attempts: number;
  report: string | null;
  started_at: string;
  completed_at: string | null;
  active_plugins: string[];
}
```

### Interface

```typescript
class SupabaseRunWriter {
  upsertRun(runId: string, patch: Partial<RunRow>): Promise<void>
  writeCostEvent(runId: string, sessionType: DbSessionType, cost: number): Promise<void>
}

// Maps daemon SessionType → DB session_type enum
type DbSessionType = 'planning' | 'implementation' | 'validation' | 'diagnosis' | 'fix';

function toDbSessionType(type: SessionType): DbSessionType {
  switch (type) {
    case 'coordinator':
    case 'classifier':        return 'planning';
    case 'worker':
    case 'conflict-resolver':
    case 'bug-worker':        return 'implementation';
    case 'reviewer-spec':
    case 'reviewer-quality':
    case 'reviewer-security':
    case 'tester':
    case 'reporter':          return 'validation';
    case 'diagnostician':     return 'diagnosis';
    case 'prompt-optimizer':  return 'planning';
  }
}
```

`DbSessionType` matches the `session_type` DB enum from migration 001. The `SessionType` values from `types.ts` do not match the DB enum directly — `toDbSessionType()` lives in `run-writer.ts` and handles the mapping. `runtime.ts` passes its `SessionType` value; the writer converts it before inserting.

### RunState.id

`RunState` (in `types.ts`) has no `id` field today. Add `id: string` to the interface. In `processWorkRequest()`, generate the UUID before the first upsert:

```typescript
const run: RunState = {
  id: crypto.randomUUID(),   // ← new field
  issueNumber: request.issueNumber,
  // ... rest unchanged
};
```

This UUID becomes the Supabase `runs.id` primary key. The DB column defaults to `gen_random_uuid()`, but by generating client-side we have the ID available for all subsequent upserts and cost writes within the same run.

### Callsites

| Event | File | How |
|---|---|---|
| Run created | `control-plane/daemon.ts` — `processWorkRequest()` | Call `runWriter?.upsertRun(run.id, { repo_id, repo_owner, repo_name, issue_number, issue_title, pipeline_variant, outcome: 'in-progress' })` after `run` is constructed, before `runPipeline()` |
| Phase transition | `control-plane/pipeline.ts` — `runPipeline()` | Pass `runWriter` as new optional param; call `runWriter?.upsertRun(run.id, { current_phase: run.phase, phases: [...] })` after each `stateMgr.saveRunState()` |
| Session cost | `session-runtime/runtime.ts` — after `this.costTracker.recordCost()` at line 174 | Add `runId?: string` and `runWriter?: SupabaseRunWriter` to `spawnSession()` call-time parameters (not the constructor — `SessionRuntime` is a shared instance across runs). Call `runWriter?.writeCostEvent(runId, type, result.value.cost)` after `recordCost()`. Callers in `phases.ts` and `coordinator.ts` pass `run.id` and `runWriter` through to `spawnSession()`. |
| Run complete | `control-plane/daemon.ts` — after `runPipeline()` returns | Call `runWriter?.upsertRun(run.id, { outcome: result.outcome, completed_at: new Date().toISOString(), report: run.report ?? null, total_cost: run.cost, active_plugins: repoConfig.activePlugins })` |

### Injection mechanism

`configReader` and `runWriter` are created inside `startDaemon()`, not in `main.ts`. `main.ts` only calls `startDaemon(configPath)` — its signature does not change.

`runWriter` is passed as an **optional parameter** through the call chain:

```
startDaemon()
  → configReader = new SupabaseConfigReader(client)
  → runWriter = new SupabaseRunWriter(client, configReader)
  → processWorkRequest(..., runWriter?)
      → runPipeline(..., runWriter?)
      → runtime.spawnSession(type, ctx, issueNumber, run.id, runWriter?)  ← call-time params, not constructor
```

Optional everywhere: the daemon operates without `runWriter` if Supabase is unavailable — runs just won't be recorded. All callsites use optional chaining: `runWriter?.upsertRun(...)` and `runWriter?.writeCostEvent(...)`.

### repo_id resolution

Before upserting, the writer resolves `repo_id` from `configReader.getAllRepoConfigs()` by matching `owner/name`. If no match exists, it inserts with `repo_id: null`. Run records are never silently dropped.

### Error behaviour

Write failures log a warning but do not abort the run. The run continues; the Supabase record may be incomplete.

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
packages/daemon/src/types.ts
  → add id: string to RunState interface

packages/daemon/src/config.ts
  → add RepoConfig and GlobalConfig type exports
  → loadConfig() stays for local-only fields: controlPort, gracePeriodMs, validation, diagnosis, warmup

packages/daemon/src/main.ts
  → no signature change; startDaemon() handles all Supabase initialization internally

packages/daemon/src/control-plane/daemon.ts
  → remove inline supabase createClient() call (use shared client from supabase/client.ts)
  → fix env var: SUPABASE_SECRET_KEY instead of SUPABASE_SERVICE_ROLE_KEY
  → create configReader and runWriter inside startDaemon()
  → add run.id = crypto.randomUUID() in processWorkRequest()
  → pass runWriter into processWorkRequest() as optional param
  → call runWriter?.upsertRun() on run create and run complete

packages/daemon/src/control-plane/pipeline.ts
  → add optional runWriter param to runPipeline() signature
  → call runWriter?.upsertRun() after each stateMgr.saveRunState()

packages/daemon/src/session-runtime/runtime.ts
  → add optional runId: string and runWriter params to spawnSession() (NOT constructor — SessionRuntime is shared)
  → call runWriter?.writeCostEvent(runId, type, cost) after costTracker.recordCost() inside spawnSession()

packages/daemon/src/control-plane/phases.ts
  → accept RepoConfig alongside Config; use repoConfig.branches instead of config.branches
```

**Unchanged:** FSM tables, implementation coordinator, validation, diagnosis, dashboard, plugins, work-detection.

## Data Flow

```
daemon startup
  → configReader.start()
      → fetch global_settings, repos, api_keys per repo, repo_plugins
      → populate cache
      → schedule 60s poll
  → runWriter = new SupabaseRunWriter(supabaseClient)

daemon loop
  → configReader.getRepoConfig(owner, name) → RepoConfig (from cache)
  → claim issue
  → runWriter.upsertRun(id, { ...initial fields })
  → runPipeline(run, table, handlers, stateMgr, costTracker, runWriter)
      → each phase transition → runWriter.upsertRun(id, { current_phase, phases })
      → each session complete → runWriter.writeCostEvent(id, type, cost)
  → runWriter.upsertRun(id, { outcome, completed_at, report, total_cost, active_plugins })

every 60s
  → configReader poll cycle → replace cache (or log warning on failure)
```

## Out of Scope

- Supabase Realtime subscriptions
- Dashboard UI changes (depend on this work but are a separate gap)
- FSM phase implementation
- Plugin recommendation or export flows
- Traceability.yml reconciliation (separate task)
