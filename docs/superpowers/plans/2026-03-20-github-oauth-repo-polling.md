# GitHub OAuth Repo Import & Multi-Repo Polling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual repo entry with a GitHub OAuth flow that lets admins connect accounts, import selected orgs/repos, and toggle per-repo polling — with the daemon dynamically reloading its poller set from the database without restart.

**Architecture:** A dedicated GitHub OAuth App (separate from Supabase auth) stores encrypted tokens in a new `github_connections` table. A `RepoManager` class in the daemon replaces the single polling loop, maintaining a live map of per-repo `WorkDetector` instances driven by the `repos` table. The dashboard gains an OAuth initiate/callback flow, a Settings section for managing connections, and an import modal on the repos page.

**Tech Stack:** Supabase PostgreSQL + pgcrypto + RLS, Next.js 16.2 server actions + API routes, Node.js daemon with `@supabase/supabase-js` (already a dependency) + `@octokit/rest`, vitest (daemon v3, dashboard v4).

---

## Risk Notes

Four areas that deserve extra attention during implementation:

**1. `notifyRunEnd` must fire on every code path.**
`RepoManager.notifyRunEnd(repoId)` is the only mechanism that releases a disabled poller after its last run completes. If any error path in `daemon.ts` throws before reaching `.finally()`, the poller hangs indefinitely in `pendingDisable` state and is never removed. In Task 4 Step 5, confirm that `processWorkRequest(...)` is always wrapped in `.finally(() => { activeRuns--; repoManager.notifyRunEnd(repoId); })` — not just `.catch()`.

**2. The import-repos modal has no automated tests.**
`import-repos-modal.tsx` is a client component with complex interactive state (fetch-per-org, multi-level selection). The dashboard doesn't currently use `@testing-library/react`, so no unit tests are written for it. The Verification Checklist at the bottom of this plan includes a manual walkthrough — treat it as required before merge, not optional.

**3. Dual-mode daemon branching must be tested as both paths before merge.**
`daemon.ts` now has a legacy path (no `SUPABASE_URL`) and a DB path. It's easy to break one while fixing the other. Task 4 Step 6 asks to run the full daemon test suite — also manually verify: (a) daemon starts with `SUPABASE_URL` set and no `config.repo`, and (b) daemon starts with `config.repo` set and no `SUPABASE_URL`. Both must work.

**4. GitHub token revocation is silent — no active health check.**
When a GitHub OAuth token is revoked externally, the system learns only on the next API call that returns 401. There is no proactive monitoring. The `token_invalid` status flag and dashboard warning banner are the only signals. This is acceptable for the current scope but creates a silent failure window. A future cron job or periodic ping to `/user` would close this gap — not needed now, but worth noting in the code with a `// TODO: proactive token health check`.

---

## File Map

### Created
| File | Purpose |
|---|---|
| `supabase/migrations/005_github_connections.sql` | New tables, RLS policies, pgcrypto functions |
| `packages/daemon/src/control-plane/repo-manager.ts` | Live poller map, sync, reload |
| `packages/daemon/src/control-plane/repo-manager.test.ts` | Unit tests for RepoManager |
| `packages/dashboard/lib/supabase/service.ts` | Service-role Supabase client for server-only use |
| `packages/dashboard/app/api/auth/github-connection/route.ts` | OAuth initiate (redirect to GitHub) |
| `packages/dashboard/app/api/auth/github-connection/callback/route.ts` | OAuth callback (exchange code, store connection) |
| `packages/dashboard/app/api/daemon/repos-reload/route.ts` | Proxy POST to daemon `/repos/reload` |
| `packages/dashboard/app/api/github/connections/[id]/orgs/route.ts` | List GitHub orgs for a connection |
| `packages/dashboard/app/api/github/connections/[id]/repos/route.ts` | List GitHub repos for an org |
| `packages/dashboard/actions/github-connections.ts` | removeConnection, importRepos server actions |
| `packages/dashboard/components/github-connections-section.tsx` | Settings page section |
| `packages/dashboard/components/import-repos-modal.tsx` | Import modal (client component) |

### Modified
| File | Change |
|---|---|
| `packages/daemon/src/config.ts` | `repo` becomes optional |
| `packages/daemon/src/config.test.ts` | Update test: omitting `repo` now passes |
| `packages/daemon/src/control-plane/server.ts` | Add `POST /repos/reload` and `reloadRepos` handler |
| `packages/daemon/src/control-plane/server.test.ts` | Add test for `/repos/reload` |
| `packages/daemon/src/control-plane/daemon.ts` | Replace single poller with RepoManager |
| `packages/dashboard/actions/repos.ts` | Notify daemon on enable/disable |
| `packages/dashboard/app/(dashboard)/settings/page.tsx` | Add GitHub Connections section |
| `packages/dashboard/app/(dashboard)/repos/page.tsx` | Import button, connection badge, not-found badge |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/005_github_connections.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 005_github_connections.sql
-- Depends on: 001_initial.sql (requires is_admin(), is_member(), vault.decrypted_secrets)

-- ============================================================
-- github_connections: system-level GitHub OAuth tokens
-- ============================================================
CREATE TABLE github_connections (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name     text        NOT NULL,
  github_login     text        NOT NULL,
  avatar_url       text,
  connection_type  text        NOT NULL DEFAULT 'oauth_token',
  encrypted_token  bytea       NOT NULL,
  token_expires_at timestamptz,
  scopes           text,
  status           text        NOT NULL DEFAULT 'active',
  created_by       uuid        NOT NULL REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE github_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read github_connections"
  ON github_connections FOR SELECT USING (is_member());
CREATE POLICY "admins insert github_connections"
  ON github_connections FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "admins update github_connections"
  ON github_connections FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "admins delete github_connections"
  ON github_connections FOR DELETE USING (is_admin());

-- Prevent authenticated users from selecting the raw token column
REVOKE SELECT (encrypted_token) ON github_connections FROM authenticated;

-- ============================================================
-- github_orgs: orgs accessible via a connection
-- ============================================================
CREATE TABLE github_orgs (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid    NOT NULL REFERENCES github_connections(id) ON DELETE CASCADE,
  github_id     bigint  NOT NULL,
  login         text    NOT NULL,
  name          text,
  avatar_url    text,
  is_selected   boolean NOT NULL DEFAULT false,
  UNIQUE (connection_id, github_id)
);

ALTER TABLE github_orgs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read github_orgs"
  ON github_orgs FOR SELECT USING (is_member());
CREATE POLICY "admins insert github_orgs"
  ON github_orgs FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "admins update github_orgs"
  ON github_orgs FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "admins delete github_orgs"
  ON github_orgs FOR DELETE USING (is_admin());

-- ============================================================
-- Extend repos
-- ============================================================
ALTER TABLE repos
  ADD COLUMN connection_id  uuid REFERENCES github_connections(id) ON DELETE SET NULL,
  ADD COLUMN github_status  text NOT NULL DEFAULT 'ok';

-- ============================================================
-- store_github_connection: admin-only, encrypts token in vault
-- ============================================================
CREATE OR REPLACE FUNCTION store_github_connection(
  p_display_name    text,
  p_github_login    text,
  p_avatar_url      text,
  p_connection_type text,
  p_plaintext_token text,
  p_scopes          text,
  p_created_by      uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, extensions, vault AS $$
DECLARE
  v_enc_key text;
  v_id      uuid;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'permission denied'; END IF;
  SELECT decrypted_secret INTO v_enc_key
    FROM vault.decrypted_secrets WHERE name = 'encryption_key' LIMIT 1;
  INSERT INTO github_connections
    (display_name, github_login, avatar_url, connection_type,
     encrypted_token, scopes, status, created_by)
  VALUES
    (p_display_name, p_github_login, p_avatar_url, p_connection_type,
     pgp_sym_encrypt(p_plaintext_token, v_enc_key), p_scopes, 'active', p_created_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION store_github_connection FROM PUBLIC;
GRANT EXECUTE ON FUNCTION store_github_connection TO authenticated;

-- ============================================================
-- decrypt_github_token: service-role only
-- ============================================================
CREATE OR REPLACE FUNCTION decrypt_github_token(p_connection_id uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER
  SET search_path = public, extensions, vault AS $$
  SELECT pgp_sym_decrypt(
    encrypted_token,
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'encryption_key' LIMIT 1)
  )::text
  FROM github_connections
  WHERE id = p_connection_id;
$$;
REVOKE EXECUTE ON FUNCTION decrypt_github_token FROM PUBLIC;

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_github_orgs_connection_id ON github_orgs (connection_id);
CREATE INDEX idx_repos_connection_id ON repos (connection_id) WHERE connection_id IS NOT NULL;
```

- [ ] **Step 2: Apply and verify**

```bash
cd ~/code/auto-claude
supabase db push
```

Then verify in Supabase Studio (or `supabase db diff`) that `github_connections`, `github_orgs` exist and `repos` has `connection_id` + `github_status`.

If `supabase db push` is not available, run:
```bash
supabase migration up
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/005_github_connections.sql
git commit -m "feat(db): add github_connections, github_orgs tables and repo columns"
```

---

## Task 2: Daemon — Make `config.repo` Optional

**Files:**
- Modify: `packages/daemon/src/config.ts:6`
- Modify: `packages/daemon/src/config.test.ts:29-33`

- [ ] **Step 1: Update the existing "rejects missing repo" test**

In `packages/daemon/src/config.test.ts`, find the existing test named `'rejects missing repo'` (line ~29) and change it to expect success — `repo` will be optional:

```typescript
// Before:
it('rejects missing repo', () => {
  const { repo, ...rest } = validConfig;
  const result = ConfigSchema.safeParse(rest);
  expect(result.success).toBe(false);
});

// After:
it('accepts config without repo (DB-mode)', () => {
  const { repo, ...rest } = validConfig;
  const result = ConfigSchema.safeParse(rest);
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd packages/daemon && npx vitest run src/config.test.ts
```

Expected: FAIL — the updated test fails because `repo` is still required.

- [ ] **Step 3: Make `repo` optional in `config.ts`**

```typescript
// packages/daemon/src/config.ts — change line 6-9
repo: z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
}).optional(),
```

- [ ] **Step 4: Run — expect pass**

```bash
cd packages/daemon && npx vitest run src/config.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/config.ts packages/daemon/src/config.test.ts
git commit -m "feat(daemon): make config.repo optional for DB-mode multi-repo"
```

---

## Task 3: Daemon — RepoManager

**Files:**
- Create: `packages/daemon/src/control-plane/repo-manager.ts`
- Create: `packages/daemon/src/control-plane/repo-manager.test.ts`

- [ ] **Step 1: Write the tests first**

Create `packages/daemon/src/control-plane/repo-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RepoManager } from './repo-manager.js';

// Minimal WorkDetector stub
function makeDetector(repoId: string) {
  return {
    repoId,
    detectReadyWork: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    claimWork: vi.fn(),
    completeWork: vi.fn(),
    markStuck: vi.fn(),
  };
}

function makeSupabase(repos: Array<{ id: string; owner: string; name: string; poll_interval_ms: number | null; connection_id: string | null }>) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: 'upserted-id' }, error: null }),
        }),
      }),
      then: vi.fn(),
    }),
    rpc: vi.fn().mockResolvedValue({ data: 'fake-token', error: null }),
  } as any;
}

describe('RepoManager', () => {
  it('starts pollers for all enabled repos on initialize', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({
          data: [
            { id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: null, connection_id: null },
            { id: 'r2', owner: 'acme', name: 'api', poll_interval_ms: null, connection_id: null },
          ],
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();
    expect(mgr.activePollerCount()).toBe(2);
    mgr.stop();
  });

  it('reload adds new enabled repos and removes disabled ones', async () => {
    const onPoll = vi.fn();
    let callCount = 0;
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockImplementation(() => {
          callCount++;
          // First call: 2 repos. Second call (after reload): 1 repo.
          const repos = callCount === 1
            ? [
                { id: 'r1', owner: 'a', name: 'b', poll_interval_ms: null, connection_id: null },
                { id: 'r2', owner: 'c', name: 'd', poll_interval_ms: null, connection_id: null },
              ]
            : [
                { id: 'r1', owner: 'a', name: 'b', poll_interval_ms: null, connection_id: null },
              ];
          return Promise.resolve({ data: repos, error: null });
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();
    expect(mgr.activePollerCount()).toBe(2);

    await mgr.reload();
    expect(mgr.activePollerCount()).toBe(1);
    mgr.stop();
  });

  it('graceful disable: poller removed immediately when activeRuns=0', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({
          data: [{ id: 'r1', owner: 'a', name: 'b', poll_interval_ms: null, connection_id: null }],
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();
    expect(mgr.activePollerCount()).toBe(1);

    // Disable with no active runs — should remove immediately
    mgr.disablePoller('r1');
    expect(mgr.activePollerCount()).toBe(0);
    mgr.stop();
  });

  it('graceful disable: poller deferred when activeRuns>0', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({
          data: [{ id: 'r1', owner: 'a', name: 'b', poll_interval_ms: null, connection_id: null }],
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();

    mgr.notifyRunStart('r1'); // activeRuns = 1
    mgr.disablePoller('r1'); // should not remove yet
    expect(mgr.activePollerCount()).toBe(1); // still there

    mgr.notifyRunEnd('r1'); // activeRuns back to 0 → remove
    expect(mgr.activePollerCount()).toBe(0);
    mgr.stop();
  });

  it('upsertRepo inserts a repo and returns its id', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({ data: [], error: null }),
        upsert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'new-id' }, error: null }),
          }),
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();
    const result = await mgr.upsertRepo('acme', 'web');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('new-id');
    mgr.stop();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd packages/daemon && npx vitest run src/control-plane/repo-manager.test.ts
```

Expected: FAIL — "Cannot find module './repo-manager.js'"

- [ ] **Step 3: Implement RepoManager**

Create `packages/daemon/src/control-plane/repo-manager.ts`:

```typescript
import { createClient } from '@supabase/supabase-js';
import { Octokit } from '@octokit/rest';
import { createWorkDetector, type WorkDetector } from './work-detection.js';
import { ok, err, type Result } from '../lib/result.js';

export interface RepoRecord {
  id: string;
  owner: string;
  name: string;
  poll_interval_ms: number | null;
  connection_id: string | null;
}

interface PollEntry {
  detector: WorkDetector;
  intervalHandle: ReturnType<typeof setInterval>;
  activeRuns: number;
  pendingDisable: boolean;
}

type SupabaseClient = ReturnType<typeof createClient>;

export class RepoManager {
  private pollers = new Map<string, PollEntry>();
  private fallbackHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly defaultPollIntervalMs: number,
    private readonly onPoll: (repoId: string, detector: WorkDetector) => void,
  ) {}

  async initialize(): Promise<Result<void>> {
    const result = await this.loadEnabledRepos();
    if (!result.ok) return result;
    for (const repo of result.value) {
      await this.startPoller(repo);
    }
    this.fallbackHandle = setInterval(() => { void this.sync(); }, 60_000);
    return ok(undefined);
  }

  async reload(): Promise<{ active: number }> {
    await this.sync();
    return { active: this.activePollerCount() };
  }

  async upsertRepo(owner: string, name: string): Promise<Result<string>> {
    const { data, error } = await this.supabase
      .from('repos')
      .upsert({ owner, name, enabled: true }, { onConflict: 'owner,name' })
      .select('id')
      .single();
    if (error) return err(new Error(error.message));
    return ok((data as { id: string }).id);
  }

  notifyRunStart(repoId: string): void {
    const entry = this.pollers.get(repoId);
    if (entry) entry.activeRuns++;
  }

  notifyRunEnd(repoId: string): void {
    const entry = this.pollers.get(repoId);
    if (!entry) return;
    entry.activeRuns = Math.max(0, entry.activeRuns - 1);
    if (entry.pendingDisable && entry.activeRuns === 0) {
      this.removePoller(repoId);
    }
  }

  disablePoller(repoId: string): void {
    const entry = this.pollers.get(repoId);
    if (!entry) return;
    clearInterval(entry.intervalHandle);
    entry.pendingDisable = true;
    if (entry.activeRuns === 0) {
      this.removePoller(repoId);
    }
  }

  activePollerCount(): number {
    return this.pollers.size;
  }

  stop(): void {
    if (this.fallbackHandle) { clearInterval(this.fallbackHandle); this.fallbackHandle = null; }
    for (const [id] of this.pollers) this.removePoller(id);
  }

  private async sync(): Promise<void> {
    const result = await this.loadEnabledRepos();
    if (!result.ok) return;

    const enabledIds = new Set(result.value.map((r) => r.id));

    // Start pollers for new repos
    for (const repo of result.value) {
      if (!this.pollers.has(repo.id)) await this.startPoller(repo);
    }

    // Disable pollers for repos no longer enabled
    for (const [id] of this.pollers) {
      if (!enabledIds.has(id)) this.disablePoller(id);
    }
  }

  private async loadEnabledRepos(): Promise<Result<RepoRecord[]>> {
    const { data, error } = await this.supabase
      .from('repos')
      .select('id, owner, name, poll_interval_ms, connection_id')
      .eq('enabled', true)
      .is('deleted_at', null);
    if (error) return err(new Error(error.message));
    return ok((data ?? []) as RepoRecord[]);
  }

  private async resolveToken(connectionId: string | null): Promise<string | undefined> {
    if (!connectionId) return process.env.GITHUB_TOKEN;
    const { data } = await this.supabase.rpc('decrypt_github_token', {
      p_connection_id: connectionId,
    });
    return (data as string | null) ?? process.env.GITHUB_TOKEN;
  }

  private async startPoller(repo: RepoRecord): Promise<void> {
    const token = await this.resolveToken(repo.connection_id);
    const octokit = new Octokit({ auth: token });
    const detector = createWorkDetector(octokit, repo.owner, repo.name);
    const intervalMs = repo.poll_interval_ms ?? this.defaultPollIntervalMs;

    const intervalHandle = setInterval(() => {
      const entry = this.pollers.get(repo.id);
      if (entry && !entry.pendingDisable) {
        this.onPoll(repo.id, detector);
      }
    }, intervalMs);

    this.pollers.set(repo.id, {
      detector,
      intervalHandle,
      activeRuns: 0,
      pendingDisable: false,
    });
  }

  private removePoller(repoId: string): void {
    const entry = this.pollers.get(repoId);
    if (entry) { clearInterval(entry.intervalHandle); }
    this.pollers.delete(repoId);
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd packages/daemon && npx vitest run src/control-plane/repo-manager.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/repo-manager.ts packages/daemon/src/control-plane/repo-manager.test.ts
git commit -m "feat(daemon): add RepoManager for multi-repo polling with graceful disable"
```

---

## Task 4: Daemon — Server `/repos/reload` + Daemon Wiring

**Files:**
- Modify: `packages/daemon/src/control-plane/server.ts`
- Modify: `packages/daemon/src/control-plane/server.test.ts`
- Modify: `packages/daemon/src/control-plane/daemon.ts`

- [ ] **Step 1: Write failing test for `/repos/reload`**

Add to `packages/daemon/src/control-plane/server.test.ts` inside `describe('ControlServer')`:

```typescript
it('POST /repos/reload calls reloadRepos and returns count', async () => {
  const { server, start } = createControlServer(PORT + 2, {
    ...handlers,
    reloadRepos: async () => ({ active: 3 }),
  });
  const result = await start();
  expect(result.ok).toBe(true);

  try {
    const res = await fetch(`http://127.0.0.1:${PORT + 2}/repos/reload`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reloaded).toBe(true);
    expect(body.active).toBe(3);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd packages/daemon && npx vitest run src/control-plane/server.test.ts
```

Expected: FAIL — route returns 404.

- [ ] **Step 3: Add `reloadRepos` to `ControlHandlers` and the route**

In `packages/daemon/src/control-plane/server.ts`, add `reloadRepos` to the interface and the route handler:

```typescript
// Add to ControlHandlers interface after `retry`:
reloadRepos?: () => Promise<{ active: number }>;
```

Add the route after the `/resume` handler (before the `else` block):

```typescript
} else if (method === 'POST' && url.pathname === '/repos/reload') {
  if (handlers.reloadRepos) {
    handlers.reloadRepos().then((result) => {
      json(res, 200, { reloaded: true, active: result.active });
    }).catch(() => {
      json(res, 500, { error: 'reload failed' });
    });
  } else {
    json(res, 200, { reloaded: false, active: 0 });
  }
```

- [ ] **Step 4: Run — expect pass**

```bash
cd packages/daemon && npx vitest run src/control-plane/server.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Rewrite `daemon.ts` to use RepoManager**

Replace `packages/daemon/src/control-plane/daemon.ts` with the following. The key changes are: (a) make `repo` optional; (b) branch on `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` for DB-mode; (c) replace single `setInterval` with `RepoManager`.

```typescript
// src/control-plane/daemon.ts
import { createClient } from '@supabase/supabase-js';
import { loadConfig, type Config } from '../config.js';
import { SessionRuntime } from '../session-runtime/runtime.js';
import { CostTracker } from '../session-runtime/cost.js';
import { ImplementationCoordinator } from '../implementation/coordinator.js';
import { StateManager } from './state.js';
import { createControlServer } from './server.js';
import { RepoManager } from './repo-manager.js';
import { createWorkDetector, type WorkDetector } from './work-detection.js';
import { createPhaseHandlers } from './phases.js';
import { runPipeline } from './pipeline.js';
import { getPipeline, getStartPhase } from './fsm.js';
import { notify } from './notify.js';
import type { RunState, WorkRequest } from '../types.js';
import { ok, err, type Result } from '../lib/result.js';
import { RemoteControlManager } from './remote-control.js';
import { Octokit } from '@octokit/rest';

export async function startDaemon(configPath: string): Promise<Result<void>> {
  // 1. Load config
  const configResult = await loadConfig(configPath);
  if (!configResult.ok) return configResult;
  const config = configResult.value;

  // 2. Initialize state
  const stateDir = 'state';
  const stateMgr = new StateManager(stateDir);
  await stateMgr.initialize();

  // 3. Initialize services
  const costTracker = new CostTracker({
    dailyBudget: config.dailyBudget,
    perRunBudget: config.perRunBudget,
  });
  const runtime = new SessionRuntime(config, costTracker);
  const coordinator = new ImplementationCoordinator(runtime, process.cwd());

  // 3b. Start Remote Control
  const remoteControl = new RemoteControlManager();
  remoteControl.start();

  // 4. State tracking
  let paused = false;
  let activeRuns = 0;
  let shuttingDown = false;

  // 5. Build RepoManager or legacy single-repo detector
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let repoManager: RepoManager | null = null;
  let legacyDetector: WorkDetector | null = null;
  let legacyOctokit: Octokit | null = null;

  if (supabaseUrl && supabaseKey) {
    // DB mode
    const supabase = createClient(supabaseUrl, supabaseKey);
    repoManager = new RepoManager(
      supabase,
      config.pollIntervalMs,
      async (repoId, detector) => {
        if (paused || shuttingDown) return;
        if (activeRuns >= config.maxConcurrentRuns) return;
        costTracker.maybeResetDaily();
        const workResult = await detector.detectReadyWork();
        if (!workResult.ok) {
          // Check if 401 — mark connection token_invalid if needed (best-effort)
          return;
        }
        for (const request of workResult.value) {
          if (activeRuns >= config.maxConcurrentRuns) break;
          if (paused || shuttingDown) break;
          const claimResult = await detector.claimWork(request.issueNumber);
          if (!claimResult.ok) continue;
          activeRuns++;
          repoManager!.notifyRunStart(repoId);
          processWorkRequest(config, request, runtime, coordinator, costTracker, stateMgr, detector, stateDir)
            .catch((e) => console.error(`Run failed for #${request.issueNumber}:`, e))
            // CRITICAL: notifyRunEnd must be in .finally(), never only in .catch() or .then().
            // If it is missing here, a disabled repo's poller hangs in pendingDisable forever.
            .finally(() => {
              activeRuns--;
              repoManager!.notifyRunEnd(repoId);
            });
        }
      },
    );

    // If config.repo is present, upsert it as a seed repo
    if (config.repo) {
      const upsertResult = await repoManager.upsertRepo(config.repo.owner, config.repo.name);
      if (!upsertResult.ok) {
        console.warn(`[daemon] Could not upsert seed repo from config: ${upsertResult.error.message}`);
      }
    }

    const initResult = await repoManager.initialize();
    if (!initResult.ok) {
      await remoteControl.stop();
      return initResult;
    }
  } else {
    // Legacy mode: config.repo required
    if (!config.repo) {
      await remoteControl.stop();
      return err(new Error(
        'No SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set and no config.repo — cannot determine repos to poll'
      ));
    }
    legacyOctokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    legacyDetector = createWorkDetector(legacyOctokit, config.repo.owner, config.repo.name);
  }

  // 6. Start control server
  const { server, start } = createControlServer(config.controlPort, {
    getStatus: () => ({
      activeRuns,
      dailyCost: costTracker.getDailyCost(),
      paused,
      uptime: process.uptime(),
      ...remoteControl.getState(),
    }),
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    retry: (_issueNumber) => err(new Error('retry not yet implemented')),
    reloadRepos: repoManager
      ? async () => repoManager!.reload()
      : undefined,
  });
  const serverResult = await start();
  if (!serverResult.ok) {
    repoManager?.stop();
    await remoteControl.stop();
    return serverResult;
  }

  console.log(`Auto-Claude daemon started on port ${config.controlPort}`);

  // 7. Legacy polling loop (only used when repoManager is null)
  let legacyPoller: ReturnType<typeof setInterval> | null = null;
  if (legacyDetector) {
    legacyPoller = setInterval(async () => {
      if (paused || shuttingDown || !legacyDetector) return;
      if (activeRuns >= config.maxConcurrentRuns) return;
      costTracker.maybeResetDaily();
      const workResult = await legacyDetector.detectReadyWork();
      if (!workResult.ok) return;
      for (const request of workResult.value) {
        if (activeRuns >= config.maxConcurrentRuns) break;
        if (paused || shuttingDown) break;
        const claimResult = await legacyDetector.claimWork(request.issueNumber);
        if (!claimResult.ok) continue;
        activeRuns++;
        processWorkRequest(config, request, runtime, coordinator, costTracker, stateMgr, legacyDetector, stateDir)
          .catch((e) => console.error(`Run failed for #${request.issueNumber}:`, e))
          .finally(() => { activeRuns--; });
      }
    }, config.pollIntervalMs);
  }

  // 8. Graceful shutdown
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down...');
    if (legacyPoller) clearInterval(legacyPoller);
    repoManager?.stop();
    const deadline = Date.now() + config.gracePeriodMs;
    while (activeRuns > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    await remoteControl.stop();
    server.close();
    console.log('Daemon stopped.');
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return ok(undefined);
}

async function processWorkRequest(
  config: Config,
  request: WorkRequest,
  runtime: SessionRuntime,
  coordinator: ImplementationCoordinator,
  costTracker: CostTracker,
  stateMgr: StateManager,
  detector: WorkDetector,
  stateDir: string,
): Promise<void> {
  const run: RunState = {
    issueNumber: request.issueNumber,
    title: request.title,
    phase: getStartPhase('feature-simple'),
    variant: 'feature-simple',
    phaseCompletions: {},
    checkpoints: [],
    cost: 0,
    perRunBudget: config.perRunBudget,
    fixAttempts: [],
    errorHashes: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await stateMgr.saveRunState(run);

  // Build a temporary octokit from the detector's closure is not straightforward.
  // Pass detector directly to phase handlers that need it, or use the Octokit from env for notifications.
  const notifyOctokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const handlers = createPhaseHandlers(config, runtime, coordinator, notifyOctokit, request, stateDir);
  const table = getPipeline('feature-simple');

  console.log(`[daemon] Pipeline start for #${request.issueNumber}: ${request.title}`);
  const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
  console.log(`[daemon] Pipeline done for #${request.issueNumber}: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`);

  if (result.outcome === 'stuck') {
    await detector.markStuck(request.issueNumber, result.error ?? 'Unknown error');
    await notify(config.webhooks, {
      event: 'stuck',
      issueNumber: request.issueNumber,
      phase: run.phase,
      message: `Issue #${request.issueNumber} stuck: ${result.error ?? 'unknown'}`,
    });
  }
}
```

- [ ] **Step 6: Run full daemon test suite**

```bash
cd packages/daemon && npx vitest run
```

Expected: all tests PASS. Fix any type errors from the `processWorkRequest` signature change before committing.

> **Risk check (dual-mode):** Before committing, manually verify both startup paths:
> - With `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set and no `config.repo` → daemon starts, loads repos from DB.
> - With `config.repo` set and no Supabase env vars → daemon starts in legacy mode, polls that single repo.
> - With neither → daemon exits with a clear error message.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/control-plane/server.ts packages/daemon/src/control-plane/server.test.ts packages/daemon/src/control-plane/daemon.ts
git commit -m "feat(daemon): wire RepoManager into daemon, add /repos/reload endpoint"
```

---

## Task 5: Dashboard — Service Client + OAuth Flow

**Files:**
- Create: `packages/dashboard/lib/supabase/service.ts`
- Create: `packages/dashboard/app/api/auth/github-connection/route.ts`
- Create: `packages/dashboard/app/api/auth/github-connection/callback/route.ts`
- Create: `packages/dashboard/app/api/daemon/repos-reload/route.ts`

- [ ] **Step 1: Create service-role Supabase client**

Create `packages/dashboard/lib/supabase/service.ts`:

```typescript
import { createClient } from '@supabase/supabase-js';

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key);
}
```

- [ ] **Step 2: Write test for OAuth initiate route**

Create `packages/dashboard/app/api/auth/github-connection/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }),
  }),
}));

vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'test-client-id');
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');

describe('GET /api/auth/github-connection', () => {
  it('redirects to GitHub OAuth with correct params', async () => {
    const { GET } = await import('./route.js');
    const req = new Request('http://localhost:3000/api/auth/github-connection');
    const res = await GET(req as any);

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('github.com/login/oauth/authorize');
    expect(location).toContain('client_id=test-client-id');
    expect(location).toContain('scope=repo');
  });

  it('returns 401 if not authenticated', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    (createClient as any).mockResolvedValueOnce({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      from: vi.fn(),
    });
    const { GET } = await import('./route.js');
    const req = new Request('http://localhost:3000/api/auth/github-connection');
    const res = await GET(req as any);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run test — expect failure**

```bash
cd packages/dashboard && npx vitest run app/api/auth/github-connection/route.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Create OAuth initiate route**

Create `packages/dashboard/app/api/auth/github-connection/route.ts`:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: member } = await supabase.from('team_members')
    .select('role').eq('user_id', user.id).single();
  if (member?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: 'GitHub OAuth not configured' }, { status: 500 });

  const state = crypto.randomUUID();
  const origin = process.env.SITE_URL
    ?? `${request.headers.get('x-forwarded-proto') ?? 'https'}://${request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''}`;

  const callbackUrl = `${origin}/api/auth/github-connection/callback`;
  const githubUrl = new URL('https://github.com/login/oauth/authorize');
  githubUrl.searchParams.set('client_id', clientId);
  githubUrl.searchParams.set('redirect_uri', callbackUrl);
  githubUrl.searchParams.set('scope', 'repo read:org read:user');
  githubUrl.searchParams.set('state', state);

  const response = NextResponse.redirect(githubUrl.toString());
  response.cookies.set('gh_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  return response;
}
```

- [ ] **Step 5: Run test — expect pass**

```bash
cd packages/dashboard && npx vitest run app/api/auth/github-connection/route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write test for OAuth callback**

Create `packages/dashboard/app/api/auth/github-connection/callback/route.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

const mockSupabase = {
  auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
  from: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    insert: vi.fn().mockResolvedValue({ error: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  }),
  rpc: vi.fn().mockResolvedValue({ data: 'conn-id', error: null }),
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabase),
}));

vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'cid');
vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', 'csec');
vi.stubEnv('SITE_URL', 'http://localhost:3000');

// Mock fetch for GitHub API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('GET /api/auth/github-connection/callback', () => {
  it('returns 400 on CSRF state mismatch', async () => {
    const { GET } = await import('./route.js');
    const req = new Request(
      'http://localhost:3000/api/auth/github-connection/callback?code=abc&state=wrong'
    );
    // Cookie has different state than query param
    Object.defineProperty(req, 'cookies', {
      value: { get: () => ({ value: 'correct-state' }) },
    });
    const res = await GET(req as any);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('error=invalid_state');
  });

  it('exchanges code and stores connection on valid state', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'ghp_test', scope: 'repo,read:org' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'dan', name: 'Dan', avatar_url: 'https://a.b/c.png', id: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 10, login: 'acme', name: 'Acme Corp', avatar_url: 'https://x.y/z.png' }] });

    const { GET } = await import('./route.js');
    const req = new Request(
      'http://localhost:3000/api/auth/github-connection/callback?code=valid-code&state=match'
    );
    Object.defineProperty(req, 'cookies', {
      value: { get: () => ({ value: 'match' }) },
    });
    const res = await GET(req as any);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings');
    expect(mockSupabase.rpc).toHaveBeenCalledWith('store_github_connection', expect.objectContaining({
      p_github_login: 'dan',
    }));
  });
});
```

- [ ] **Step 7: Run test — expect failure**

```bash
cd packages/dashboard && npx vitest run app/api/auth/github-connection/callback/route.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 8: Create OAuth callback route**

Create `packages/dashboard/app/api/auth/github-connection/callback/route.ts`:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const origin = process.env.SITE_URL
    ?? `${request.headers.get('x-forwarded-proto') ?? 'https'}://${request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''}`;
  const settingsUrl = `${origin}/settings`;

  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const storedState = request.cookies.get('gh_oauth_state')?.value;

  if (!code || !state || !storedState || state !== storedState) {
    return NextResponse.redirect(`${settingsUrl}?error=invalid_state`);
  }

  // Exchange code for token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  if (!tokenRes.ok) return NextResponse.redirect(`${settingsUrl}?error=token_exchange_failed`);

  const { access_token: token, scope } = await tokenRes.json() as { access_token?: string; scope?: string };
  if (!token) return NextResponse.redirect(`${settingsUrl}?error=token_exchange_failed`);

  // Fetch GitHub user info and orgs
  const ghHeaders = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const [userRes, orgsRes] = await Promise.all([
    fetch('https://api.github.com/user', { headers: ghHeaders }),
    fetch('https://api.github.com/user/orgs?per_page=100', { headers: ghHeaders }),
  ]);
  if (!userRes.ok) return NextResponse.redirect(`${settingsUrl}?error=github_api_failed`);

  const ghUser = await userRes.json() as { login: string; name?: string; avatar_url?: string; id: number };
  const ghOrgs = orgsRes.ok ? (await orgsRes.json() as Array<{ id: number; login: string; name?: string; avatar_url?: string }>) : [];

  // Store connection via SECURITY DEFINER function
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${settingsUrl}?error=not_authenticated`);

  const { data: connectionId, error: connErr } = await supabase.rpc('store_github_connection', {
    p_display_name: `${ghUser.login} (personal)`,
    p_github_login: ghUser.login,
    p_avatar_url: ghUser.avatar_url ?? null,
    p_connection_type: 'oauth_token',
    p_plaintext_token: token,
    p_scopes: scope ?? '',
    p_created_by: user.id,
  });
  if (connErr) return NextResponse.redirect(`${settingsUrl}?error=store_failed`);

  // Upsert orgs (personal account + orgs)
  const allOrgs = [
    { connection_id: connectionId, github_id: ghUser.id, login: ghUser.login, name: ghUser.name ?? ghUser.login, avatar_url: ghUser.avatar_url ?? null },
    ...ghOrgs.map((o) => ({ connection_id: connectionId, github_id: o.id, login: o.login, name: o.name ?? o.login, avatar_url: o.avatar_url ?? null })),
  ];
  await supabase.from('github_orgs').upsert(allOrgs, { onConflict: 'connection_id,github_id' });

  const response = NextResponse.redirect(settingsUrl);
  response.cookies.delete('gh_oauth_state');
  return response;
}
```

- [ ] **Step 9: Run test — expect pass**

```bash
cd packages/dashboard && npx vitest run app/api/auth/github-connection/callback/route.test.ts
```

Expected: PASS.

- [ ] **Step 10: Create daemon repos-reload proxy**

Create `packages/dashboard/app/api/daemon/repos-reload/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: member } = await supabase.from('team_members')
    .select('role').eq('user_id', user.id).single();
  if (member?.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const res = await fetch(`${process.env.DAEMON_URL}/repos/reload`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
```

- [ ] **Step 11: Commit**

```bash
git add \
  packages/dashboard/lib/supabase/service.ts \
  packages/dashboard/app/api/auth/github-connection/route.ts \
  packages/dashboard/app/api/auth/github-connection/route.test.ts \
  packages/dashboard/app/api/auth/github-connection/callback/route.ts \
  packages/dashboard/app/api/auth/github-connection/callback/route.test.ts \
  packages/dashboard/app/api/daemon/repos-reload/route.ts
git commit -m "feat(dashboard): add GitHub OAuth initiate/callback routes and daemon repos-reload proxy"
```

---

## Task 6: Dashboard — GitHub Connections Actions + Settings UI

**Files:**
- Create: `packages/dashboard/actions/github-connections.ts`
- Create: `packages/dashboard/components/github-connections-section.tsx`
- Modify: `packages/dashboard/app/(dashboard)/settings/page.tsx`

- [ ] **Step 1: Write tests for server actions**

Create `packages/dashboard/actions/github-connections.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

const mockRepos = {
  update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
};
const mockConnections = {
  delete: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
};
const mockFrom = vi.fn((table: string) => table === 'repos' ? mockRepos : mockConnections);

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
    from: mockFrom,
  }),
}));
vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn().mockResolvedValue(undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

describe('removeConnection', () => {
  it('sets repos enabled=false and connection_id=null before deleting', async () => {
    const { removeConnection } = await import('./github-connections.js');
    await removeConnection('conn-1');
    expect(mockRepos.update).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, connection_id: null })
    );
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
cd packages/dashboard && npx vitest run actions/github-connections.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create server actions**

Create `packages/dashboard/actions/github-connections.ts`:

```typescript
'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export async function removeConnection(connectionId: string) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  // Disconnect repos before deleting connection
  await supabase.from('repos')
    .update({ enabled: false, connection_id: null, updated_at: new Date().toISOString() })
    .eq('connection_id', connectionId);

  const { error } = await supabase.from('github_connections').delete().eq('id', connectionId);
  if (error) throw new Error(error.message);

  revalidatePath('/settings');
  revalidatePath('/repos');
}

export async function importRepos(
  connectionId: string,
  repos: Array<{ owner: string; name: string }>,
) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  if (repos.length === 0) return;

  // Upsert by owner+name — preserve existing settings, just update connection_id
  for (const { owner, name } of repos) {
    await supabase.from('repos').upsert(
      { owner, name, connection_id: connectionId, enabled: false },
      { onConflict: 'owner,name', ignoreDuplicates: false },
    );
  }

  // Notify daemon best-effort
  fetch(`${process.env.DAEMON_URL}/repos/reload`, { method: 'POST', signal: AbortSignal.timeout(3000) })
    .catch(() => {});

  revalidatePath('/repos');
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
cd packages/dashboard && npx vitest run actions/github-connections.test.ts
```

Expected: PASS.

- [ ] **Step 5: Create GitHub Connections settings section**

Create `packages/dashboard/components/github-connections-section.tsx`:

```tsx
import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { removeConnection } from '@/actions/github-connections';
import { Plus } from 'lucide-react';

export async function GitHubConnectionsSection() {
  const supabase = await createClient();
  const { data: connections } = await supabase
    .from('github_connections')
    .select('id, display_name, github_login, avatar_url, status, created_at, github_orgs(login)')
    .order('created_at', { ascending: true });

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub Connections</CardTitle>
        <CardDescription>System-level GitHub accounts used for repo polling</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connections?.map((conn) => (
          <div key={conn.id} className="flex items-center justify-between border rounded-md p-3">
            <div className="flex items-center gap-3">
              {conn.avatar_url && (
                <img src={conn.avatar_url} alt={conn.github_login} className="w-8 h-8 rounded-full" />
              )}
              <div>
                <p className="font-medium text-sm">{conn.display_name}</p>
                <p className="text-xs text-muted-foreground">
                  {(conn.github_orgs as Array<{ login: string }>)?.map((o) => o.login).join(', ')}
                </p>
              </div>
              {conn.status === 'token_invalid' && (
                <Badge variant="destructive">Token invalid</Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href={`/api/auth/github-connection?reauthorize=${conn.id}`}>Re-authorize</Link>
              </Button>
              <form action={removeConnection.bind(null, conn.id)}>
                <Button variant="ghost" size="sm" type="submit">Remove</Button>
              </form>
            </div>
          </div>
        ))}
        {(!connections || connections.length === 0) && (
          <p className="text-sm text-muted-foreground">No GitHub accounts connected.</p>
        )}
        <Button asChild variant="outline" className="w-full">
          <Link href="/api/auth/github-connection">
            <Plus className="h-4 w-4 mr-2" />Add GitHub Account
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: Add section to settings page**

Modify `packages/dashboard/app/(dashboard)/settings/page.tsx` — add the import and the component after the existing card:

```tsx
import { GitHubConnectionsSection } from '@/components/github-connections-section';

// Inside the return, after the existing <Card>:
<GitHubConnectionsSection />
```

- [ ] **Step 7: Commit**

```bash
git add \
  packages/dashboard/actions/github-connections.ts \
  packages/dashboard/actions/github-connections.test.ts \
  packages/dashboard/components/github-connections-section.tsx \
  packages/dashboard/app/(dashboard)/settings/page.tsx
git commit -m "feat(dashboard): add GitHub connections settings section and server actions"
```

---

## Task 7: Dashboard — Repos Page + Import Modal + Daemon Notify

**Files:**
- Create: `packages/dashboard/app/api/github/connections/[id]/orgs/route.ts`
- Create: `packages/dashboard/app/api/github/connections/[id]/repos/route.ts`
- Create: `packages/dashboard/components/import-repos-modal.tsx`
- Modify: `packages/dashboard/app/(dashboard)/repos/page.tsx`
- Modify: `packages/dashboard/actions/repos.ts`

- [ ] **Step 1: Create GitHub orgs API route**

Create `packages/dashboard/app/api/github/connections/[id]/orgs/route.ts`:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { data: orgs, error } = await supabase
    .from('github_orgs')
    .select('id, login, name, avatar_url, is_selected')
    .eq('connection_id', id)
    .order('login');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(orgs ?? []);
}
```

- [ ] **Step 2: Create GitHub repos API route**

Create `packages/dashboard/app/api/github/connections/[id]/repos/route.ts`:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const org = req.nextUrl.searchParams.get('org');
  if (!org) return NextResponse.json({ error: 'Missing org param' }, { status: 400 });

  // Decrypt token — service role required
  const service = createServiceClient();
  const { data: token, error: tokenErr } = await service.rpc('decrypt_github_token', {
    p_connection_id: id,
  });
  if (tokenErr || !token) return NextResponse.json({ error: 'Could not retrieve token' }, { status: 500 });

  // Determine if this is the personal account (org matches github_login)
  const { data: conn } = await supabase
    .from('github_connections')
    .select('github_login')
    .eq('id', id)
    .single();

  const ghHeaders = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const endpoint = conn?.github_login === org
    ? `https://api.github.com/user/repos?per_page=100&type=owner`
    : `https://api.github.com/orgs/${org}/repos?per_page=100&type=all`;

  const res = await fetch(endpoint, { headers: ghHeaders });
  if (!res.ok) return NextResponse.json({ error: 'GitHub API error' }, { status: 502 });

  const ghRepos = await res.json() as Array<{ full_name: string; name: string; owner: { login: string }; private: boolean }>;
  return NextResponse.json(
    ghRepos.map((r) => ({ owner: r.owner.login, name: r.name, full_name: r.full_name, private: r.private }))
  );
}
```

- [ ] **Step 3: Create import repos modal**

Create `packages/dashboard/components/import-repos-modal.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { importRepos } from '@/actions/github-connections';
import { useRouter } from 'next/navigation';

interface Org { id: string; login: string; name: string | null; avatar_url: string | null }
interface Repo { owner: string; name: string; full_name: string; private: boolean }

export function ImportReposModal({
  connectionId,
  connectionName,
}: {
  connectionId: string;
  connectionName: string;
}) {
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<Set<string>>(new Set());
  const [repos, setRepos] = useState<Map<string, Repo[]>>(new Map());
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function openModal() {
    setLoading(true);
    setOpen(true);
    const res = await fetch(`/api/github/connections/${connectionId}/orgs`);
    const data: Org[] = await res.json();
    setOrgs(data);
    setLoading(false);
  }

  async function toggleOrg(login: string, checked: boolean) {
    const next = new Set(selectedOrgs);
    if (checked) {
      next.add(login);
      if (!repos.has(login)) {
        const res = await fetch(`/api/github/connections/${connectionId}/repos?org=${login}`);
        const data: Repo[] = await res.json();
        setRepos((prev) => new Map(prev).set(login, data));
      }
    } else {
      next.delete(login);
    }
    setSelectedOrgs(next);
  }

  function toggleRepo(fullName: string, checked: boolean) {
    const next = new Set(selectedRepos);
    checked ? next.add(fullName) : next.delete(fullName);
    setSelectedRepos(next);
  }

  function selectAllRepos(orgLogin: string, checked: boolean) {
    const orgRepos = repos.get(orgLogin) ?? [];
    const next = new Set(selectedRepos);
    orgRepos.forEach((r) => checked ? next.add(r.full_name) : next.delete(r.full_name));
    setSelectedRepos(next);
  }

  async function handleImport() {
    setLoading(true);
    const toImport: Array<{ owner: string; name: string }> = [];
    for (const [org, orgRepos] of repos) {
      if (!selectedOrgs.has(org)) continue;
      for (const r of orgRepos) {
        if (selectedRepos.has(r.full_name)) toImport.push({ owner: r.owner, name: r.name });
      }
    }
    await importRepos(connectionId, toImport);
    setOpen(false);
    router.refresh();
    setLoading(false);
  }

  const totalSelected = selectedRepos.size;

  return (
    <>
      <Button variant="outline" size="sm" onClick={openModal}>Import repositories</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import from {connectionName}</DialogTitle>
          </DialogHeader>
          {loading && orgs.length === 0 && <p className="text-sm text-muted-foreground">Loading...</p>}
          <div className="space-y-4">
            {orgs.map((org) => (
              <div key={org.login} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`org-${org.login}`}
                    checked={selectedOrgs.has(org.login)}
                    onCheckedChange={(v) => toggleOrg(org.login, !!v)}
                  />
                  <label htmlFor={`org-${org.login}`} className="font-medium text-sm cursor-pointer">
                    {org.name ?? org.login}
                  </label>
                </div>
                {selectedOrgs.has(org.login) && (repos.get(org.login)?.length ?? 0) > 0 && (
                  <div className="ml-6 space-y-1">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`all-${org.login}`}
                        checked={(repos.get(org.login) ?? []).every((r) => selectedRepos.has(r.full_name))}
                        onCheckedChange={(v) => selectAllRepos(org.login, !!v)}
                      />
                      <label htmlFor={`all-${org.login}`} className="text-xs text-muted-foreground cursor-pointer">Select all</label>
                    </div>
                    {(repos.get(org.login) ?? []).map((r) => (
                      <div key={r.full_name} className="flex items-center gap-2">
                        <Checkbox
                          id={`repo-${r.full_name}`}
                          checked={selectedRepos.has(r.full_name)}
                          onCheckedChange={(v) => toggleRepo(r.full_name, !!v)}
                        />
                        <label htmlFor={`repo-${r.full_name}`} className="text-sm cursor-pointer font-mono">
                          {r.name}
                        </label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleImport} disabled={totalSelected === 0 || loading}>
              Import {totalSelected > 0 ? `${totalSelected} repo${totalSelected !== 1 ? 's' : ''}` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 4: Update repos page**

Replace `packages/dashboard/app/(dashboard)/repos/page.tsx` with:

```tsx
import { createClient } from '@/lib/supabase/server';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import Link from 'next/link';
import { Plus, AlertTriangle } from 'lucide-react';
import { ImportReposModal } from '@/components/import-repos-modal';

export default async function ReposPage() {
  const supabase = await createClient();
  const [{ data: repos }, { data: connections }] = await Promise.all([
    supabase.from('repos').select('*, github_connections(display_name, github_login)').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('github_connections').select('id, display_name, github_login, status').order('created_at'),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Repositories</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage monitored repositories</p>
        </div>
        <div className="flex gap-2">
          {connections?.map((conn) => (
            <ImportReposModal
              key={conn.id}
              connectionId={conn.id}
              connectionName={conn.display_name}
            />
          ))}
          <Button asChild variant="outline">
            <Link href="/repos/new"><Plus className="h-4 w-4 mr-2" />Add manually</Link>
          </Button>
        </div>
      </div>
      <div className="space-y-3">
        {repos?.map((repo) => {
          const conn = repo.github_connections as { display_name: string; github_login: string } | null;
          return (
            <Card key={repo.id} className="hover:border-border/80 transition-colors">
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  <span className="font-mono font-medium">{repo.owner}/{repo.name}</span>
                  <Badge variant={repo.enabled ? 'default' : 'secondary'}>
                    {repo.enabled ? 'active' : 'disabled'}
                  </Badge>
                  {conn && (
                    <Badge variant="outline" className="text-xs">{conn.display_name}</Badge>
                  )}
                  {repo.github_status === 'not_found' && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="h-3 w-3" />not found on GitHub
                    </Badge>
                  )}
                  {!conn && !repo.connection_id && (
                    <span className="text-xs text-muted-foreground">manual</span>
                  )}
                  {repo.connection_id && !conn && (
                    <Badge variant="secondary" className="text-xs">disconnected</Badge>
                  )}
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/repos/${repo.id}`}>Configure →</Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
        {(!repos || repos.length === 0) && (
          <div className="text-center py-12 text-muted-foreground">
            No repositories yet. Import from GitHub or <Link href="/repos/new" className="underline">add manually</Link>.
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Notify daemon on enable/disable in repos.ts**

In `packages/dashboard/actions/repos.ts`, add daemon notification to both `enableRepo` and `disableRepo`:

```typescript
// Add this helper at the top of the file (after imports):
function notifyDaemonReload() {
  fetch(`${process.env.DAEMON_URL}/repos/reload`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
```

Then call `notifyDaemonReload()` at the end of `enableRepo` and `disableRepo` (before `revalidatePath`).

- [ ] **Step 6: Run dashboard tests**

```bash
cd packages/dashboard && npx vitest run
```

Expected: all tests PASS. If the `repos.test.ts` mock setup fails due to the new `notifyDaemonReload` fetch call, stub `global.fetch` in that test file:

```typescript
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
```

- [ ] **Step 6b: Manual modal verification (no automated tests exist for this component)**

The modal has interactive async state that vitest cannot cover without `@testing-library/react` (not currently in the project). Before committing, manually verify:

1. Open `/repos` — "Import repositories" button appears for each connection.
2. Click button — modal opens, orgs load within 2s.
3. Check an org — its repo list loads and appears beneath it.
4. "Select all" toggle for an org checks/unchecks all repos in that org.
5. Global "Select all" at org level applies correctly.
6. Import button is disabled until at least one repo is checked.
7. Click Import — modal closes, repos appear on `/repos` with connection badge, polling disabled.
8. Re-open modal — previously imported repos still show as checkable (re-import is idempotent).

- [ ] **Step 7: Commit**

```bash
git add \
  packages/dashboard/app/api/github/connections \
  packages/dashboard/components/import-repos-modal.tsx \
  packages/dashboard/app/(dashboard)/repos/page.tsx \
  packages/dashboard/actions/repos.ts
git commit -m "feat(dashboard): add import repos modal, connection badges, and daemon notify on toggle"
```

---

## Verification Checklist

After all tasks complete, run the full test suite:

```bash
cd packages/daemon && npx vitest run
cd packages/dashboard && npx vitest run
```

**Risk checks (must pass before merge):**
- Grep the daemon codebase for every `processWorkRequest` call — confirm each is followed by `.finally(() => { activeRuns--; repoManager!.notifyRunEnd(repoId); })`, not just `.catch()`.
- Confirm the import modal manual checklist in Task 7 Step 6b is completed.
- Confirm both daemon startup modes work (dual-mode check in Task 4 Step 6).
- Confirm `// TODO: proactive token health check` comment exists near the 401-handling code in `daemon.ts`.

Manual smoke test:
1. Set `GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET` in `.env.local`
2. Navigate to Settings → click "Add GitHub Account" → authorize on GitHub
3. Verify connection appears in Settings with orgs listed
4. Navigate to Repos → click "Import repositories" → select repos → click Import
5. Verify repos appear in the list with connection badge, polling disabled
6. Enable one repo → confirm daemon logs show new poller starting (or `POST /repos/reload` called)
7. Disable the repo → confirm daemon gracefully stops polling (running tasks unaffected)
8. Start daemon without `config.repo` and with `SUPABASE_URL` set → confirm it loads repos from DB
9. Start daemon without `config.repo` and without `SUPABASE_URL` → confirm it exits with clear error
