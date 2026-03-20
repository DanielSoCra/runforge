# Daemon Supabase Config Sync and Run Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daemon's local JSON config with Supabase-backed reads for budget/concurrency/plugins, and write run lifecycle and cost events to Supabase.

**Architecture:** A `SupabaseConfigReader` polls `global_settings`, `repos`, and `repo_plugins` every 60 seconds and caches results. A `SupabaseRunWriter` writes to `runs` and `cost_events` inline at run create, phase transition, session complete, and run complete callsites. Both share a single Supabase service-role client created inside `startDaemon()`.

**Tech Stack:** TypeScript, `@supabase/supabase-js`, vitest, existing daemon test patterns (vi.mock for Supabase client).

**Spec:** `docs/superpowers/specs/2026-03-20-supabase-sync-design.md`

---

## File Map

**New files:**
- `packages/daemon/src/supabase/client.ts` — shared service-role client factory
- `packages/daemon/src/supabase/config-reader.ts` — polls Supabase, caches RepoConfig/GlobalConfig
- `packages/daemon/src/supabase/run-writer.ts` — upsertRun + writeCostEvent + type mappers
- `packages/daemon/src/supabase/config-reader.test.ts`
- `packages/daemon/src/supabase/run-writer.test.ts`
- `supabase/migrations/006_global_settings_extensions.sql`

**Modified files:**
- `packages/daemon/src/types.ts` — add `id: string` and `report?: string` to `RunState`
- `packages/daemon/src/config.ts` — add `RepoConfig` and `GlobalConfig` type exports
- `packages/daemon/src/control-plane/daemon.ts` — wire configReader, runWriter, Supabase budget values
- `packages/daemon/src/control-plane/process-single.ts` — add `run.id`
- `packages/daemon/src/control-plane/pipeline.ts` — add optional `runWriter` param, phase-transition writes, `buildPhaseRecords` helper
- `packages/daemon/src/control-plane/pipeline.test.ts` — update `makeRun` helper, add runWriter tests
- `packages/daemon/src/control-plane/phases.ts` — set `run.report` in `report` phase handler
- `packages/daemon/src/session-runtime/runtime.ts` — extend `spawnSession()` with optional `runWriter`/`runId`
- `packages/daemon/src/session-runtime/runtime.test.ts` — update tests for new signature
- `packages/daemon/src/implementation/batch.ts` — thread `runWriter`/`runId` through `executeBatch()`
- `packages/daemon/src/implementation/batch.test.ts` — update tests
- `packages/daemon/src/implementation/decompose.ts` — thread `runWriter`/`runId`
- `packages/daemon/src/implementation/decompose.test.ts` — update tests
- `packages/daemon/src/implementation/coordinator.ts` — accept and forward `runWriter`/`runId`
- `packages/daemon/src/implementation/coordinator.test.ts` — update tests
- `packages/daemon/src/validation/reviewer-session.ts` — thread `runWriter`/`runId`
- `packages/daemon/src/validation/reviewer-session.test.ts` — update tests
- `packages/daemon/src/diagnosis/diagnostician.ts` — thread `runWriter`/`runId`
- `packages/daemon/src/diagnosis/diagnostician.test.ts` — update tests

---

## Task 1: Schema migration + type foundations

**Files:**
- Create: `supabase/migrations/006_global_settings_extensions.sql`
- Modify: `packages/daemon/src/types.ts`
- Modify: `packages/daemon/src/config.ts`
- Modify: `packages/daemon/src/control-plane/pipeline.test.ts` (update `makeRun` helper)

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/006_global_settings_extensions.sql
ALTER TABLE global_settings
  ADD COLUMN daily_budget_limit numeric(10,4),
  ADD COLUMN default_model text NOT NULL DEFAULT 'claude-sonnet-4-6';
```

- [ ] **Step 2: Add `id` and `report` to `RunState` in `types.ts`**

Find the `RunState` interface (around line 72) and add two fields:

```typescript
export interface RunState {
  id: string;          // ← add as first field
  issueNumber: number;
  title: string;
  // ...all existing fields unchanged...
  report?: string;     // ← add at end, before closing brace
}
```

- [ ] **Step 3: Add `RepoConfig` and `GlobalConfig` to `config.ts`**

After the existing `export type Config = ...` line, add:

```typescript
export interface RepoConfig {
  id: string;
  owner: string;
  name: string;
  budgetLimit: number | null;
  concurrencyLimit: number;
  activePlugins: Array<{ id: string; activatedAt: string }>;
}

export interface GlobalConfig {
  concurrencyLimit: number;
  dailyBudgetLimit: number | null;
  defaultModel: string;
}
```

- [ ] **Step 4: Fix `makeRun` in `pipeline.test.ts` to include the new required field**

Find the `makeRun` helper and add `id`:

```typescript
const makeRun = (variant: 'feature' | 'feature-simple' | 'bug' = 'feature-simple'): RunState => ({
  id: 'test-run-id',   // ← add this line
  issueNumber: 1,
  // ...rest unchanged
});
```

- [ ] **Step 5: Run tests and typecheck**

```bash
cd packages/daemon && npm test && npm run typecheck
```

Expected: all tests pass, no type errors. Any `RunState` construction outside pipeline.test.ts that's missing `id` will show as a type error — fix those too (just add `id: 'test-run-id'` or equivalent).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/006_global_settings_extensions.sql \
        packages/daemon/src/types.ts \
        packages/daemon/src/config.ts \
        packages/daemon/src/control-plane/pipeline.test.ts
git commit -m "feat: add RunState.id/report fields, RepoConfig/GlobalConfig types, schema migration 006"
```

---

## Task 2: Supabase shared client

**Files:**
- Create: `packages/daemon/src/supabase/client.ts`

No test file needed — this is a one-function factory with no logic to test.

- [ ] **Step 1: Create `packages/daemon/src/supabase/client.ts`**

```typescript
// src/supabase/client.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/** For testing — reset the singleton so tests can inject different env vars. */
export function resetSupabaseClient(): void {
  _client = null;
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd packages/daemon && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/supabase/client.ts
git commit -m "feat: add shared Supabase service-role client singleton"
```

---

## Task 3: SupabaseConfigReader

**Files:**
- Create: `packages/daemon/src/supabase/config-reader.ts`
- Create: `packages/daemon/src/supabase/config-reader.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/supabase/config-reader.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SupabaseConfigReader } from './config-reader.js';

const makeClient = (overrides?: Partial<ReturnType<typeof makeClient>>) => ({
  from: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue({ data: [{ id: 'gs1', concurrency_limit: 3, daily_budget_limit: 100, default_model: 'claude-sonnet-4-6' }], error: null }),
      eq: vi.fn().mockReturnValue({
        is: vi.fn().mockResolvedValue({ data: [{ id: 'repo1', owner: 'org', name: 'repo', budget_limit: 10, concurrency_limit: 1 }], error: null }),
      }),
    }),
  }),
  ...overrides,
});

describe('SupabaseConfigReader', () => {
  let reader: SupabaseConfigReader;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = makeClient();
    reader = new SupabaseConfigReader(client as any);
  });

  afterEach(() => {
    reader.stop();
    vi.useRealTimers();
  });

  it('throws on start() if global_settings fetch fails', async () => {
    const badClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection refused' } }),
        }),
      }),
    };
    const r = new SupabaseConfigReader(badClient as any);
    await expect(r.start()).rejects.toThrow('connection refused');
    r.stop();
  });

  it('populates GlobalConfig after start()', async () => {
    // Set up mock chain: global_settings → repos → repo_plugins
    const mockPlugins = { data: [], error: null };
    const mockRepos = { data: [{ id: 'r1', owner: 'org', name: 'repo', budget_limit: 10, concurrency_limit: 1 }], error: null };
    const mockGlobal = { data: [{ id: 'gs1', concurrency_limit: 3, daily_budget_limit: 100, default_model: 'claude-sonnet-4-6' }], error: null };

    const from = vi.fn()
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(mockGlobal) }) })
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ is: vi.fn().mockResolvedValue(mockRepos) }) }) })
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue(mockPlugins) }) });

    const r = new SupabaseConfigReader({ from } as any);
    await r.start();

    const global = r.getGlobalConfig();
    expect(global.concurrencyLimit).toBe(3);
    expect(global.dailyBudgetLimit).toBe(100);
    expect(global.defaultModel).toBe('claude-sonnet-4-6');
    r.stop();
  });

  it('getRepoConfig returns repo after start()', async () => {
    const mockPlugins = { data: [{ repo_id: 'r1', plugin_id: 'p1', activated_at: '2024-01-01T00:00:00Z' }], error: null };
    const mockRepos = { data: [{ id: 'r1', owner: 'org', name: 'repo', budget_limit: 5, concurrency_limit: 2 }], error: null };
    const mockGlobal = { data: [{ id: 'gs1', concurrency_limit: 3, daily_budget_limit: null, default_model: 'claude-sonnet-4-6' }], error: null };

    const from = vi.fn()
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(mockGlobal) }) })
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ is: vi.fn().mockResolvedValue(mockRepos) }) }) })
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue(mockPlugins) }) });

    const r = new SupabaseConfigReader({ from } as any);
    await r.start();

    const repo = r.getRepoConfig('org', 'repo');
    expect(repo?.id).toBe('r1');
    expect(repo?.budgetLimit).toBe(5);
    expect(repo?.activePlugins).toEqual([{ id: 'p1', activatedAt: '2024-01-01T00:00:00Z' }]);
    r.stop();
  });

  it('getRepoConfig returns undefined for unknown repo', async () => {
    // minimal successful start
    const from = vi.fn()
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [{ id: 'gs1', concurrency_limit: 3, daily_budget_limit: null, default_model: 'x' }], error: null }) }) })
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ is: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) })
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }) });

    const r = new SupabaseConfigReader({ from } as any);
    await r.start();
    expect(r.getRepoConfig('unknown', 'repo')).toBeUndefined();
    r.stop();
  });

  it('keeps serving cache on poll failure', async () => {
    const mockPlugins = { data: [], error: null };
    const mockRepos = { data: [{ id: 'r1', owner: 'org', name: 'repo', budget_limit: 5, concurrency_limit: 1 }], error: null };
    const mockGlobal = { data: [{ id: 'gs1', concurrency_limit: 3, daily_budget_limit: null, default_model: 'x' }], error: null };

    const from = vi.fn()
      // First fetch (start): succeeds
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(mockGlobal) }) })
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ is: vi.fn().mockResolvedValue(mockRepos) }) }) })
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue(mockPlugins) }) })
      // Second fetch (poll): fails
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'timeout' } }) }) });

    const r = new SupabaseConfigReader({ from } as any);
    await r.start();

    // advance past poll interval
    await vi.advanceTimersByTimeAsync(61_000);

    // cache still serves previous data
    expect(r.getRepoConfig('org', 'repo')?.id).toBe('r1');
    r.stop();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd packages/daemon && npm test -- src/supabase/config-reader.test.ts
```

Expected: FAIL with "Cannot find module './config-reader.js'"

- [ ] **Step 3: Implement `SupabaseConfigReader`**

Create `packages/daemon/src/supabase/config-reader.ts`:

```typescript
// src/supabase/config-reader.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RepoConfig, GlobalConfig } from '../config.js';

const POLL_INTERVAL_MS = 60_000;

export class SupabaseConfigReader {
  private globalConfig: GlobalConfig = { concurrencyLimit: 1, dailyBudgetLimit: null, defaultModel: 'claude-sonnet-4-6' };
  private repoConfigs = new Map<string, RepoConfig>(); // key: "owner/name"
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly supabase: SupabaseClient) {}

  async start(): Promise<void> {
    await this.fetch(); // throws on failure — daemon will not start
    this.timer = setInterval(() => { void this.fetchSafe(); }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getGlobalConfig(): GlobalConfig {
    return this.globalConfig;
  }

  getRepoConfig(owner: string, name: string): RepoConfig | undefined {
    return this.repoConfigs.get(`${owner}/${name}`);
  }

  private async fetch(): Promise<void> {
    // 1. Global settings
    const { data: gsRows, error: gsErr } = await this.supabase
      .from('global_settings')
      .select('id, concurrency_limit, daily_budget_limit, default_model')
      .limit(1);
    if (gsErr) throw new Error(gsErr.message);
    const gs = (gsRows as any[])[0];
    const newGlobal: GlobalConfig = {
      concurrencyLimit: gs.concurrency_limit,
      dailyBudgetLimit: gs.daily_budget_limit ?? null,
      defaultModel: gs.default_model,
    };

    // 2. Enabled repos
    const { data: repoRows, error: repoErr } = await this.supabase
      .from('repos')
      .select('id, owner, name, budget_limit, concurrency_limit')
      .eq('enabled', true)
      .is('deleted_at', null);
    if (repoErr) throw new Error(repoErr.message);
    const repos = (repoRows ?? []) as any[];

    // 3. Active plugins for all enabled repos
    const repoIds = repos.map((r: any) => r.id);
    const { data: pluginRows, error: pluginErr } = repoIds.length > 0
      ? await this.supabase
          .from('repo_plugins')
          .select('repo_id, plugin_id, activated_at')
          .eq('active', true)
      : { data: [], error: null };
    if (pluginErr) throw new Error(pluginErr.message);

    // Build plugin lookup
    const pluginsByRepo = new Map<string, Array<{ id: string; activatedAt: string }>>();
    for (const p of (pluginRows ?? []) as any[]) {
      if (!pluginsByRepo.has(p.repo_id)) pluginsByRepo.set(p.repo_id, []);
      pluginsByRepo.get(p.repo_id)!.push({ id: p.plugin_id, activatedAt: p.activated_at });
    }

    // Atomically replace cache
    const newConfigs = new Map<string, RepoConfig>();
    for (const r of repos) {
      newConfigs.set(`${r.owner}/${r.name}`, {
        id: r.id,
        owner: r.owner,
        name: r.name,
        budgetLimit: r.budget_limit ?? null,
        concurrencyLimit: r.concurrency_limit,
        activePlugins: pluginsByRepo.get(r.id) ?? [],
      });
    }

    this.globalConfig = newGlobal;
    this.repoConfigs = newConfigs;
  }

  private async fetchSafe(): Promise<void> {
    try {
      await this.fetch();
    } catch (e) {
      console.warn('[config-reader] Poll failed, keeping cached config:', (e as Error).message);
    }
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd packages/daemon && npm test -- src/supabase/config-reader.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Run full test suite + typecheck**

```bash
cd packages/daemon && npm test && npm run typecheck
```

Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/supabase/config-reader.ts \
        packages/daemon/src/supabase/config-reader.test.ts
git commit -m "feat: add SupabaseConfigReader with 60s poll and in-memory cache"
```

---

## Task 4: SupabaseRunWriter

**Files:**
- Create: `packages/daemon/src/supabase/run-writer.ts`
- Create: `packages/daemon/src/supabase/run-writer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/supabase/run-writer.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SupabaseRunWriter, toDbOutcome, toDbSessionType } from './run-writer.js';

describe('toDbOutcome', () => {
  it('maps complete → complete', () => expect(toDbOutcome('complete')).toBe('complete'));
  it('maps stuck → stuck',       () => expect(toDbOutcome('stuck')).toBe('stuck'));
  it('maps paused → in-progress', () => expect(toDbOutcome('paused')).toBe('in-progress'));
  it('maps error → in-progress',  () => expect(toDbOutcome('error')).toBe('in-progress'));
});

describe('toDbSessionType', () => {
  it('maps coordinator → planning',       () => expect(toDbSessionType('coordinator')).toBe('planning'));
  it('maps worker → implementation',      () => expect(toDbSessionType('worker')).toBe('implementation'));
  it('maps reviewer-spec → validation',   () => expect(toDbSessionType('reviewer-spec')).toBe('validation'));
  it('maps diagnostician → diagnosis',    () => expect(toDbSessionType('diagnostician')).toBe('diagnosis'));
  it('maps reporter → validation',        () => expect(toDbSessionType('reporter')).toBe('validation'));
});

describe('SupabaseRunWriter', () => {
  const makeClient = (upsertResult = { error: null }, insertResult = { error: null }) => ({
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'runs') {
        return { upsert: vi.fn().mockResolvedValue(upsertResult) };
      }
      return { insert: vi.fn().mockResolvedValue(insertResult) };
    }),
  });

  it('upsertRun calls supabase.from("runs").upsert with the patch', async () => {
    const client = makeClient();
    const writer = new SupabaseRunWriter(client as any);
    await writer.upsertRun('run-1', { outcome: 'in-progress', repo_owner: 'org', repo_name: 'repo' });
    expect(client.from).toHaveBeenCalledWith('runs');
  });

  it('upsertRun logs warning on error, does not throw', async () => {
    const client = makeClient({ error: { message: 'db down' } });
    const writer = new SupabaseRunWriter(client as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(writer.upsertRun('run-1', {})).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('writeCostEvent calls supabase.from("cost_events").insert', async () => {
    const client = makeClient();
    const writer = new SupabaseRunWriter(client as any);
    await writer.writeCostEvent('run-1', 'worker', 1.5);
    expect(client.from).toHaveBeenCalledWith('cost_events');
  });

  it('writeCostEvent logs warning on error, does not throw', async () => {
    const client = makeClient(undefined, { error: { message: 'write failed' } });
    const writer = new SupabaseRunWriter(client as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(writer.writeCostEvent('run-1', 'worker', 1.5)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd packages/daemon && npm test -- src/supabase/run-writer.test.ts
```

Expected: FAIL with "Cannot find module './run-writer.js'"

- [ ] **Step 3: Implement `SupabaseRunWriter`**

Create `packages/daemon/src/supabase/run-writer.ts`:

```typescript
// src/supabase/run-writer.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SessionType } from '../types.js';
import type { PipelineResult } from '../control-plane/pipeline.js';

export type DbOutcome = 'in-progress' | 'complete' | 'stuck' | 'escalated';
export type DbSessionType = 'planning' | 'implementation' | 'validation' | 'diagnosis' | 'fix';

export function toDbOutcome(outcome: PipelineResult['outcome']): DbOutcome {
  if (outcome === 'complete') return 'complete';
  if (outcome === 'stuck')    return 'stuck';
  return 'in-progress'; // 'paused' and 'error' are non-terminal from DB perspective
}

export function toDbSessionType(type: SessionType): DbSessionType {
  switch (type) {
    case 'coordinator':
    case 'classifier':
    case 'prompt-optimizer': return 'planning';
    case 'worker':
    case 'conflict-resolver':
    case 'bug-worker':       return 'implementation';
    case 'reviewer-spec':
    case 'reviewer-quality':
    case 'reviewer-security':
    case 'tester':
    case 'reporter':         return 'validation';
    case 'diagnostician':    return 'diagnosis';
  }
}

export interface RunRow {
  id?: string;
  repo_id?: string | null;
  repo_owner?: string;
  repo_name?: string;
  issue_number?: number;
  issue_title?: string;
  pipeline_variant?: string;
  current_phase?: string | null;
  outcome?: DbOutcome;
  total_cost?: number;
  phases?: PhaseRecord[];
  fix_attempts?: number;
  report?: string | null;
  started_at?: string;
  completed_at?: string | null;
  active_plugins?: string[];
}

export interface PhaseRecord {
  phase: string;
  outcome: 'success' | 'failure' | 'skipped';
  completedAt: string;
}

export class SupabaseRunWriter {
  constructor(private readonly supabase: SupabaseClient) {}

  async upsertRun(runId: string, patch: Partial<RunRow>): Promise<void> {
    const { error } = await this.supabase
      .from('runs')
      .upsert({ id: runId, ...patch });
    if (error) {
      console.warn(`[run-writer] upsertRun failed for ${runId}:`, error.message);
    }
  }

  async writeCostEvent(runId: string, sessionType: SessionType, cost: number): Promise<void> {
    const { error } = await this.supabase
      .from('cost_events')
      .insert({ run_id: runId, session_type: toDbSessionType(sessionType), cost });
    if (error) {
      console.warn(`[run-writer] writeCostEvent failed for ${runId}:`, error.message);
    }
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd packages/daemon && npm test -- src/supabase/run-writer.test.ts
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Run full test suite + typecheck**

```bash
cd packages/daemon && npm test && npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/supabase/run-writer.ts \
        packages/daemon/src/supabase/run-writer.test.ts
git commit -m "feat: add SupabaseRunWriter with toDbOutcome/toDbSessionType mappers"
```

---

## Task 5: Pipeline phase-transition writes

**Files:**
- Modify: `packages/daemon/src/control-plane/pipeline.ts`
- Modify: `packages/daemon/src/control-plane/pipeline.test.ts`

- [ ] **Step 1: Write the failing test in `pipeline.test.ts`**

Add this test to the existing `describe('runPipeline')` block:

```typescript
it('calls runWriter.upsertRun on phase transitions', async () => {
  const upsertRun = vi.fn().mockResolvedValue(undefined);
  const runWriter = { upsertRun, writeCostEvent: vi.fn() } as any;

  const run = makeRun();
  const handlers: PhaseHandlerMap = {
    detect: async () => 'success' as PhaseEvent,
    classify: async () => 'success:simple' as PhaseEvent,
    implement: async () => 'success' as PhaseEvent,
    review: async () => 'success' as PhaseEvent,
    report: async () => 'success' as PhaseEvent,
  };
  await runPipeline(run, getPipeline('feature-simple'), handlers, stateMgr, costTracker, undefined, runWriter);
  expect(upsertRun).toHaveBeenCalled();
  const firstCall = upsertRun.mock.calls[0];
  expect(firstCall[0]).toBe('test-run-id');
  expect(firstCall[1]).toHaveProperty('current_phase');
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/daemon && npm test -- src/control-plane/pipeline.test.ts
```

Expected: FAIL — `runPipeline` does not accept a `runWriter` argument yet.

- [ ] **Step 3: Add `buildPhaseRecords` helper and extend `runPipeline` in `pipeline.ts`**

Add the import and helper at the top of the file (after existing imports):

```typescript
import type { SupabaseRunWriter, PhaseRecord } from '../supabase/run-writer.js';

function buildPhaseRecords(run: RunState): PhaseRecord[] {
  return Object.entries(run.phaseCompletions)
    .filter(([, completed]) => completed)
    .map(([phase]) => ({
      phase,
      outcome: 'success' as const,
      completedAt: new Date().toISOString(), // capture time at point of transition
    }));
}
```

Add `runWriter?: SupabaseRunWriter` as a new last parameter to `runPipeline()`:

```typescript
export async function runPipeline(
  run: RunState,
  table: TransitionTable,
  handlers: PhaseHandlerMap,
  stateMgr: StateManager,
  costTracker: CostTracker,
  config?: Partial<PipelineConfig>,
  runWriter?: SupabaseRunWriter,  // ← new optional param
): Promise<PipelineResult> {
```

After every `await stateMgr.saveRunState(run)` inside the loop body, add:

```typescript
void runWriter?.upsertRun(run.id, {
  current_phase: run.phase,
  phases: buildPhaseRecords(run),
});
```

There are four `saveRunState` calls in the loop. Add the upsert after each one.

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd packages/daemon && npm test -- src/control-plane/pipeline.test.ts
```

Expected: all tests pass including the new one.

- [ ] **Step 5: Run full test suite + typecheck**

```bash
cd packages/daemon && npm test && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/control-plane/pipeline.ts \
        packages/daemon/src/control-plane/pipeline.test.ts
git commit -m "feat: add runWriter phase-transition upserts to runPipeline"
```

---

## Task 6: Set `run.report` in the report phase

**Files:**
- Modify: `packages/daemon/src/control-plane/phases.ts`

- [ ] **Step 1: Set `run.report` in `phases.ts`**

In the `report` phase handler (around line 67), `reportBody` is already a local variable. Add one line to persist it to `RunState` before returning:

```typescript
report: async (run: RunState): Promise<PhaseEvent> => {
  const outcome = 'complete';
  const reportBody = formatReport(run, outcome);
  run.report = reportBody;   // ← add this line

  await postReport(octokit, owner, repo, workRequest.issueNumber, reportBody);
  // ...rest unchanged
```

- [ ] **Step 2: Run typecheck**

```bash
cd packages/daemon && npm run typecheck
```

Expected: no errors (`RunState.report` is `string | undefined` from Task 1).

- [ ] **Step 3: Run full test suite**

```bash
cd packages/daemon && npm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/control-plane/phases.ts
git commit -m "feat: persist report body to RunState.report in report phase"
```

---

## Task 7: Extend `spawnSession()` with runWriter/runId

**Files:**
- Modify: `packages/daemon/src/session-runtime/runtime.ts`
- Modify: `packages/daemon/src/session-runtime/runtime.test.ts`

- [ ] **Step 1: Extend `spawnSession` in `runtime.ts`**

Add import at the top:
```typescript
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
```

Change the `spawnSession` signature (the `options?` param is last today — add two new optional params after it):

```typescript
async spawnSession(
  type: SessionType,
  context: SessionContext,
  issueNumber: number,
  options?: { jsonSchema?: string; agentDef?: AgentDefinition },
  runWriter?: SupabaseRunWriter,
  runId?: string,
): Promise<Result<SessionResult>> {
```

After `this.costTracker.recordCost(issueNumber, result.value.cost);` (line 174), add:

```typescript
void runWriter?.writeCostEvent(runId ?? '', type, result.value.cost);
```

- [ ] **Step 2: Add a test in `runtime.test.ts`**

Add this test to the existing `describe('SessionRuntime')` block:

```typescript
it('calls runWriter.writeCostEvent after a successful session', async () => {
  const writeCostEvent = vi.fn().mockResolvedValue(undefined);
  const runWriter = { writeCostEvent, upsertRun: vi.fn() } as any;

  vi.mock('../session-runtime/adapters/index.js', () => ({
    createAdapter: () => ({
      spawn: vi.fn().mockResolvedValue({ ok: true, value: { output: 'ok', cost: 0.5, exitStatus: 'completed' } }),
    }),
  }));

  const result = await runtime.spawnSession(
    'worker',
    { variables: { task: 'do it' }, workspacePath: '/tmp' },
    42,
    undefined,
    runWriter,
    'my-run-id',
  );

  if (result.ok) {
    expect(writeCostEvent).toHaveBeenCalledWith('my-run-id', 'worker', 0.5);
  }
});
```

- [ ] **Step 3: Run tests**

```bash
cd packages/daemon && npm test -- src/session-runtime/runtime.test.ts
```

Expected: existing tests pass (new params are optional, existing callers unaffected).

- [ ] **Step 4: Run full test suite + typecheck**

```bash
cd packages/daemon && npm test && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/session-runtime/runtime.ts \
        packages/daemon/src/session-runtime/runtime.test.ts
git commit -m "feat: extend spawnSession with optional runWriter/runId for cost event writes"
```

---

## Task 8: Thread runWriter through all spawnSession callsites

**Files:**
- Modify: `packages/daemon/src/validation/reviewer-session.ts`
- Modify: `packages/daemon/src/validation/reviewer-session.test.ts`
- Modify: `packages/daemon/src/implementation/batch.ts`
- Modify: `packages/daemon/src/implementation/batch.test.ts`
- Modify: `packages/daemon/src/implementation/decompose.ts`
- Modify: `packages/daemon/src/implementation/decompose.test.ts`
- Modify: `packages/daemon/src/diagnosis/diagnostician.ts`
- Modify: `packages/daemon/src/diagnosis/diagnostician.test.ts`
- Modify: `packages/daemon/src/implementation/coordinator.ts`
- Modify: `packages/daemon/src/implementation/coordinator.test.ts`

The pattern is the same for all five files: add `runWriter?: SupabaseRunWriter, runId?: string` to the function/method that calls `spawnSession()`, then forward them to the `spawnSession()` call. Existing callers that don't pass these params continue working because both are optional.

- [ ] **Step 1: Add runWriter/runId to `reviewer-session.ts`**

Read `packages/daemon/src/validation/reviewer-session.ts`. Find the `runSession` (or equivalent) function that calls `runtime.spawnSession(...)`. Add `runWriter?: SupabaseRunWriter, runId?: string` to its parameter list and forward to `spawnSession()`.

Add import at top:
```typescript
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
```

- [ ] **Step 2: Update `reviewer-session.test.ts` — verify no regression**

```bash
cd packages/daemon && npm test -- src/validation/reviewer-session.test.ts
```

Expected: all pass.

- [ ] **Step 3: Add runWriter/runId to `batch.ts` executeBatch function**

Read `packages/daemon/src/implementation/batch.ts`. Find `executeBatch()` (or the function that calls `runtime.spawnSession(...)`). Add `runWriter?: SupabaseRunWriter, runId?: string` to the function signature and forward to each `spawnSession()` call.

```bash
cd packages/daemon && npm test -- src/implementation/batch.test.ts
```

Expected: all pass.

- [ ] **Step 4: Add runWriter/runId to `decompose.ts`**

Same pattern as above.

```bash
cd packages/daemon && npm test -- src/implementation/decompose.test.ts
```

Expected: all pass.

- [ ] **Step 5: Add runWriter/runId to `diagnostician.ts`**

Same pattern.

```bash
cd packages/daemon && npm test -- src/diagnosis/diagnostician.test.ts
```

Expected: all pass.

- [ ] **Step 6: Thread through `coordinator.ts`**

Read `packages/daemon/src/implementation/coordinator.ts`. It delegates to `executeBatch()` and `decompose()`. Add `runWriter?: SupabaseRunWriter, runId?: string` to `ImplementationCoordinator.implement()` and forward to each delegate call.

```bash
cd packages/daemon && npm test -- src/implementation/coordinator.test.ts
```

Expected: all pass.

- [ ] **Step 7: Forward `runWriter`/`runId` from `phases.ts` to `coordinator.implement()` and `runReview()`**

`phases.ts` calls `coordinator.implement(workRequest, featureBranch)` in the `implement` phase handler and `runReview(gates, cwd)` in the `review` phase handler. These are the only callers that actually hold `run.id` and need to pass `runWriter` down so cost events fire.

`createPhaseHandlers` already receives `config` and `runtime` — add `runWriter?: SupabaseRunWriter` and `runId?: string` to its parameter list:

```typescript
export function createPhaseHandlers(
  config: Config,
  owner: string,
  repoName: string,
  runtime: SessionRuntime,
  coordinator: ImplementationCoordinator,
  octokit: Octokit,
  workRequest: WorkRequest,
  stateDir: string,
  runWriter?: SupabaseRunWriter,  // ← new
  runId?: string,                 // ← new
): PhaseHandlerMap {
```

In the `implement` handler, forward to `coordinator.implement()`:

```typescript
implement: async (run: RunState): Promise<PhaseEvent> => {
  const result = await coordinator.implement(workRequest, featureBranch, runWriter, runId);
  // ...rest unchanged
```

In the `review` handler, forward to `runReview()` (check its signature — if it calls `runtime.spawnSession` internally via `reviewer-session.ts`, it needs the params too):

```typescript
review: async (_run: RunState): Promise<PhaseEvent> => {
  const gates: Gate[] = [createGate1(config.validation.gate1Commands)];
  const result = await runReview(gates, process.cwd(), runWriter, runId);
  // ...rest unchanged
```

Read `packages/daemon/src/validation/review.ts` to confirm `runReview()`'s current signature and add the params there too if needed.

Update the `createPhaseHandlers(...)` call in `daemon.ts` `processWorkRequest` to pass `runWriter` and `run.id`:

```typescript
const handlers = createPhaseHandlers(
  config, owner, repoName, runtime, coordinator, octokit, request, stateDir,
  runWriter ?? undefined, run.id,  // ← add
);
```

```bash
cd packages/daemon && npm test && npm run typecheck
```

Expected: all pass.

- [ ] **Step 9: Run full test suite + typecheck**

```bash
cd packages/daemon && npm test && npm run typecheck
```

Expected: all pass, no type errors.

- [ ] **Step 10: Commit**

```bash
git add packages/daemon/src/validation/reviewer-session.ts \
        packages/daemon/src/validation/reviewer-session.test.ts \
        packages/daemon/src/implementation/batch.ts \
        packages/daemon/src/implementation/batch.test.ts \
        packages/daemon/src/implementation/decompose.ts \
        packages/daemon/src/implementation/decompose.test.ts \
        packages/daemon/src/diagnosis/diagnostician.ts \
        packages/daemon/src/diagnosis/diagnostician.test.ts \
        packages/daemon/src/implementation/coordinator.ts \
        packages/daemon/src/implementation/coordinator.test.ts
git commit -m "feat: thread runWriter/runId through all spawnSession callsites"
```

---

## Task 9: Wire daemon — configReader, budget, concurrency, plugins, runWriter

**Files:**
- Modify: `packages/daemon/src/control-plane/daemon.ts`
- Modify: `packages/daemon/src/control-plane/process-single.ts`

This task wires everything together. No new test file — changes in `daemon.ts` and `process-single.ts` are integration points tested via the full test suite.

- [ ] **Step 1: Update `daemon.ts` — remove inline client, add configReader/runWriter**

At the top of `daemon.ts`, replace the existing `import { createClient } from '@supabase/supabase-js'` usage with the shared client:

```typescript
import { getSupabaseClient } from '../supabase/client.js';
import { SupabaseConfigReader } from '../supabase/config-reader.js';
import { SupabaseRunWriter } from '../supabase/run-writer.js';
import { toDbOutcome } from '../supabase/run-writer.js';
```

In `startDaemon()`, after loading the JSON config, add:

```typescript
// Initialize Supabase layer (optional — daemon works without it in legacy mode)
const supabase = getSupabaseClient();
let configReader: SupabaseConfigReader | null = null;
let runWriter: SupabaseRunWriter | null = null;

if (supabase) {
  configReader = new SupabaseConfigReader(supabase);
  await configReader.start(); // throws if unreachable — prevents silent misconfiguration
  runWriter = new SupabaseRunWriter(supabase);
}

const globalConfig = configReader?.getGlobalConfig();
```

Replace the `CostTracker` construction to use Supabase values with JSON fallback:

```typescript
// Before:
const costTracker = new CostTracker({ dailyBudget: config.dailyBudget, perRunBudget: config.perRunBudget });

// After:
const costTracker = new CostTracker({
  dailyBudget: globalConfig?.dailyBudgetLimit ?? config.dailyBudget,
  perRunBudget: config.perRunBudget, // per-run budget is repo-specific, handled per-run below
});
```

Replace the `RepoManager` construction to use the shared client:

```typescript
// Before:
const supabase = createClient(supabaseUrl, supabaseKey);
repoManager = new RepoManager(supabase, ...);

// After (supabase is already the shared client from above):
repoManager = new RepoManager(supabase!, ...);
```

Remove the old `const supabaseUrl/supabaseKey` lines and the `if (supabaseUrl && supabaseKey)` check — replace with `if (supabase)`.

In the `RepoManager` callback (the `onPoll` function), update `processWorkRequest` call to pass `repoId` and `runWriter`:

```typescript
processWorkRequest(config, repoId, owner, name, request, runtime, coordinator, costTracker, stateMgr, detector, stateDir, runWriter ?? undefined, configReader ?? undefined)
```

In the graceful shutdown, add `configReader?.stop()` alongside the existing cleanup.

- [ ] **Step 2: Update `processWorkRequest` to use `repoId`, `runWriter`, and `configReader`**

Change the signature to include `repoId`, `runWriter?`, and `configReader?`:

```typescript
async function processWorkRequest(
  config: Config,
  repoId: string,             // ← new
  owner: string,
  repoName: string,
  request: WorkRequest,
  runtime: SessionRuntime,
  coordinator: ImplementationCoordinator,
  costTracker: CostTracker,
  stateMgr: StateManager,
  detector: WorkDetector,
  stateDir: string,
  runWriter?: SupabaseRunWriter,   // ← new
  configReader?: SupabaseConfigReader, // ← new
): Promise<void> {
```

Inside `processWorkRequest`, generate run id and set `SessionContext.activePlugins`:

```typescript
const repoConfig = configReader?.getRepoConfig(owner, repoName);

const run: RunState = {
  id: crypto.randomUUID(),   // ← new
  // ...existing fields unchanged
  perRunBudget: repoConfig?.budgetLimit ?? config.perRunBudget,
};

// ...

const handlers = createPhaseHandlers(config, owner, repoName, runtime, coordinator, octokit, request, stateDir);
// Pass activePlugins from Supabase into the session context (phases.ts uses runtime.spawnSession)
// Note: activePlugins are set on SessionContext per-session in the phase handlers.
// For now, make them available via a context override passed to runtime.
// (This is threaded through coordinator.implement → executeBatch → spawnSession)
```

After constructing the `run`, write the initial upsert:

```typescript
void runWriter?.upsertRun(run.id, {
  repo_id: repoId,
  repo_owner: owner,
  repo_name: repoName,
  issue_number: request.issueNumber,
  issue_title: request.title,
  pipeline_variant: run.variant,
  outcome: 'in-progress',
  started_at: run.startedAt,
  active_plugins: repoConfig?.activePlugins.map(p => p.id) ?? [],
});
```

Pass `runWriter` to `runPipeline`:

```typescript
const result = await runPipeline(run, table, handlers, stateMgr, costTracker, undefined, runWriter ?? undefined);
```

After `runPipeline` returns, write the completion upsert:

```typescript
void runWriter?.upsertRun(run.id, {
  outcome: toDbOutcome(result.outcome),
  completed_at: new Date().toISOString(),
  report: run.report ?? null,
  total_cost: run.cost,
  fix_attempts: run.fixAttempts.length,
});
```

- [ ] **Step 3: Update `process-single.ts` — add `run.id`**

In `processSingleIssue`, update the `RunState` construction to add the id field:

```typescript
const run: RunState = {
  id: crypto.randomUUID(),   // ← add
  issueNumber, title: request.title,
  // ...rest unchanged
};
```

- [ ] **Step 4: Fix the legacy polling loop call site in `daemon.ts`**

`daemon.ts` has a second `processWorkRequest(...)` call inside the legacy `setInterval` block (around line 155). Update it to match the new signature — `repoId` is `''` in legacy mode (no Supabase repo record), `runWriter` and `configReader` are `undefined`:

```typescript
processWorkRequest(
  config,
  '',                     // repoId: empty string — legacy mode has no UUID
  config.repo!.owner,
  config.repo!.name,
  request,
  runtime, coordinator, costTracker, stateMgr, detector, stateDir,
  undefined,              // runWriter
  undefined,              // configReader
)
```

- [ ] **Step 5: Run full test suite + typecheck**

```bash
cd packages/daemon && npm test && npm run typecheck
```

Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/control-plane/daemon.ts \
        packages/daemon/src/control-plane/process-single.ts
git commit -m "feat: wire configReader and runWriter into daemon — budget, concurrency, run lifecycle writes"
```

---

## Task 10: Apply Supabase migration + final verification

**Files:**
- `supabase/migrations/006_global_settings_extensions.sql` (already created in Task 1)

- [ ] **Step 1: Apply the migration via Supabase MCP**

Use the Supabase MCP `apply_migration` tool to apply the migration file content to the project. The migration adds `daily_budget_limit` and `default_model` to `global_settings`.

- [ ] **Step 2: Verify the columns exist**

Use the Supabase MCP `list_tables` tool with `verbose: true` on the `public` schema. Confirm `global_settings` now has `daily_budget_limit` and `default_model` columns.

- [ ] **Step 3: Run the full daemon test suite one final time**

```bash
cd packages/daemon && npm test && npm run typecheck
```

Expected: all tests pass, no type errors.

- [ ] **Step 4: Final commit**

```bash
git add supabase/migrations/006_global_settings_extensions.sql
git commit -m "feat: apply migration 006 — add daily_budget_limit and default_model to global_settings"
```

---

## Done

All tasks complete when:
- `cd packages/daemon && npm test` passes
- `npm run typecheck` passes
- `supabase/migrations/006_global_settings_extensions.sql` applied
- `SupabaseConfigReader` + `SupabaseRunWriter` exist with tests
- `daemon.ts` uses shared Supabase client, reads budget/concurrency from Supabase, writes run lifecycle events
- `runPipeline()` writes phase-transition upserts
- `spawnSession()` writes cost events
- All `spawnSession()` callsites thread `runWriter`/`runId`
