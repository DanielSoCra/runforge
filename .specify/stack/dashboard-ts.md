---
id: STACK-AC-DASHBOARD
type: stack-specific
domain: auto-claude
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-DASHBOARD
code_paths:
  - dashboard/
  - supabase/
test_paths:
  - dashboard/**/*.test.ts
  - dashboard/**/*.test.tsx
  - supabase/tests/**/*.test.ts
---

# STACK-AC-DASHBOARD — Dashboard (TypeScript)

## Pattern

**Next.js App Router with Supabase.** Server components for data fetching, Server Actions for mutations, API routes only for daemon proxy. Supabase client for auth and database. The dashboard is a separate Next.js project in a `dashboard/` directory alongside the daemon `src/`.

**Supabase as backend.** Supabase provides: Postgres database, GitHub OAuth via Supabase Auth, Row Level Security for access control, Realtime subscriptions for live updates, and encrypted column support for API keys. Server Actions replace REST API routes for all database mutations — no custom API layer needed for Supabase operations.

**Docker Compose for deployment.** Three services: Caddy (reverse proxy + HTTPS), Next.js dashboard, Auto-Claude daemon. All three run on a shared Docker network. Caddy routes `app.example.com` to the Next.js container. The dashboard reaches the daemon via Docker service name resolution (e.g., `http://daemon:3847`).

## Key Decisions

**Framework: Next.js 16 (App Router).** Server components reduce client-side JavaScript. Server Actions handle all Supabase mutations without custom API routes. API routes are kept only for daemon proxy (`/api/daemon/*`). Built-in middleware for auth checks.

**Auth: Supabase Auth with GitHub OAuth.** `@supabase/ssr` handles server-side auth in Next.js. GitHub OAuth configured in Supabase dashboard. Session stored in httpOnly secure cookies. Middleware refreshes session on every request via `updateSession`.

**Database: Supabase Postgres with Row Level Security.** Tables: `global_settings`, `repos`, `api_keys`, `invitations`, `team_members`, `runs`, `cost_events`. RLS policies enforce role-based access. The `api_keys.encrypted_value` column uses `pgcrypto` for at-rest encryption.

**Credential decryption: SECURITY DEFINER RPC.** API keys are encrypted with `pgp_sym_encrypt`. The daemon decrypts via a dedicated Postgres function (`decrypt_api_key`) defined as `SECURITY DEFINER` and callable only by the daemon's service-role. This keeps the encryption key out of the dashboard runtime entirely.

**Realtime: Supabase Realtime.** Subscribe to the `runs` table for live dashboard updates. The daemon upserts a Run record on each phase transition, so in-progress runs update live.

**Daemon connectivity: Docker service name.** The dashboard container reaches the daemon via `http://daemon:3847` on the shared Docker network — not `localhost` or `host.docker.internal`, which do not work between containers.

**Config sync interval: 60 seconds.** Daemon polls Supabase for repo config every 60 seconds. This is configurable via `DAEMON_SYNC_INTERVAL_MS` env var.

**Styling: Tailwind CSS v4 + shadcn/ui.** Tailwind v4 for utility-first styling. shadcn/ui for pre-built accessible components (tables, cards, dialogs, forms). Dark theme by default.

**Charts: Recharts.** Lightweight React charting library for cost charts.

**Reverse proxy: Caddy.** Automatic HTTPS via Let's Encrypt. Config is 5 lines. Secrets passed via env files excluded from version control — never inline in docker-compose YAML.

**Daemon sync: Supabase JS client in daemon.** The daemon uses `@supabase/supabase-js` with a service-role key to read repo configs and write run results. The service-role key bypasses RLS — stored only as a server-side environment variable, never exposed to the browser.

## Key Versions

- Next.js: 16.x
- Tailwind CSS: 4.x
- `@supabase/ssr`: latest stable
- `@supabase/supabase-js`: latest stable
- shadcn/ui: latest stable
- Recharts: latest stable

## Examples

```typescript
// Supabase server client (Next.js server component / Server Action)
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: { getAll: () => cookieStore.getAll() },
  });
}
```

```typescript
// Next.js 16: entry file is proxy.ts, exported function is proxy (not middleware)
import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';

export async function proxy(request) {
  const { supabase, response } = createServerClient(/* ... */);
  await supabase.auth.getUser(); // refresh session
  return response;
}
```

```typescript
// Server Action for Supabase mutations (no API route needed)
'use server';
export async function createRepo(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from('repos').insert({
    owner: formData.get('owner'),
    name: formData.get('name'),
    enabled: false, // always starts disabled
  });
  if (error) throw new Error(error.message);
  revalidatePath('/repos');
}
```

```typescript
// Realtime subscription (client component)
const supabase = createBrowserClient(URL, ANON_KEY);
supabase.channel('runs').on('postgres_changes',
  { event: '*', schema: 'public', table: 'runs' },
  (payload) => setRuns((prev) => updateRun(prev, payload))
).subscribe();
```

```typescript
// Daemon proxy API route (Next.js route handler)
// Only API routes needed — daemon commands can't use Server Actions
export async function POST() {
  const res = await fetch('http://daemon:3847/pause', { method: 'POST' });
  return Response.json(await res.json(), { status: res.status });
}
```

```sql
-- Atomic first-user-is-admin + invitation acceptance: Postgres function called on auth callback
-- Returns: 'admin' | 'viewer' | 'denied'
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

  -- Check for pending invitation (deterministic: oldest first; update only that row)
  DECLARE v_inv_id uuid;
  SELECT id, role INTO v_inv_id, v_role FROM invitations
  WHERE provider_handle = p_provider_handle
    AND status = 'pending'
    AND expires_at > now()
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_role IS NULL THEN
    RETURN 'denied';
  END IF;

  INSERT INTO team_members (user_id, role) VALUES (p_user_id, v_role);
  UPDATE invitations SET status = 'accepted' WHERE id = v_inv_id;
  RETURN v_role::text;
END;
$$;
```

```sql
-- Dashboard WRITES via SECURITY DEFINER RPC (never direct table write)
-- The Server Action calls supabase.rpc('upsert_api_key_encrypted', {...})
CREATE OR REPLACE FUNCTION upsert_api_key_encrypted(
  p_repo_id uuid, p_key_type text, p_plaintext text
) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO api_keys (repo_id, key_type, encrypted_value, updated_at)
  VALUES (p_repo_id, p_key_type, pgp_sym_encrypt(p_plaintext, current_setting('app.encryption_key')), now())
  ON CONFLICT (repo_id, key_type) DO UPDATE
    SET encrypted_value = EXCLUDED.encrypted_value, updated_at = now();
$$;
-- Revoke from public; grant only to dashboard anon/service role

-- Daemon READS via SECURITY DEFINER function (never raw pgp_sym_decrypt)
CREATE OR REPLACE FUNCTION decrypt_api_key(p_repo_id uuid, p_key_type text)
RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT pgp_sym_decrypt(encrypted_value, current_setting('app.encryption_key'))
  FROM api_keys WHERE repo_id = p_repo_id AND key_type = p_key_type;
$$;
-- Daemon calls: SELECT decrypt_api_key($1, $2)
-- The app.encryption_key setting is loaded by the DB at session start via ALTER DATABASE SET
```

## Gotchas

- **Next.js 16 renamed Middleware to Proxy.** The file is `proxy.ts` (not `middleware.ts`) and the exported function is `proxy` (not `middleware`). The Supabase SSR helper in `lib/supabase/middleware.ts` keeps its name — only the Next.js entry file changed.
- Supabase Auth cookies must be refreshed in the proxy on every request. Use the `@supabase/ssr` `updateSession` pattern — stale cookies cause silent auth failures.
- The service-role key (used by the daemon) bypasses ALL RLS policies. Never expose it to the browser. Store it only as a server-side environment variable in `.env.prod` (excluded from version control). Never inline secrets in `docker-compose.prod.yml`.
- `pgp_sym_encrypt` requires the `pgcrypto` extension: `CREATE EXTENSION IF NOT EXISTS pgcrypto` in the first migration.
- The `decrypt_api_key` function must be `SECURITY DEFINER` so only the Postgres role can access it. Revoke `EXECUTE` from `public`; grant only to the service-role.
- Supabase Realtime only broadcasts changes to rows the client can SELECT via RLS. Ensure viewer RLS policies allow reading the `runs` table.
- **Docker networking:** The dashboard container uses `http://daemon:3847` to reach the daemon — not `localhost` (which refers to the container itself) and not `host.docker.internal` (unreliable and not needed). Ensure both services are on the same Docker network in `docker-compose.prod.yml`.
- Caddy's automatic HTTPS requires ports 80 and 443 open. Hetzner firewall must allow inbound HTTP/HTTPS from anywhere for cert provisioning.
- The first-user-is-admin logic must be atomic. Use the `bootstrap_user_access` Postgres function shown in Examples — do not implement this in application code with separate SELECT + INSERT. The function returns `'admin'`, `'viewer'`, or `'denied'` so the auth callback can redirect accordingly.
- RLS test coverage: the `supabase/tests/` directory must include integration tests that verify admin can read/write all tables, viewer can only read, and unauthenticated requests are rejected.
- Repos always start with `enabled: false`. The UI should guide the admin through: create repo → add credentials → enable. Do not auto-enable on creation.
- The `app.encryption_key` Postgres setting must be set at the database level: `ALTER DATABASE postgres SET app.encryption_key = 'your-secret'`. This is done once in a migration and is not a per-connection setting.

## Project Structure

```
dashboard/                       # Next.js project (separate from daemon)
  app/
    layout.tsx                   # Root layout with auth provider
    page.tsx                     # Dashboard home (server component)
    login/page.tsx               # Login page
    repos/
      page.tsx                   # Repo list
      [id]/page.tsx              # Repo detail + settings
      new/page.tsx               # Add repo form
    runs/
      page.tsx                   # Run history
      [id]/page.tsx              # Run detail
    cost/page.tsx                # Cost charts
    settings/page.tsx            # Global settings (concurrency, etc.)
    team/page.tsx                # Team management + invitations
    api/
      daemon/
        pause/route.ts           # Proxy: POST /api/daemon/pause
        resume/route.ts          # Proxy: POST /api/daemon/resume
        status/route.ts          # Proxy: GET /api/daemon/status
  actions/
    repos.ts                     # Server Actions: create, update, delete, enable/disable
    api-keys.ts                  # Server Actions: upsert encrypted API key
    team.ts                      # Server Actions: invite, change role, remove
    settings.ts                  # Server Actions: update global settings
  components/
    sidebar.tsx                  # Navigation sidebar
    stats-cards.tsx              # Dashboard stat cards
    run-table.tsx                # Reusable run table
    cost-chart.tsx               # Cost over time chart
    realtime-provider.tsx        # Supabase realtime wrapper
  lib/
    supabase/
      server.ts                  # Server-side Supabase client
      client.ts                  # Browser-side Supabase client
      middleware.ts              # Auth middleware helper (updateSession)
    types.ts                     # Database types (generated from Supabase)
  proxy.ts                       # Next.js proxy (auth check) — renamed from middleware.ts in Next.js 16
  next.config.ts
  tailwind.config.ts
  package.json

supabase/
  migrations/
    001_initial.sql              # Tables, RLS policies, pgcrypto, functions
  tests/
    rls.test.ts                  # RLS policy integration tests
  config.toml                   # Supabase project config

docker-compose.prod.yml          # Production: Caddy + Next.js + Daemon (shared network)
Caddyfile                        # Reverse proxy config
.env.prod.example                # Template for secrets (gitignored .env.prod)
```
