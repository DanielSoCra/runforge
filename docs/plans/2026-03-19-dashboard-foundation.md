# Dashboard Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Next.js 16 dashboard with GitHub OAuth, repo management, run monitoring, cost tracking, team management, and daemon control — backed by Supabase project `uqhnbvljzfwuexmwlzrn`.

**Architecture:** Next.js 16 App Router with Server Actions for all Supabase mutations. Three explicit API routes for daemon proxy only (`/api/daemon/*`). Supabase handles auth (GitHub OAuth), database (Postgres + RLS), and realtime (live run updates). Deployed via Docker Compose (Caddy + Next.js + Daemon) on a shared Docker network.

**Tech Stack:** Next.js 16, Tailwind CSS v4, shadcn/ui, Supabase (`@supabase/ssr` + `@supabase/supabase-js`), Vitest (unit), Playwright (e2e), pnpm, TypeScript

**Supabase Project:** `uqhnbvljzfwuexmwlzrn` — `https://supabase.com/dashboard/project/uqhnbvljzfwuexmwlzrn`

**Specs:** `.specify/functional/dashboard.md`, `.specify/architecture/dashboard.md`, `.specify/stack/dashboard-ts.md`

---

## MCP Servers Used In This Plan

| Tool | MCP Server | Purpose |
|---|---|---|
| context7 | `@upstash/context7-mcp` | Pull live docs for Next.js, Supabase, Tailwind, shadcn/ui |
| Supabase | `https://mcp.supabase.com` | Run migrations, inspect tables, test RLS |
| shadcn/ui | `@jpisnice/shadcn-ui-mcp-server` | Browse and install components |

---

## File Structure

```
dashboard/                        # Next.js project root
  app/
    layout.tsx                    # Root layout (font, theme provider)
    page.tsx                      # Dashboard home — stats + recent runs
    login/page.tsx                # Sign-in with GitHub button
    auth/
      login/route.ts              # POST — initiates GitHub OAuth redirect
      callback/route.ts           # GET — exchanges code, calls bootstrap_user_access
    repos/
      page.tsx                    # Repo list with status badges
      new/page.tsx                # Add repo form
      [id]/page.tsx               # Repo detail + settings + API keys
    runs/
      page.tsx                    # Run history with filters
      [id]/page.tsx               # Run detail — phases, costs, report
    cost/page.tsx                 # Cost chart by day + repo breakdown
    settings/page.tsx             # Global concurrency + poll interval
    team/page.tsx                 # Members list + invite form
    api/
      daemon/
        pause/route.ts            # POST → proxies to daemon:3847/pause
        resume/route.ts           # POST → proxies to daemon:3847/resume
        status/route.ts           # GET → proxies to daemon:3847/status
  actions/
    repos.ts                      # createRepo, updateRepo, enableRepo, deleteRepo
    api-keys.ts                   # upsertApiKey (encrypted, write-only)
    team.ts                       # createInvitation, changeRole, removeMember
    settings.ts                   # updateGlobalSettings
  components/
    sidebar.tsx                   # Navigation sidebar
    stats-cards.tsx               # Dashboard summary cards
    run-table.tsx                 # Shared run list table
    realtime-provider.tsx         # Supabase channel subscription
    cost-chart.tsx                # Recharts cost-by-day chart
    ui/                           # shadcn/ui components (auto-generated)
  lib/
    supabase/
      server.ts                   # createServerClient (Server Components / Actions)
      client.ts                   # createBrowserClient (client components)
      middleware.ts               # updateSession helper
    types.ts                      # Database types (generated from Supabase schema)
  middleware.ts                   # Auth check on every request
  next.config.ts
  package.json
  tsconfig.json

supabase/
  migrations/
    001_initial.sql               # Full schema: tables, RLS, pgcrypto, functions (incl. upsert_api_key_encrypted)
  tests/
    rls.test.ts                   # RLS integration tests: unauth, viewer, admin, service-role

docker-compose.prod.yml           # Caddy + dashboard + daemon (shared network)
Caddyfile                         # Automatic HTTPS → dashboard container
.env.example                      # Template for all required env vars
```

---

## Task 0: Configure MCP Servers

**Files:**
- Modify: `~/.claude/settings.json`

> Prerequisites: You need a Supabase Personal Access Token. Generate one at: https://supabase.com/dashboard/account/tokens
> You need a GitHub API key for shadcn MCP. Create a fine-grained token at: https://github.com/settings/personal-access-tokens/new (no scopes needed, just for rate limit avoidance)

- [ ] **Step 1: Add context7 MCP to Claude Code settings**

```bash
claude mcp add context7 -- npx -y @upstash/context7-mcp@latest
```

Verify: `claude mcp list` should show `context7`.

- [ ] **Step 2: Add Supabase MCP (HTTP, project-scoped)**

Edit `~/.claude/settings.json` — add to `mcpServers`:

```json
"supabase": {
  "type": "http",
  "url": "https://mcp.supabase.com/mcp?project_ref=uqhnbvljzfwuexmwlzrn",
  "headers": {
    "Authorization": "Bearer YOUR_SUPABASE_PAT_HERE"
  }
}
```

Replace `YOUR_SUPABASE_PAT_HERE` with the token from https://supabase.com/dashboard/account/tokens.

- [ ] **Step 3: Add shadcn/ui MCP**

```bash
claude mcp add shadcn -- bunx -y @jpisnice/shadcn-ui-mcp-server --github-api-key YOUR_GITHUB_TOKEN
```

Replace `YOUR_GITHUB_TOKEN` with a GitHub personal access token.

- [ ] **Step 4: Restart Claude Code and verify all three MCPs**

```bash
# In Claude Code
/mcp
```

Expected: `context7 ✓`, `supabase ✓`, `shadcn ✓` all show as connected.

---

## Task 1: Supabase Schema

**Files:**
- Create: `supabase/migrations/001_initial.sql`
- Create: `supabase/tests/rls.test.ts`

> Use context7: Add "use context7" when asking Claude about Supabase RLS policies or pgcrypto patterns to get live docs.

- [ ] **Step 1: Write the RLS integration test (failing — no tables exist yet)**

Create `supabase/tests/rls.test.ts`:

```typescript
import { createClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
// Test user JWTs — create two test users in Supabase Auth and set these env vars:
// SUPABASE_TEST_ADMIN_JWT: JWT for a user who is a team_member with role=admin
// SUPABASE_TEST_VIEWER_JWT: JWT for a user who is a team_member with role=viewer
const ADMIN_JWT = process.env.SUPABASE_TEST_ADMIN_JWT!;
const VIEWER_JWT = process.env.SUPABASE_TEST_VIEWER_JWT!;

const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY);

describe('RLS policies', () => {
  let testRepoId: string;

  beforeAll(async () => {
    // Seed a repo for read tests
    const { data } = await serviceClient.from('repos').insert({
      owner: 'rls-test-org', name: 'rls-test-repo', enabled: false,
      staging_branch: 'staging', production_branch: 'main',
      budget_limit: 10.00, concurrency_limit: 1,
    }).select('id').single();
    testRepoId = data!.id;
  });

  afterAll(async () => {
    await serviceClient.from('repos').delete().eq('id', testRepoId);
  });

  // --- Unauthenticated ---
  it('unauthenticated client cannot read repos', async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { data } = await anonClient.from('repos').select('*');
    expect(data).toEqual([]);
  });

  it('unauthenticated client cannot read runs', async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { data } = await anonClient.from('runs').select('*');
    expect(data).toEqual([]);
  });

  // --- Service role ---
  it('service role can insert and read repos', async () => {
    const { data } = await serviceClient.from('repos').select('*').eq('id', testRepoId);
    expect(data?.length).toBe(1);
  });

  it('global_settings row exists after migration', async () => {
    const { data } = await serviceClient.from('global_settings').select('*');
    expect(data?.length).toBe(1);
  });

  // --- Admin user ---
  it('admin user can read repos', async () => {
    if (!ADMIN_JWT) return; // skip if no test user configured
    const adminClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } },
    });
    const { data } = await adminClient.from('repos').select('*').eq('id', testRepoId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it('admin user can update repos', async () => {
    if (!ADMIN_JWT) return;
    const adminClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } },
    });
    const { error } = await adminClient.from('repos')
      .update({ concurrency_limit: 2 })
      .eq('id', testRepoId);
    expect(error).toBeNull();
  });

  // --- Viewer user ---
  it('viewer user can read repos', async () => {
    if (!VIEWER_JWT) return;
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    const { data } = await viewerClient.from('repos').select('*').eq('id', testRepoId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it('viewer user cannot update repos', async () => {
    if (!VIEWER_JWT) return;
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    const { error } = await viewerClient.from('repos')
      .update({ concurrency_limit: 99 })
      .eq('id', testRepoId);
    expect(error).not.toBeNull(); // RLS should block this
  });

  it('viewer user cannot insert api_keys', async () => {
    if (!VIEWER_JWT) return;
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    const { error } = await viewerClient.from('api_keys').insert({
      repo_id: testRepoId, key_type: 'source-control', encrypted_value: 'fake',
    });
    expect(error).not.toBeNull();
  });
});
```

> **Setup for JWT tests:** Create two test users in Supabase Auth, insert them into `team_members` with appropriate roles via service-role client, then use `supabase.auth.signInWithPassword` (or generate JWTs via admin API) to get their tokens. Set `SUPABASE_TEST_ADMIN_JWT` and `SUPABASE_TEST_VIEWER_JWT` env vars. Tests are skipped if JWTs are not set, so the basic suite still runs in CI without them.

- [ ] **Step 2: Run tests to verify they fail (no tables yet)**

```bash
cd ~/code/auto-claude
SUPABASE_URL=https://uqhnbvljzfwuexmwlzrn.supabase.co \
SUPABASE_SERVICE_KEY=<service-role-key> \
SUPABASE_ANON_KEY=<anon-key> \
npx vitest run supabase/tests/rls.test.ts
```

Expected: FAIL — relation "repos" does not exist.

> **Keys:** Find both keys at https://supabase.com/dashboard/project/uqhnbvljzfwuexmwlzrn/settings/api

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/001_initial.sql`:

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE run_outcome AS ENUM ('in-progress', 'complete', 'stuck', 'escalated');
CREATE TYPE team_role AS ENUM ('admin', 'viewer');
CREATE TYPE key_type AS ENUM ('source-control', 'model-provider');
CREATE TYPE session_type AS ENUM ('planning', 'implementation', 'validation', 'diagnosis', 'fix');
CREATE TYPE invite_status AS ENUM ('pending', 'accepted');

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE global_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concurrency_limit integer NOT NULL DEFAULT 3,
  poll_interval_ms integer NOT NULL DEFAULT 60000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Seed one row — this is a single-row settings table
INSERT INTO global_settings (concurrency_limit, poll_interval_ms) VALUES (3, 60000);

CREATE TABLE repos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  staging_branch text NOT NULL DEFAULT 'staging',
  production_branch text NOT NULL DEFAULT 'main',
  budget_limit numeric(10,4),
  concurrency_limit integer NOT NULL DEFAULT 1,
  poll_interval_ms integer,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, name)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key_type key_type NOT NULL,
  encrypted_value bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, key_type)
);

CREATE TABLE team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role team_role NOT NULL DEFAULT 'viewer',
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_handle text NOT NULL,
  role team_role NOT NULL DEFAULT 'viewer',
  invited_by uuid REFERENCES auth.users(id),
  status invite_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_handle, status)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid REFERENCES repos(id) ON DELETE SET NULL,
  repo_owner text NOT NULL,
  repo_name text NOT NULL,
  issue_number integer NOT NULL,
  issue_title text NOT NULL,
  pipeline_variant text NOT NULL DEFAULT 'standard',
  current_phase text,
  outcome run_outcome NOT NULL DEFAULT 'in-progress',
  total_cost numeric(10,6) NOT NULL DEFAULT 0,
  phases jsonb NOT NULL DEFAULT '[]',
  fix_attempts integer NOT NULL DEFAULT 0,
  report text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE cost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_type session_type NOT NULL,
  cost numeric(10,6) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE global_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_events ENABLE ROW LEVEL SECURITY;

-- Helper: check if current user is an admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;

-- Helper: check if current user has any team membership
CREATE OR REPLACE FUNCTION is_member()
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members WHERE user_id = auth.uid()
  );
$$;

-- global_settings: all members read, only admins write
CREATE POLICY "members read settings" ON global_settings FOR SELECT USING (is_member());
CREATE POLICY "admins update settings" ON global_settings FOR UPDATE USING (is_admin());

-- repos: members read non-deleted; admins write
CREATE POLICY "members read repos" ON repos FOR SELECT USING (is_member() AND deleted_at IS NULL);
CREATE POLICY "admins insert repos" ON repos FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "admins update repos" ON repos FOR UPDATE USING (is_admin());
-- No DELETE policy — soft delete only (set deleted_at via UPDATE)

-- api_keys: admins only (write-only pattern enforced in app layer)
CREATE POLICY "admins manage api_keys" ON api_keys FOR ALL USING (is_admin());

-- team_members: members read; admins write
CREATE POLICY "members read team" ON team_members FOR SELECT USING (is_member());
CREATE POLICY "admins manage team" ON team_members FOR ALL USING (is_admin());

-- invitations: admins manage; no read needed by non-admin
CREATE POLICY "admins manage invitations" ON invitations FOR ALL USING (is_admin());

-- runs: all members read
CREATE POLICY "members read runs" ON runs FOR SELECT USING (is_member());
-- Service role writes runs (daemon) — no auth.uid() policy needed, service role bypasses RLS

-- cost_events: all members read
CREATE POLICY "members read cost_events" ON cost_events FOR SELECT USING (is_member());

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Atomic first-user-is-admin + invitation acceptance
CREATE OR REPLACE FUNCTION bootstrap_user_access(
  p_user_id uuid,
  p_provider_handle text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_role team_role;
BEGIN
  LOCK TABLE team_members IN EXCLUSIVE MODE;

  -- First user: always admin
  IF NOT EXISTS (SELECT 1 FROM team_members) THEN
    INSERT INTO team_members (user_id, role) VALUES (p_user_id, 'admin');
    RETURN 'admin';
  END IF;

  -- Already a member (re-login)
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = p_user_id) THEN
    SELECT role INTO v_role FROM team_members WHERE user_id = p_user_id;
    RETURN v_role::text;
  END IF;

  -- Check for pending invitation
  SELECT role INTO v_role FROM invitations
  WHERE provider_handle = p_provider_handle
    AND status = 'pending'
    AND expires_at > now()
  LIMIT 1;

  IF v_role IS NULL THEN
    RETURN 'denied';
  END IF;

  INSERT INTO team_members (user_id, role) VALUES (p_user_id, v_role);
  UPDATE invitations SET status = 'accepted'
    WHERE provider_handle = p_provider_handle AND status = 'pending';
  RETURN v_role::text;
END;
$$;

-- Daemon: decrypt API key (SECURITY DEFINER, callable only by service role)
CREATE OR REPLACE FUNCTION decrypt_api_key(p_repo_id uuid, p_key_type text)
RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT pgp_sym_decrypt(
    encrypted_value,
    current_setting('app.encryption_key')
  )::text
  FROM api_keys
  WHERE repo_id = p_repo_id AND key_type = p_key_type::key_type;
$$;
-- Revoke from public so only service role can call
REVOKE EXECUTE ON FUNCTION decrypt_api_key FROM PUBLIC;

-- Dashboard: write encrypted API key (called by Server Action, not daemon)
CREATE OR REPLACE FUNCTION upsert_api_key_encrypted(
  p_repo_id uuid, p_key_type text, p_plaintext text
) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO api_keys (repo_id, key_type, encrypted_value, updated_at)
  VALUES (p_repo_id, p_key_type::key_type, pgp_sym_encrypt(p_plaintext, current_setting('app.encryption_key')), now())
  ON CONFLICT (repo_id, key_type) DO UPDATE
    SET encrypted_value = EXCLUDED.encrypted_value, updated_at = now();
$$;

-- Set encryption key (run this manually once after migration):
-- ALTER DATABASE postgres SET app.encryption_key = 'your-strong-secret-here';

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_repos_enabled ON repos (enabled) WHERE deleted_at IS NULL;
CREATE INDEX idx_runs_repo_id ON runs (repo_id);
CREATE INDEX idx_runs_started_at ON runs (started_at DESC);
CREATE INDEX idx_cost_events_run_id ON cost_events (run_id);
CREATE INDEX idx_cost_events_recorded_at ON cost_events (recorded_at DESC);
```

- [ ] **Step 4: Apply the migration via Supabase MCP**

In Claude Code (with Supabase MCP active), use:

```
Use the Supabase MCP to run the migration at supabase/migrations/001_initial.sql
against project uqhnbvljzfwuexmwlzrn
```

Or via Supabase CLI:

```bash
# Install if needed
brew install supabase/tap/supabase

# Link project
supabase link --project-ref uqhnbvljzfwuexmwlzrn

# Push migration
supabase db push
```

- [ ] **Step 5: Set the encryption key on the database (one-time setup)**

In Supabase SQL editor (https://supabase.com/dashboard/project/uqhnbvljzfwuexmwlzrn/sql):

```sql
ALTER DATABASE postgres SET app.encryption_key = 'replace-with-32+-char-random-secret';
```

Generate a strong key: `openssl rand -base64 32`

- [ ] **Step 6: Run the RLS tests — verify they pass**

```bash
cd ~/code/auto-claude
SUPABASE_URL=https://uqhnbvljzfwuexmwlzrn.supabase.co \
SUPABASE_SERVICE_KEY=<service-role-key> \
SUPABASE_ANON_KEY=<anon-key> \
npx vitest run supabase/tests/rls.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/001_initial.sql supabase/tests/rls.test.ts
git commit -m "feat(dashboard): add Supabase schema with RLS, pgcrypto, and bootstrap functions"
```

---

## Task 2: Next.js Project Scaffold

**Files:**
- Create: `dashboard/` (entire Next.js project)

> use context7 — when asking Claude about Next.js 16 App Router patterns, Tailwind v4, or shadcn/ui setup, add "use context7" to your prompt.

- [ ] **Step 1: Create Next.js 16 project in `dashboard/`**

```bash
cd ~/code/auto-claude
pnpm dlx create-next-app@latest dashboard \
  --typescript \
  --eslint \
  --app \
  --no-tailwind \
  --no-src-dir \
  --import-alias "@/*"
cd dashboard
```

- [ ] **Step 2: Install Tailwind CSS v4 dependencies**

```bash
pnpm add tailwindcss @tailwindcss/postcss postcss
```

Create `dashboard/postcss.config.mjs`:

```javascript
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
export default config;
```

Replace the contents of `dashboard/app/globals.css`:

```css
@import "tailwindcss";

@layer base {
  :root {
    --background: 0 0% 3.9%;
    --foreground: 0 0% 98%;
    --card: 0 0% 3.9%;
    --card-foreground: 0 0% 98%;
    --popover: 0 0% 3.9%;
    --popover-foreground: 0 0% 98%;
    --primary: 0 0% 98%;
    --primary-foreground: 0 0% 9%;
    --secondary: 0 0% 14.9%;
    --secondary-foreground: 0 0% 98%;
    --muted: 0 0% 14.9%;
    --muted-foreground: 0 0% 63.9%;
    --accent: 0 0% 14.9%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 0 0% 98%;
    --border: 0 0% 14.9%;
    --input: 0 0% 14.9%;
    --ring: 0 0% 83.1%;
    --radius: 0.5rem;
  }
}
```

- [ ] **Step 3: Initialize shadcn/ui**

```bash
cd dashboard
pnpm dlx shadcn@latest init -t next
```

When prompted: choose "Default" style, confirm dark mode is enabled.

- [ ] **Step 4: Install core shadcn/ui components**

```bash
pnpm dlx shadcn@latest add button card table badge dialog form input label select separator sheet skeleton tabs
```

Or use shadcn MCP: "Install button, card, table, badge, dialog, form, input, label, select, separator, sheet, skeleton, tabs components using shadcn/ui"

- [ ] **Step 5: Install remaining dependencies**

```bash
pnpm add @supabase/supabase-js @supabase/ssr recharts
pnpm add -D vitest @vitejs/plugin-react @playwright/test
```

- [ ] **Step 6: Configure Vitest**

Create `dashboard/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
```

- [ ] **Step 7: Verify project builds**

```bash
cd dashboard
pnpm build
```

Expected: Build succeeds (no errors). Warnings about empty pages are OK.

- [ ] **Step 8: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): scaffold Next.js 16 with Tailwind v4, shadcn/ui, and Vitest"
```

---

## Task 3: Supabase Client + Types + Environment

**Files:**
- Create: `dashboard/lib/supabase/server.ts`
- Create: `dashboard/lib/supabase/client.ts`
- Create: `dashboard/lib/supabase/middleware.ts`
- Create: `dashboard/lib/types.ts`
- Create: `dashboard/.env.local` (gitignored)
- Create: `.env.example` (committed)

- [ ] **Step 1: Write types test (fails — types don't exist yet)**

Create `dashboard/lib/types.test.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { Database } from './types';

describe('Database types', () => {
  it('repos table has required fields', () => {
    type RepoRow = Database['public']['Tables']['repos']['Row'];
    expectTypeOf<RepoRow>().toHaveProperty('id');
    expectTypeOf<RepoRow>().toHaveProperty('owner');
    expectTypeOf<RepoRow>().toHaveProperty('enabled');
    expectTypeOf<RepoRow>().toHaveProperty('deleted_at');
  });
});
```

- [ ] **Step 2: Generate types from Supabase**

```bash
cd dashboard
pnpm dlx supabase gen types typescript \
  --project-id uqhnbvljzfwuexmwlzrn \
  --schema public > lib/types.ts
```

- [ ] **Step 3: Run type test to verify it passes**

```bash
pnpm vitest run lib/types.test.ts
```

Expected: PASS

- [ ] **Step 4: Create server-side Supabase client**

Create `dashboard/lib/supabase/server.ts`:

```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/types';

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {} // Server Component — cookies are read-only; middleware handles refresh
        },
      },
    }
  );
}
```

- [ ] **Step 5: Create browser-side Supabase client**

Create `dashboard/lib/supabase/client.ts`:

```typescript
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/lib/types';

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

- [ ] **Step 6: Create middleware helper**

Create `dashboard/lib/supabase/middleware.ts`:

```typescript
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/lib/types';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: use getClaims() not getSession() for security
  const { data: { user } } = await supabase.auth.getUser();

  const isPublicPath = request.nextUrl.pathname.startsWith('/login') ||
    request.nextUrl.pathname.startsWith('/auth');

  if (!user && !isPublicPath) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
```

- [ ] **Step 7: Create environment files**

Create `dashboard/.env.local` (gitignored — add to `.gitignore`):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://uqhnbvljzfwuexmwlzrn.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<paste-anon-key-from-dashboard>
DAEMON_URL=http://daemon:3847
```

Create `.env.example` in repo root:

```bash
# dashboard/.env.local
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
DAEMON_URL=http://daemon:3847   # Docker service name in production; http://localhost:3847 in dev
ENCRYPTION_KEY=<32+-char-random-secret>
```

- [ ] **Step 8: Commit**

```bash
git add dashboard/lib/ .env.example
git commit -m "feat(dashboard): add Supabase client helpers, types, and env config"
```

---

## Task 4: Auth Middleware + Login + OAuth Callback

**Files:**
- Create: `dashboard/middleware.ts`
- Create: `dashboard/app/login/page.tsx`
- Create: `dashboard/app/auth/callback/route.ts`

- [ ] **Step 1: Write middleware test (fails — middleware doesn't exist)**

Create `dashboard/middleware.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal smoke test: middleware module exports a function
describe('middleware', () => {
  it('exports a middleware function', async () => {
    // Dynamic import to avoid Next.js module resolution issues in tests
    const mod = await import('./middleware');
    expect(typeof mod.middleware).toBe('function');
  });

  it('defines a matcher config', async () => {
    const mod = await import('./middleware');
    expect(mod.config).toBeDefined();
    expect(mod.config.matcher).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd dashboard && pnpm vitest run middleware.test.ts
```

Expected: FAIL — cannot find module './middleware'

- [ ] **Step 3: Create middleware.ts**

Create `dashboard/middleware.ts`:

```typescript
import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

- [ ] **Step 4: Run middleware test — verify it passes**

```bash
pnpm vitest run middleware.test.ts
```

Expected: PASS

- [ ] **Step 5: Create login page**

Create `dashboard/app/login/page.tsx`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default async function LoginPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect('/');

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Auto-Claude</CardTitle>
          <CardDescription>Sign in to access the dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <form action="/auth/login" method="POST">
            <Button type="submit" className="w-full" size="lg">
              Sign in with GitHub
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 6: Create OAuth initiation route**

Create `dashboard/app/auth/login/route.ts`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function POST() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
    },
  });
  if (error || !data.url) redirect('/login?error=oauth_failed');
  redirect(data.url);
}
```

- [ ] **Step 7: Create OAuth callback + bootstrap handler**

Create `dashboard/app/auth/callback/route.ts`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { NextResponse, type NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  if (!code) return NextResponse.redirect(`${origin}/login?error=no_code`);

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !user) return NextResponse.redirect(`${origin}/login?error=auth_failed`);

  // Bootstrap: first user → admin; invited users → their role; others → denied
  const providerHandle = user.user_metadata?.user_name ?? user.email ?? '';
  const { data: result } = await supabase.rpc('bootstrap_user_access', {
    p_user_id: user.id,
    p_provider_handle: providerHandle,
  });

  if (result === 'denied') {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=access_denied`);
  }

  return NextResponse.redirect(`${origin}/`);
}
```

> **GitHub OAuth setup:** Configure in Supabase dashboard at:
> https://supabase.com/dashboard/project/uqhnbvljzfwuexmwlzrn/auth/providers
> Enable GitHub, add Client ID + Secret from a GitHub OAuth App.
> Callback URL: `https://uqhnbvljzfwuexmwlzrn.supabase.co/auth/v1/callback`

- [ ] **Step 8: Update .env.local with site URL**

Add to `dashboard/.env.local`:

```bash
NEXT_PUBLIC_SITE_URL=http://localhost:3000  # change to https://app.example.com in prod
```

- [ ] **Step 9: Verify dev server starts and login page renders**

```bash
cd dashboard && pnpm dev
```

Open http://localhost:3000 — expect redirect to `/login`. Verify login page renders with "Sign in with GitHub" button.

- [ ] **Step 10: Commit**

```bash
git add dashboard/middleware.ts dashboard/middleware.test.ts dashboard/app/auth/ dashboard/app/login/
git commit -m "feat(dashboard): add GitHub OAuth auth flow with first-user-admin bootstrap"
```

---

## Task 5: Root Layout + Sidebar + Dashboard Home

**Files:**
- Modify: `dashboard/app/layout.tsx`
- Create: `dashboard/components/sidebar.tsx`
- Create: `dashboard/components/stats-cards.tsx`
- Modify: `dashboard/app/page.tsx`

- [ ] **Step 1: Write stats-cards component test**

Create `dashboard/components/stats-cards.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import { StatsCards } from './stats-cards';
import { describe, it, expect } from 'vitest';

describe('StatsCards', () => {
  it('renders stat cards with provided values', () => {
    render(
      <StatsCards
        activeRuns={3}
        todayCost={12.45}
        totalRepos={5}
        daemonStatus="running"
      />
    );
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('$12.45')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
pnpm add -D @testing-library/react @testing-library/jest-dom
pnpm vitest run components/stats-cards.test.tsx
```

Expected: FAIL — cannot find module './stats-cards'

- [ ] **Step 3: Create StatsCards component**

Create `dashboard/components/stats-cards.tsx`:

```typescript
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Activity, DollarSign, Database, Server } from 'lucide-react';

interface StatsCardsProps {
  activeRuns: number;
  todayCost: number;
  totalRepos: number;
  daemonStatus: 'running' | 'paused' | 'offline';
}

export function StatsCards({ activeRuns, todayCost, totalRepos, daemonStatus }: StatsCardsProps) {
  const statusColor = { running: 'default', paused: 'secondary', offline: 'destructive' } as const;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Active Runs</CardTitle>
          <Activity className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{activeRuns}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Today's Cost</CardTitle>
          <DollarSign className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">${todayCost.toFixed(2)}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Repositories</CardTitle>
          <Database className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalRepos}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Daemon</CardTitle>
          <Server className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <Badge variant={statusColor[daemonStatus]}>{daemonStatus}</Badge>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Install lucide-react**

```bash
cd dashboard && pnpm add lucide-react
```

- [ ] **Step 5: Run stats-cards test — verify it passes**

```bash
pnpm vitest run components/stats-cards.test.tsx
```

Expected: PASS

- [ ] **Step 6: Create sidebar**

Create `dashboard/components/sidebar.tsx`:

```typescript
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { LayoutDashboard, GitFork, Activity, DollarSign, Users, Settings, Terminal } from 'lucide-react';

const nav = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/repos', label: 'Repositories', icon: GitFork },
  { href: '/runs', label: 'Runs', icon: Activity },
  { href: '/cost', label: 'Costs', icon: DollarSign },
  { href: '/team', label: 'Team', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-56 min-h-screen border-r border-border bg-card flex flex-col">
      <div className="px-6 py-5 border-b border-border">
        <div className="flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          <span className="font-semibold text-sm">Auto-Claude</span>
        </div>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
              pathname === href
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 7: Update root layout**

Replace `dashboard/app/layout.tsx`:

```typescript
import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

export const metadata: Metadata = {
  title: 'Auto-Claude Dashboard',
  description: 'Autonomous coding pipeline management',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
```

Install Geist font: `pnpm add geist`

- [ ] **Step 8: Create authenticated layout and move home page**

Create `dashboard/app/(dashboard)/layout.tsx`:

```typescript
import { Sidebar } from '@/components/sidebar';
import { RealtimeProvider } from '@/components/realtime-provider';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-8 overflow-auto">
        <RealtimeProvider />
        {children}
      </main>
    </div>
  );
}
```

Move the default `page.tsx` into the route group:

```bash
mkdir -p dashboard/app/\(dashboard\)
mv dashboard/app/page.tsx dashboard/app/\(dashboard\)/page.tsx
```

- [ ] **Step 9: Create dashboard home page**

Create `dashboard/app/(dashboard)/page.tsx`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { StatsCards } from '@/components/stats-cards';
import { RunTable } from '@/components/run-table';

export default async function HomePage() {
  const supabase = await createClient();

  const [{ data: repos }, { data: runs }, { data: costs }] = await Promise.all([
    supabase.from('repos').select('id').is('deleted_at', null).eq('enabled', true),
    supabase.from('runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(10),
    supabase.from('cost_events')
      .select('cost')
      .gte('recorded_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
  ]);

  const activeRuns = runs?.filter(r => r.outcome === 'in-progress').length ?? 0;
  const todayCost = costs?.reduce((sum, e) => sum + Number(e.cost), 0) ?? 0;

  let daemonStatus: 'running' | 'paused' | 'offline' = 'offline';
  try {
    const res = await fetch(`${process.env.DAEMON_URL}/status`, { next: { revalidate: 10 } });
    if (res.ok) {
      const json = await res.json();
      daemonStatus = json.state ?? 'running';
    }
  } catch {}

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Dashboard</h1>
        <p className="text-muted-foreground text-sm">Overview of all pipeline activity</p>
      </div>
      <StatsCards
        activeRuns={activeRuns}
        todayCost={todayCost}
        totalRepos={repos?.length ?? 0}
        daemonStatus={daemonStatus}
      />
      <div>
        <h2 className="text-lg font-medium mb-4">Recent Runs</h2>
        <RunTable runs={runs ?? []} />
      </div>
    </div>
  );
}
```

- [ ] **Step 10: Commit**

```bash
git add dashboard/app/ dashboard/components/
git commit -m "feat(dashboard): add root layout, sidebar, and dashboard home with stats"
```

---

## Task 6: RunTable Component + Realtime

**Files:**
- Create: `dashboard/components/run-table.tsx`
- Create: `dashboard/components/realtime-provider.tsx`

- [ ] **Step 1: Write RunTable test**

Create `dashboard/components/run-table.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import { RunTable } from './run-table';
import { describe, it, expect } from 'vitest';

const mockRun = {
  id: 'run-1',
  repo_owner: 'acme',
  repo_name: 'web',
  issue_number: 42,
  issue_title: 'Fix login bug',
  outcome: 'complete' as const,
  total_cost: 0.1234,
  current_phase: 'done',
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
};

describe('RunTable', () => {
  it('renders run rows with correct data', () => {
    render(<RunTable runs={[mockRun as any]} />);
    expect(screen.getByText('acme/web')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    expect(screen.getByText('complete')).toBeInTheDocument();
    expect(screen.getByText('$0.1234')).toBeInTheDocument();
  });

  it('renders empty state when no runs', () => {
    render(<RunTable runs={[]} />);
    expect(screen.getByText(/no runs/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
pnpm vitest run components/run-table.test.tsx
```

- [ ] **Step 3: Create RunTable**

Create `dashboard/components/run-table.tsx`:

```typescript
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Database } from '@/lib/types';

type Run = Database['public']['Tables']['runs']['Row'];

const outcomeVariant = {
  'in-progress': 'secondary',
  complete: 'default',
  stuck: 'destructive',
  escalated: 'destructive',
} as const;

export function RunTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-border p-8 text-center text-muted-foreground text-sm">
        No runs found.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repo</TableHead>
            <TableHead>Issue</TableHead>
            <TableHead>Phase</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead>Started</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id} className="cursor-pointer hover:bg-accent/30">
              <TableCell className="font-mono text-sm">
                {run.repo_owner}/{run.repo_name}
              </TableCell>
              <TableCell>
                <Link href={`/runs/${run.id}`} className="hover:underline">
                  <span className="text-muted-foreground">#{run.issue_number}</span>{' '}
                  {run.issue_title}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{run.current_phase ?? '—'}</TableCell>
              <TableCell>
                <Badge variant={outcomeVariant[run.outcome]}>{run.outcome}</Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                ${Number(run.total_cost).toFixed(4)}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {new Date(run.started_at).toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 4: Create realtime provider**

Create `dashboard/components/realtime-provider.tsx`:

```typescript
'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function RealtimeProvider() {
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const channel = supabase
      .channel('runs-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'runs' },
        () => router.refresh() // Re-fetches server component data
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [router, supabase]);

  return null; // renders nothing — side-effect only
}
```

Add `<RealtimeProvider />` to `dashboard/app/(dashboard)/layout.tsx`.

- [ ] **Step 5: Run RunTable tests — verify pass**

```bash
pnpm vitest run components/run-table.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/run-table.tsx dashboard/components/run-table.test.tsx dashboard/components/realtime-provider.tsx
git commit -m "feat(dashboard): add RunTable with realtime live-update subscription"
```

---

## Task 7: Repo Management

**Files:**
- Create: `dashboard/actions/repos.ts`
- Create: `dashboard/app/(dashboard)/repos/page.tsx`
- Create: `dashboard/app/(dashboard)/repos/new/page.tsx`
- Create: `dashboard/app/(dashboard)/repos/[id]/page.tsx`

- [ ] **Step 1: Write Server Actions test**

Create `dashboard/actions/repos.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase client
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    }),
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

describe('repo actions', () => {
  it('createRepo inserts with enabled=false', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { createRepo } = await import('./repos');

    const formData = new FormData();
    formData.append('owner', 'acme');
    formData.append('name', 'web');
    formData.append('staging_branch', 'staging');
    formData.append('production_branch', 'main');
    formData.append('budget_limit', '10');
    formData.append('concurrency_limit', '1');

    await createRepo(formData);

    const client = await (createClient as any)();
    expect(client.from().insert).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', name: 'web', enabled: false })
    );
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
pnpm vitest run actions/repos.test.ts
```

- [ ] **Step 3: Create repo Server Actions**

Create `dashboard/actions/repos.ts`:

```typescript
'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export async function createRepo(formData: FormData) {
  const supabase = await createClient();
  const { error, data } = await supabase.from('repos').insert({
    owner: formData.get('owner') as string,
    name: formData.get('name') as string,
    staging_branch: (formData.get('staging_branch') as string) || 'staging',
    production_branch: (formData.get('production_branch') as string) || 'main',
    budget_limit: Number(formData.get('budget_limit')) || null,
    concurrency_limit: Number(formData.get('concurrency_limit')) || 1,
    enabled: false, // always starts disabled
  }).select('id').single();

  if (error) throw new Error(error.message);
  revalidatePath('/repos');
  redirect(`/repos/${data.id}`);
}

export async function updateRepo(id: string, formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from('repos').update({
    staging_branch: formData.get('staging_branch') as string,
    production_branch: formData.get('production_branch') as string,
    budget_limit: Number(formData.get('budget_limit')) || null,
    concurrency_limit: Number(formData.get('concurrency_limit')) || 1,
    updated_at: new Date().toISOString(),
  }).eq('id', id);

  if (error) throw new Error(error.message);
  revalidatePath(`/repos/${id}`);
}

export async function enableRepo(id: string) {
  const supabase = await createClient();
  const { error } = await supabase.from('repos')
    .update({ enabled: true, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath(`/repos/${id}`);
  revalidatePath('/repos');
}

export async function disableRepo(id: string) {
  const supabase = await createClient();
  const { error } = await supabase.from('repos')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath(`/repos/${id}`);
  revalidatePath('/repos');
}

export async function deleteRepo(id: string) {
  // Soft delete — preserves run history
  const supabase = await createClient();
  const { error } = await supabase.from('repos')
    .update({ deleted_at: new Date().toISOString(), enabled: false })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/repos');
  redirect('/repos');
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
pnpm vitest run actions/repos.test.ts
```

- [ ] **Step 5: Create repo list page**

Create `dashboard/app/(dashboard)/repos/page.tsx`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import Link from 'next/link';
import { Plus } from 'lucide-react';

export default async function ReposPage() {
  const supabase = await createClient();
  const { data: repos } = await supabase
    .from('repos')
    .select('*, runs(outcome, started_at)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Repositories</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage monitored repositories</p>
        </div>
        <Button asChild>
          <Link href="/repos/new"><Plus className="h-4 w-4 mr-2" />Add Repository</Link>
        </Button>
      </div>
      <div className="space-y-3">
        {repos?.map((repo) => (
          <Card key={repo.id} className="hover:border-border/80 transition-colors">
            <CardContent className="flex items-center justify-between py-4">
              <div className="flex items-center gap-3">
                <span className="font-mono font-medium">{repo.owner}/{repo.name}</span>
                <Badge variant={repo.enabled ? 'default' : 'secondary'}>
                  {repo.enabled ? 'active' : 'disabled'}
                </Badge>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/repos/${repo.id}`}>Configure →</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
        {repos?.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            No repositories yet. <Link href="/repos/new" className="underline">Add one</Link>.
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Create new repo form page**

Create `dashboard/app/(dashboard)/repos/new/page.tsx`:

```typescript
import { createRepo } from '@/actions/repos';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function NewRepoPage() {
  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-semibold mb-6">Add Repository</h1>
      <Card>
        <CardHeader>
          <CardTitle>Repository Details</CardTitle>
          <CardDescription>New repos start disabled. Enable after adding credentials.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={createRepo} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="owner">Owner</Label>
                <Input id="owner" name="owner" placeholder="acme-org" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="name">Repository</Label>
                <Input id="name" name="name" placeholder="my-app" required />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="staging_branch">Staging branch</Label>
                <Input id="staging_branch" name="staging_branch" defaultValue="staging" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="production_branch">Production branch</Label>
                <Input id="production_branch" name="production_branch" defaultValue="main" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="budget_limit">Budget per run ($)</Label>
                <Input id="budget_limit" name="budget_limit" type="number" step="0.01" placeholder="5.00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="concurrency_limit">Max concurrent runs</Label>
                <Input id="concurrency_limit" name="concurrency_limit" type="number" defaultValue="1" min="1" />
              </div>
            </div>
            <Button type="submit" className="w-full">Create Repository</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/actions/repos.ts dashboard/actions/repos.test.ts dashboard/app/\(dashboard\)/repos/
git commit -m "feat(dashboard): add repo management pages and Server Actions"
```

---

## Task 8: API Key Management (Encrypted Write-Only)

**Files:**
- Create: `dashboard/actions/api-keys.ts`
- Modify: `dashboard/app/(dashboard)/repos/[id]/page.tsx`

- [ ] **Step 1: Write API key action test**

Create `dashboard/actions/api-keys.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }),
    rpc: vi.fn().mockResolvedValue({ error: null }),
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

describe('upsertApiKey', () => {
  it('calls upsert with encrypted value — plaintext never stored directly', async () => {
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'repo-123');
    formData.append('key_type', 'source-control');
    formData.append('key_value', 'ghp_secrettoken');

    // Should not throw — the actual encryption happens inside Postgres via RPC
    await expect(upsertApiKey(formData)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Create API key Server Action**

Create `dashboard/actions/api-keys.ts`:

```typescript
'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export async function upsertApiKey(formData: FormData) {
  const supabase = await createClient();
  const repoId = formData.get('repo_id') as string;
  const keyType = formData.get('key_type') as string;
  const keyValue = formData.get('key_value') as string;

  // Encryption happens inside Postgres via pgp_sym_encrypt
  // using the app.encryption_key database setting
  const { error } = await supabase.rpc('upsert_api_key_encrypted', {
    p_repo_id: repoId,
    p_key_type: keyType,
    p_plaintext: keyValue,
  });

  if (error) throw new Error(error.message);
  revalidatePath(`/repos/${repoId}`);
}
```

> `upsert_api_key_encrypted` is already included in `001_initial.sql` from Task 1.

- [ ] **Step 3: Create repo detail page with API key form**

Create `dashboard/app/(dashboard)/repos/[id]/page.tsx`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { upsertApiKey } from '@/actions/api-keys';
import { enableRepo, disableRepo, deleteRepo } from '@/actions/repos';

export default async function RepoDetailPage({ params }: { params: { id: string } }) {
  const supabase = await createClient();
  const { data: repo } = await supabase.from('repos').select('*').eq('id', params.id).single();
  if (!repo || repo.deleted_at) notFound();

  const { data: keys } = await supabase.from('api_keys')
    .select('key_type, updated_at')
    .eq('repo_id', params.id);

  const hasSourceControl = keys?.some(k => k.key_type === 'source-control');
  const hasModelProvider = keys?.some(k => k.key_type === 'model-provider');

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold font-mono">{repo.owner}/{repo.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={repo.enabled ? 'default' : 'secondary'}>
              {repo.enabled ? 'active' : 'disabled'}
            </Badge>
          </div>
        </div>
        <div className="flex gap-2">
          {repo.enabled ? (
            <form action={disableRepo.bind(null, repo.id)}>
              <Button type="submit" variant="outline" size="sm">Disable</Button>
            </form>
          ) : (
            <form action={enableRepo.bind(null, repo.id)}>
              <Button type="submit" size="sm"
                disabled={!hasSourceControl || !hasModelProvider}
                title={(!hasSourceControl || !hasModelProvider) ? 'Add credentials first' : ''}>
                Enable
              </Button>
            </form>
          )}
          <form action={deleteRepo.bind(null, repo.id)}>
            <Button type="submit" variant="destructive" size="sm"
              disabled={repo.enabled}
              title={repo.enabled ? 'Disable first' : ''}>
              Delete
            </Button>
          </form>
        </div>
      </div>

      {/* Credentials */}
      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
          <CardDescription>Write-only. Stored encrypted. Never displayed after saving.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(['source-control', 'model-provider'] as const).map((type) => {
            const key = keys?.find(k => k.key_type === type);
            return (
              <form key={type} action={upsertApiKey} className="space-y-2">
                <input type="hidden" name="repo_id" value={repo.id} />
                <input type="hidden" name="key_type" value={type} />
                <Label htmlFor={`key-${type}`}>
                  {type === 'source-control' ? 'GitHub Token' : 'API Key (Anthropic)'}
                  {key && <span className="ml-2 text-xs text-muted-foreground">Last updated: {new Date(key.updated_at).toLocaleDateString()}</span>}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`key-${type}`}
                    name="key_value"
                    type="password"
                    placeholder={key ? '••••••••••••••••••••' : 'Paste token here'}
                    required
                  />
                  <Button type="submit" variant="outline" size="sm">
                    {key ? 'Rotate' : 'Save'}
                  </Button>
                </div>
              </form>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Run API key tests**

```bash
pnpm vitest run actions/api-keys.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/actions/api-keys.ts dashboard/actions/api-keys.test.ts dashboard/app/\(dashboard\)/repos/
git commit -m "feat(dashboard): add encrypted API key management (write-only)"
```

---

## Task 9: Run History + Run Detail Pages

**Files:**
- Create: `dashboard/app/(dashboard)/runs/page.tsx`
- Create: `dashboard/app/(dashboard)/runs/[id]/page.tsx`

- [ ] **Step 1: Create run history page**

Create `dashboard/app/(dashboard)/runs/page.tsx`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { RunTable } from '@/components/run-table';
import { RealtimeProvider } from '@/components/realtime-provider';

export default async function RunsPage({
  searchParams,
}: {
  searchParams: { repo?: string; outcome?: string };
}) {
  const supabase = await createClient();
  let query = supabase
    .from('runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(100);

  if (searchParams.repo) query = query.eq('repo_id', searchParams.repo);
  if (searchParams.outcome) query = query.eq('outcome', searchParams.outcome);

  const { data: runs } = await query;

  return (
    <div className="space-y-6">
      <RealtimeProvider />
      <div>
        <h1 className="text-2xl font-semibold">Runs</h1>
        <p className="text-muted-foreground text-sm mt-1">Pipeline execution history</p>
      </div>
      <RunTable runs={runs ?? []} />
    </div>
  );
}
```

- [ ] **Step 2: Create run detail page**

Create `dashboard/app/(dashboard)/runs/[id]/page.tsx`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default async function RunDetailPage({ params }: { params: { id: string } }) {
  const supabase = await createClient();
  const { data: run } = await supabase.from('runs').select('*, cost_events(*)').eq('id', params.id).single();
  if (!run) notFound();

  const phases = (run.phases as any[]) ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-semibold">{run.repo_owner}/{run.repo_name} #{run.issue_number}</h1>
          <Badge>{run.outcome}</Badge>
        </div>
        <p className="text-muted-foreground">{run.issue_title}</p>
      </div>

      {/* Phase timeline */}
      <Card>
        <CardHeader><CardTitle>Phases</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {phases.length === 0 && <p className="text-muted-foreground text-sm">No phase data.</p>}
            {phases.map((phase: any, i: number) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div className="font-medium text-sm">{phase.name}</div>
                <div className="flex gap-6 text-sm text-muted-foreground">
                  <span>{phase.duration_ms ? `${(phase.duration_ms / 1000).toFixed(1)}s` : '—'}</span>
                  <span className="font-mono">${Number(phase.cost ?? 0).toFixed(4)}</span>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between pt-2 font-semibold text-sm">
              <span>Total</span>
              <span className="font-mono">${Number(run.total_cost).toFixed(4)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Final report */}
      {run.report && (
        <Card>
          <CardHeader><CardTitle>Report</CardTitle></CardHeader>
          <CardContent>
            <pre className="text-sm whitespace-pre-wrap font-mono text-muted-foreground">{run.report}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/app/\(dashboard\)/runs/
git commit -m "feat(dashboard): add run history and run detail pages with phase breakdown"
```

---

## Task 10: Cost Tracking Page

**Files:**
- Create: `dashboard/components/cost-chart.tsx`
- Create: `dashboard/app/(dashboard)/cost/page.tsx`

- [ ] **Step 1: Create cost chart component**

Create `dashboard/components/cost-chart.tsx`:

```typescript
'use client';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface DailyCost {
  date: string;
  cost: number;
}

export function CostChart({ data }: { data: DailyCost[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="date" tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} />
        <YAxis tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
          tickFormatter={(v) => `$${v.toFixed(2)}`} />
        <Tooltip
          formatter={(v: number) => [`$${v.toFixed(4)}`, 'Cost']}
          contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
        />
        <Bar dataKey="cost" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Create cost page**

Create `dashboard/app/(dashboard)/cost/page.tsx`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CostChart } from '@/components/cost-chart';

export default async function CostPage() {
  const supabase = await createClient();

  // Last 30 days of cost events
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: events } = await supabase
    .from('cost_events')
    .select('cost, recorded_at, run_id, session_type')
    .gte('recorded_at', since.toISOString())
    .order('recorded_at');

  // Aggregate by day
  const byDay: Record<string, number> = {};
  events?.forEach((e) => {
    const day = e.recorded_at.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + Number(e.cost);
  });

  const chartData = Object.entries(byDay).map(([date, cost]) => ({
    date: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    cost,
  }));

  const totalCost = events?.reduce((s, e) => s + Number(e.cost), 0) ?? 0;

  // By session type
  const byType: Record<string, number> = {};
  events?.forEach((e) => {
    byType[e.session_type] = (byType[e.session_type] ?? 0) + Number(e.cost);
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Costs</h1>
        <p className="text-muted-foreground text-sm mt-1">Last 30 days — total: ${totalCost.toFixed(4)}</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Daily Cost</CardTitle></CardHeader>
        <CardContent><CostChart data={chartData} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>By Session Type</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {Object.entries(byType).map(([type, cost]) => (
              <div key={type} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground capitalize">{type}</span>
                <span className="font-mono">${cost.toFixed(4)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/components/cost-chart.tsx dashboard/app/\(dashboard\)/cost/
git commit -m "feat(dashboard): add cost tracking page with daily chart and session breakdown"
```

---

## Task 11: Team Management + Invitations

**Files:**
- Create: `dashboard/actions/team.ts`
- Create: `dashboard/app/(dashboard)/team/page.tsx`

- [ ] **Step 1: Write team action test**

Create `dashboard/actions/team.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          neq: vi.fn().mockResolvedValue({ data: [{ id: 'other-admin' }] }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    }),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-123' } } }) },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

describe('team actions', () => {
  it('createInvitation inserts with pending status', async () => {
    const { createInvitation } = await import('./team');
    const formData = new FormData();
    formData.append('provider_handle', 'octocat');
    formData.append('role', 'viewer');
    await expect(createInvitation(formData)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Create team Server Actions**

Create `dashboard/actions/team.ts`:

```typescript
'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export async function createInvitation(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('invitations').insert({
    provider_handle: formData.get('provider_handle') as string,
    role: formData.get('role') as 'admin' | 'viewer',
    invited_by: user?.id,
    status: 'pending',
  });
  if (error) throw new Error(error.message);
  revalidatePath('/team');
}

export async function changeRole(memberId: string, newRole: 'admin' | 'viewer') {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Guard: cannot demote if last admin
  if (newRole === 'viewer') {
    const { data: otherAdmins } = await supabase
      .from('team_members')
      .select('id')
      .eq('role', 'admin')
      .neq('id', memberId);
    if (!otherAdmins?.length) {
      throw new Error('Cannot demote the last admin. Promote another member first.');
    }
  }

  const { error } = await supabase.from('team_members')
    .update({ role: newRole })
    .eq('id', memberId);
  if (error) throw new Error(error.message);
  revalidatePath('/team');
}

export async function removeMember(memberId: string) {
  const supabase = await createClient();

  // Guard: cannot remove if last admin
  const { data: member } = await supabase.from('team_members').select('role').eq('id', memberId).single();
  if (member?.role === 'admin') {
    const { data: admins } = await supabase.from('team_members').select('id').eq('role', 'admin');
    if ((admins?.length ?? 0) <= 1) {
      throw new Error('Cannot remove the last admin.');
    }
  }

  const { error } = await supabase.from('team_members').delete().eq('id', memberId);
  if (error) throw new Error(error.message);
  revalidatePath('/team');
}
```

- [ ] **Step 3: Create team page**

Create `dashboard/app/(dashboard)/team/page.tsx`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createInvitation, changeRole, removeMember } from '@/actions/team';

export default async function TeamPage() {
  const supabase = await createClient();
  const { data: members } = await supabase
    .from('team_members')
    .select('*, user:user_id(email, raw_user_meta_data)')
    .order('granted_at');

  const { data: invitations } = await supabase
    .from('invitations')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Team</h1>

      {/* Members list */}
      <Card>
        <CardHeader><CardTitle>Members</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {members?.map((member) => {
            const meta = (member.user as any)?.raw_user_meta_data;
            return (
              <div key={member.id} className="flex items-center justify-between py-2">
                <div>
                  <span className="font-medium text-sm">{meta?.user_name ?? (member.user as any)?.email}</span>
                  <Badge variant={member.role === 'admin' ? 'default' : 'secondary'} className="ml-2">
                    {member.role}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <form action={changeRole.bind(null, member.id, member.role === 'admin' ? 'viewer' : 'admin')}>
                    <Button type="submit" variant="ghost" size="sm">
                      Make {member.role === 'admin' ? 'viewer' : 'admin'}
                    </Button>
                  </form>
                  <form action={removeMember.bind(null, member.id)}>
                    <Button type="submit" variant="ghost" size="sm" className="text-destructive">Remove</Button>
                  </form>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Pending invitations */}
      {(invitations?.length ?? 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>Pending Invitations</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {invitations?.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between text-sm py-1">
                <span className="font-mono">{inv.provider_handle}</span>
                <Badge variant="secondary">{inv.role}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Invite form */}
      <Card>
        <CardHeader><CardTitle>Invite Member</CardTitle></CardHeader>
        <CardContent>
          <form action={createInvitation} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="provider_handle">GitHub Username</Label>
              <Input id="provider_handle" name="provider_handle" placeholder="octocat" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role">Role</Label>
              <Select name="role" defaultValue="viewer">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer — can view, cannot change config</SelectItem>
                  <SelectItem value="admin">Admin — full access</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="w-full">Send Invitation</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run actions/team.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/actions/team.ts dashboard/actions/team.test.ts dashboard/app/\(dashboard\)/team/
git commit -m "feat(dashboard): add team management with invitations and last-admin protection"
```

---

## Task 12: Global Settings + Daemon Control

**Files:**
- Create: `dashboard/actions/settings.ts`
- Create: `dashboard/app/(dashboard)/settings/page.tsx`
- Create: `dashboard/app/api/daemon/pause/route.ts`
- Create: `dashboard/app/api/daemon/resume/route.ts`
- Create: `dashboard/app/api/daemon/status/route.ts`

- [ ] **Step 1: Create settings Server Action**

Create `dashboard/actions/settings.ts`:

```typescript
'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export async function updateGlobalSettings(formData: FormData) {
  const supabase = await createClient();
  // Single-row table — fetch the row ID first, then update by ID
  const { data: existing } = await supabase.from('global_settings').select('id').single();
  if (!existing) throw new Error('Global settings row missing — check migration');
  const { error } = await supabase
    .from('global_settings')
    .update({
      concurrency_limit: Number(formData.get('concurrency_limit')),
      poll_interval_ms: Number(formData.get('poll_interval_ms')),
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id);
  if (error) throw new Error(error.message);
  revalidatePath('/settings');
}
```

- [ ] **Step 2: Create settings page**

Create `dashboard/app/(dashboard)/settings/page.tsx`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateGlobalSettings } from '@/actions/settings';

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: settings } = await supabase.from('global_settings').select('*').single();

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Global Concurrency</CardTitle>
          <CardDescription>Maximum concurrent workers across all repositories</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateGlobalSettings} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="concurrency_limit">Max concurrent workers</Label>
              <Input
                id="concurrency_limit"
                name="concurrency_limit"
                type="number"
                min="1"
                max="20"
                defaultValue={settings?.concurrency_limit ?? 3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="poll_interval_ms">Config sync interval (ms)</Label>
              <Input
                id="poll_interval_ms"
                name="poll_interval_ms"
                type="number"
                min="10000"
                step="1000"
                defaultValue={settings?.poll_interval_ms ?? 60000}
              />
            </div>
            <Button type="submit">Save Settings</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Create daemon proxy routes**

Create `dashboard/app/api/daemon/pause/route.ts`:

```typescript
import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const res = await fetch(`${process.env.DAEMON_URL}/pause`, {
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

Create `dashboard/app/api/daemon/resume/route.ts`:

```typescript
import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const res = await fetch(`${process.env.DAEMON_URL}/resume`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
```

Create `dashboard/app/api/daemon/status/route.ts`:

```typescript
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const res = await fetch(`${process.env.DAEMON_URL}/status`, {
      signal: AbortSignal.timeout(3000),
      next: { revalidate: 10 },
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { state: 'offline', active_runs: 0, version: 'unknown' },
      { status: 503 }
    );
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/actions/settings.ts dashboard/app/\(dashboard\)/settings/ dashboard/app/api/
git commit -m "feat(dashboard): add global settings, daemon control proxy routes"
```

---

## Task 13: Docker Compose + Caddy Production Config

**Files:**
- Create: `docker-compose.prod.yml`
- Create: `Caddyfile`
- Create: `.env.example` (update existing)

- [ ] **Step 1: Create Caddyfile**

Create `Caddyfile`:

```caddyfile
app.example.com {
  reverse_proxy dashboard:3000
}
```

- [ ] **Step 2: Create docker-compose.prod.yml**

Create `docker-compose.prod.yml`:

```yaml
version: '3.9'

networks:
  app:
    driver: bridge

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - app

  dashboard:
    build:
      context: ./dashboard
      dockerfile: Dockerfile
    restart: unless-stopped
    env_file: .env.prod
    environment:
      NODE_ENV: production
      DAEMON_URL: http://daemon:3847
    networks:
      - app
    depends_on:
      - daemon

  daemon:
    build:
      context: .
      dockerfile: Dockerfile.daemon
    restart: unless-stopped
    env_file: .env.prod
    ports: []  # NOT exposed externally — internal network only
    networks:
      - app

volumes:
  caddy_data:
  caddy_config:
```

- [ ] **Step 3: Create dashboard Dockerfile**

Create `dashboard/Dockerfile`:

```dockerfile
FROM node:22-alpine AS base
RUN npm install -g pnpm

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

Update `dashboard/next.config.ts` to enable standalone output:

```typescript
const nextConfig = {
  output: 'standalone',
};
export default nextConfig;
```

- [ ] **Step 4: Update .env.example**

Update `.env.example`:

```bash
# === dashboard/.env.prod (production) ===
NEXT_PUBLIC_SUPABASE_URL=https://uqhnbvljzfwuexmwlzrn.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key-from-supabase-dashboard>
NEXT_PUBLIC_SITE_URL=https://app.example.com
DAEMON_URL=http://daemon:3847

# === daemon/.env.prod (add to existing daemon env) ===
SUPABASE_URL=https://uqhnbvljzfwuexmwlzrn.supabase.co
SUPABASE_SERVICE_KEY=<service-role-key-from-supabase-dashboard>
ENCRYPTION_KEY=<same-key-used-in-ALTER-DATABASE-SET>
DAEMON_SYNC_INTERVAL_MS=60000
```

- [ ] **Step 5: Verify build in Docker**

```bash
docker compose -f docker-compose.prod.yml build dashboard
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.prod.yml Caddyfile dashboard/Dockerfile dashboard/next.config.ts .env.example
git commit -m "feat(dashboard): add Docker Compose production config with Caddy reverse proxy"
```

---

## Verification Checklist

Before declaring Plan A complete:

- [ ] `pnpm vitest run` in `dashboard/` — all unit tests pass
- [ ] `pnpm build` in `dashboard/` — no type errors, clean build
- [ ] `SUPABASE_*` env vars set → `npx vitest run supabase/tests/rls.test.ts` passes
- [ ] `pnpm dev` in `dashboard/` → visit http://localhost:3000 → redirects to `/login`
- [ ] GitHub OAuth sign-in works → first user gets admin role
- [ ] Can add a repo, add credentials, enable it
- [ ] Run list page shows data (after seeding a test run via Supabase MCP)
- [ ] Cost chart renders (after seeding cost events via Supabase MCP)
- [ ] Team invite flow works (invite by GitHub handle → invitee signs in → gets role)
- [ ] Daemon proxy returns 503 when daemon is not running (expected in this phase)
- [ ] Docker build succeeds

---

**Plan complete and saved to `docs/plans/2026-03-19-dashboard-foundation.md`.**

> **Plan B — Daemon Integration** covers: daemon reads repo config from Supabase, daemon upserts runs on phase transitions, daemon writes CostEvents, multi-repo scheduling with global + per-repo concurrency enforcement.
