---
status: superseded
superseded_by: .specify/L0-ac-vision.md  # unified L0-AC-VISION v5 + its L1 children; Postgres data-platform cutover (STACK-AC-DATA-PLATFORM)
superseded_date: 2026-06-11
deprecated_by: STACK-AC-DATA-PLATFORM
deprecation_reason: "Superseded by the app-owned Postgres data platform cutover from issue #626."
---

# Design: Daemon Supabase Config Sync and Run Writes

> **⛔ SUPERSEDED (2026-06-11).** Already deprecated by **STACK-AC-DATA-PLATFORM** (Postgres cutover, #626); the canonical specs now live in the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children in `.specify/` (per the Spec Reconciliation Ledger, `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). Retained for history — do not act on this doc. <!-- RECONCILIATION-LEDGER-BANNER -->

Date: 2026-03-20

## Problem

The daemon loads configuration from a local JSON file and never writes execution data back to Supabase. This breaks the end-to-end architecture in three ways:

- The dashboard has no run history, cost data, or active-plugin transparency to display.
- Each daemon instance requires manual config file management instead of reading from the shared database.
- Plugin state in the daemon is disconnected from the plugin toggles users set in the dashboard.

## Goal

Replace local JSON config with Supabase-backed config reads for the fields Supabase owns. Wire run and cost writes into the daemon pipeline at the points where execution state changes.

## Scope

This design covers one gap area from the 2026-03-20 spec-implementation gap analysis: the missing daemon ↔ Supabase data layer. It does not address FSM phase implementation, bug triage, learning pipelines, dashboard UI gaps, or changing the session adapter/model selection mechanism.

## Current State

`daemon.ts` already has partial Supabase support. When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, it creates a `RepoManager` that:

- Polls Supabase for enabled repos every 60 seconds
- Reads `poll_interval_ms` per repo from the `repos` table
- Resolves GitHub tokens via `repos.connection_id` + `decrypt_github_token()` RPC

What is still missing:

- Per-repo budget and concurrency limits come from local JSON (`perRunBudget`, `maxConcurrentRuns`), not Supabase.
- No run rows or cost events are written back to Supabase at any point.
- `SUPABASE_SERVICE_ROLE_KEY` in `daemon.ts` works — but the `.env` uses the same name, so this is consistent. No rename needed.
- `RunState` has no `id` field, so there is no run UUID to use when writing to the `runs` table.
- `SessionContext.activePlugins` expects `Array<{ id, activatedAt }>`, but the daemon currently populates it with an empty array rather than reading from Supabase.

## Approach

Two focused modules with distinct responsibilities:

- **`SupabaseConfigReader`** — polls Supabase every 60 seconds for per-repo budget, concurrency, and plugin state. Caches results in memory. Exposes `getRepoConfig(owner, name)` and `getGlobalConfig()`.
- **`SupabaseRunWriter`** — exposes `upsertRun()` and `writeCostEvent()`, called inline at phase and session boundaries.

A shared `client.ts` constructs the Supabase service-role client once. The existing client created inside `daemon.ts` for `RepoManager` migrates to use this shared client.

## Schema Changes

New migration `006_global_settings_extensions.sql`:

```sql
ALTER TABLE global_settings
  ADD COLUMN daily_budget_limit numeric(10,4),
  ADD COLUMN default_model text NOT NULL DEFAULT 'claude-sonnet-4-6';
```

`daily_budget_limit` is nullable — null means no global daily cap. `default_model` is stored for future use (model selection is out of scope for this spec). Both additions are safe for the existing seeded row.

## Config Types

Two new types exported from `config.ts` alongside the existing `Config`:

```typescript
// Per-repo fields read from Supabase
export interface RepoConfig {
  id: string;                  // Supabase UUID — used directly as repo_id on run writes
  owner: string;
  name: string;
  budgetLimit: number | null;  // per-run budget; null = use Config.perRunBudget from JSON
  concurrencyLimit: number;    // max concurrent runs for this repo
  activePlugins: Array<{ id: string; activatedAt: string }>;
}

// Global fields read from Supabase
export interface GlobalConfig {
  concurrencyLimit: number;        // global max concurrent runs
  dailyBudgetLimit: number | null; // null = use Config.dailyBudget from JSON
  defaultModel: string;            // stored for future use
}
```

### How Supabase config values replace JSON config values

| Runtime enforcement point | Current source | New source |
|---|---|---|
| `CostTracker.dailyBudget` | `config.dailyBudget` | `globalConfig.dailyBudgetLimit ?? config.dailyBudget` |
| `CostTracker.perRunBudget` | `config.perRunBudget` | `repoConfig.budgetLimit ?? config.perRunBudget` |
| `activeRuns >= maxConcurrentRuns` check | `config.maxConcurrentRuns` | `globalConfig.concurrencyLimit` |
| `SessionContext.activePlugins` | `[]` (hardcoded) | `repoConfig.activePlugins` |

`Config` (JSON) remains the source for: `controlPort`, `gracePeriodMs`, `webhooks`, `validation`, `diagnosis`, `warmup`, `adapter`, `branches` (fallback when no repo-specific value).

## SupabaseConfigReader

### Interface

```typescript
class SupabaseConfigReader {
  start(): Promise<void>                          // initial fetch + schedules 60s poll
  stop(): void                                    // clears timer for clean shutdown
  getRepoConfig(owner: string, name: string): RepoConfig | undefined
  getGlobalConfig(): GlobalConfig
}
```

### Fetch cycle

Each cycle:

1. `SELECT id, concurrency_limit, daily_budget_limit, default_model FROM global_settings LIMIT 1`
2. `SELECT id, owner, name, budget_limit, concurrency_limit FROM repos WHERE enabled = true AND deleted_at IS NULL`
3. `SELECT repo_id, plugin_id, activated_at FROM repo_plugins WHERE active = true`
   — Join result to repos from step 2; populate `activePlugins: Array<{ id: plugin_id, activatedAt: activated_at }>`

Note: GitHub tokens are **not** fetched here. `RepoManager` already handles GitHub auth via `decrypt_github_token()`. The model-provider API key is also out of scope for this spec.

### Cache behaviour

- `start()` performs one fetch before returning. If Supabase is unreachable, `start()` throws and the daemon does not start.
- On subsequent poll failures: log warning, keep serving last cached values. Daemon continues running.
- Successful poll replaces cache atomically.

## SupabaseRunWriter

### Type definitions

```typescript
// Matches the runs table schema (migrations 001 + 003)
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
  phases: PhaseRecord[];         // see shape below
  fix_attempts: number;
  report: string | null;
  started_at: string;
  completed_at: string | null;
  active_plugins: string[];      // plugin IDs active at run time (from migration 003)
}

// Shape written to runs.phases (jsonb[])
interface PhaseRecord {
  phase: string;
  outcome: 'success' | 'failure' | 'skipped';
  completedAt: string;           // ISO timestamp
}

// Maps PipelineResult.outcome → DB run_outcome enum
// 'paused' → 'in-progress' (run is suspended, not finished)
// 'error'  → 'stuck' (unrecoverable, same as stuck)
type DbOutcome = 'in-progress' | 'complete' | 'stuck' | 'escalated';
function toDbOutcome(o: PipelineResult['outcome']): DbOutcome {
  if (o === 'complete') return 'complete';
  if (o === 'stuck')    return 'stuck';
  return 'in-progress'; // 'paused' and 'error' are non-terminal from the DB's perspective
}

// Maps SessionType → session_type DB enum
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

### Interface

```typescript
class SupabaseRunWriter {
  upsertRun(runId: string, patch: Partial<RunRow>): Promise<void>
  writeCostEvent(runId: string, sessionType: SessionType, cost: number): Promise<void>
}
```

`writeCostEvent` calls `toDbSessionType()` internally before inserting.

### RunState.id

`RunState` (in `types.ts`) has no `id` field today. Add `id: string`. In `processWorkRequest()` and `processSingleIssue()`:

```typescript
const run: RunState = {
  id: crypto.randomUUID(),  // ← new field; used as runs.id primary key
  // ...rest unchanged
};
```

### RunState.report

The `report` phase in `phases.ts` builds the report body as a local variable. Add `report?: string` to `RunState`. In the `report` phase handler, set `run.report = reportBody` before returning. This makes it available for the completion upsert.

### Callsites

| Event | File | Action |
|---|---|---|
| Run created | `daemon.ts` — `processWorkRequest()` | `runWriter.upsertRun(run.id, { repo_id: repoId, repo_owner: owner, repo_name: repoName, issue_number, issue_title, pipeline_variant: 'feature-simple', outcome: 'in-progress' })` — `repoId` is already in scope from the `RepoManager` callback |
| Run created | `process-single.ts` — `processSingleIssue()` | Same upsert; `repo_id: null` (single-issue mode has no Supabase repo record) |
| Phase transition | `pipeline.ts` — `runPipeline()` | After each `stateMgr.saveRunState()`: `runWriter?.upsertRun(run.id, { current_phase: run.phase, phases: buildPhaseRecords(run) })` |
| Session cost | `runtime.ts` — `spawnSession()` after line 174 | `runWriter?.writeCostEvent(runId, type, result.value.cost)` — `runId` and `runWriter` passed as new call-time params |
| Run complete | `daemon.ts` — after `runPipeline()` returns | `runWriter.upsertRun(run.id, { outcome: toDbOutcome(result.outcome), completed_at: new Date().toISOString(), report: run.report ?? null, total_cost: run.cost, active_plugins: repoConfig.activePlugins.map(p => p.id) })` |

### spawnSession() call-time injection

`SessionRuntime` is a **shared instance** across runs — `runId` cannot go in the constructor. Extend the `spawnSession()` signature with an optional extras bag:

```typescript
// Before
async spawnSession(type, context, issueNumber, options?)

// After
async spawnSession(type, context, issueNumber, options?, runWriter?: SupabaseRunWriter, runId?: string)
```

All existing callers pass no `runWriter`/`runId` and remain unchanged. New callers in phase handlers pass both. The cost-recording block at line 174 becomes:

```typescript
this.costTracker.recordCost(issueNumber, result.value.cost);
runWriter?.writeCostEvent(runId ?? '', type, result.value.cost);
```

### Files that call spawnSession() — all need runId/runWriter threading

| File | Current call | Change |
|---|---|---|
| `validation/reviewer-session.ts` | `runtime.spawnSession(...)` | Add `runWriter, runId` to signature and pass through |
| `implementation/batch.ts` | `runtime.spawnSession(...)` | Add `runWriter, runId` to `executeBatch()` params and pass through |
| `implementation/decompose.ts` | `runtime.spawnSession(...)` | Add `runWriter, runId` params and pass through |
| `diagnosis/diagnostician.ts` | `runtime.spawnSession(...)` | Add `runWriter, runId` params and pass through |

`ImplementationCoordinator` delegates to `executeBatch()` and `decompose()` — it receives `runWriter, runId` and threads them down. `phases.ts` calls `coordinator.implement()` and `runReview()` — both receive `runWriter, runId`.

### Error behaviour

Write failures log a warning but never abort the run. The run continues; the Supabase record may be incomplete.

## Injection mechanism

`configReader` and `runWriter` are created inside `startDaemon()`. `main.ts` is unchanged.

```
startDaemon(configPath)
  → load JSON Config (unchanged)
  → create shared Supabase client (from supabase/client.ts)
  → configReader = new SupabaseConfigReader(client)
  → await configReader.start()          ← throws if unreachable; daemon will not start
  → runWriter = new SupabaseRunWriter(client)
  → CostTracker({ dailyBudget: globalConfig.dailyBudgetLimit ?? config.dailyBudget,
                  perRunBudget: repoConfig.budgetLimit ?? config.perRunBudget })
  → concurrency check uses globalConfig.concurrencyLimit

  processWorkRequest(config, owner, name, repoId, request, ..., runWriter)
    → run.id = crypto.randomUUID()
    → runWriter.upsertRun(run.id, { ...initial })
    → runPipeline(run, table, handlers, stateMgr, costTracker, runWriter)
        → phase handlers call spawnSession(..., runWriter, run.id)
        → each phase transition → runWriter.upsertRun(run.id, { current_phase, phases })
    → runWriter.upsertRun(run.id, { outcome, completed_at, report, total_cost, active_plugins })
```

`repoId` is already passed into the `RepoManager` callback as the first argument — no lookup needed.

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
  → add id: string to RunState
  → add report?: string to RunState

packages/daemon/src/config.ts
  → add RepoConfig and GlobalConfig type exports

packages/daemon/src/control-plane/daemon.ts
  → remove inline createClient() (use shared client)
  → create configReader and runWriter inside startDaemon()
  → use globalConfig.concurrencyLimit for the activeRuns guard
  → pass CostTracker daily/per-run budget from Supabase with JSON fallback
  → pass SessionContext.activePlugins from repoConfig
  → add repoId param to processWorkRequest()
  → add run.id = crypto.randomUUID()
  → call runWriter.upsertRun() on run create and complete

packages/daemon/src/control-plane/process-single.ts
  → add run.id = crypto.randomUUID()
  → add RunState.report = undefined
  → pass runWriter (null/absent — single-issue mode skips Supabase writes)

packages/daemon/src/control-plane/pipeline.ts
  → add optional runWriter param to runPipeline()
  → call runWriter?.upsertRun() after each stateMgr.saveRunState()
  → add buildPhaseRecords(run): PhaseRecord[] helper

packages/daemon/src/control-plane/phases.ts
  → set run.report = reportBody in the report phase handler

packages/daemon/src/session-runtime/runtime.ts
  → add optional runWriter and runId params to spawnSession()
  → call runWriter?.writeCostEvent() after costTracker.recordCost()

packages/daemon/src/validation/reviewer-session.ts
  → accept and forward runWriter, runId

packages/daemon/src/implementation/batch.ts
  → accept and forward runWriter, runId through executeBatch()

packages/daemon/src/implementation/decompose.ts
  → accept and forward runWriter, runId

packages/daemon/src/implementation/coordinator.ts
  → accept runWriter, runId; thread to executeBatch() and decompose()

packages/daemon/src/diagnosis/diagnostician.ts
  → accept and forward runWriter, runId
```

**Unchanged:** FSM tables, validation gates, work-detection, repo-manager, dashboard, plugins.

## Data Flow

```
startDaemon()
  → configReader.start() — fetch global_settings, repos, repo_plugins → cache
  → schedule 60s poll

daemon loop (per repo, via RepoManager callback)
  → configReader.getRepoConfig(owner, name) → RepoConfig
  → configReader.getGlobalConfig()          → GlobalConfig
  → concurrency guard: activeRuns < globalConfig.concurrencyLimit
  → claim issue
  → CostTracker with Supabase budget values (JSON fallback)
  → run.id = crypto.randomUUID()
  → SessionContext.activePlugins = repoConfig.activePlugins
  → runWriter.upsertRun(run.id, initial)
  → runPipeline()
      → each phase transition → runWriter?.upsertRun(run.id, { current_phase, phases })
      → each session → spawnSession(..., runWriter, run.id)
                      → runWriter?.writeCostEvent(run.id, type, cost)
  → runWriter.upsertRun(run.id, { outcome, completed_at, report, total_cost, active_plugins })

every 60s
  → configReader poll → replace cache (or log warning on failure)
```

## Out of Scope

- Supabase Realtime subscriptions
- Dashboard UI changes (depend on this work but are a separate gap)
- FSM phase implementation
- Plugin recommendation or export flows
- Model/adapter selection from Supabase (`default_model` stored, not yet wired)
- Traceability.yml reconciliation (separate task)
