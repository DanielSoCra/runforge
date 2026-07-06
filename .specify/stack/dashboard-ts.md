---
id: STACK-AC-DASHBOARD
type: stack-specific
domain: runforge
status: draft
version: 3
layer: 3
stack: typescript
references: ARCH-AC-DASHBOARD
code_paths:
  - packages/dashboard/
  - supabase/
test_paths:
  - packages/dashboard/**/*.test.ts
  - packages/dashboard/**/*.test.tsx
  - supabase/tests/**/*.test.ts
---

# STACK-AC-DASHBOARD — Dashboard (TypeScript)

## Pattern

**Next.js App Router with Supabase.** Server components for data fetching, Server Actions for mutations, API routes only for daemon proxy. Supabase client for auth and database. The dashboard is a separate Next.js project in a `dashboard/` directory alongside the daemon `src/`.

**Supabase as backend.** Supabase provides: Postgres database, GitHub OAuth via Supabase Auth, Row Level Security for access control, Realtime subscriptions for live updates, and encrypted column support for API keys. Server Actions replace REST API routes for all database mutations — no custom API layer needed for Supabase operations.

**Docker Compose for deployment.** Three services: Caddy (reverse proxy + HTTPS), Next.js dashboard, Runforge daemon. All three run on a shared Docker network. Caddy routes `app.example.com` to the Next.js container. The dashboard reaches the daemon via Docker service name resolution (e.g., `http://daemon:3847`).

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

## Examples

```typescript
// Supabase server client — cookie-based auth for server components
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: { getAll: () => cookieStore.getAll() },
  });
}
```

```typescript
// Next.js 16: proxy.ts (not middleware.ts), exported as proxy (not middleware)
export async function proxy(request) {
  const { supabase, response } = createServerClient(/* ... */);
  await supabase.auth.getUser(); // refresh session
  return response;
}
```

```typescript
// Server Action pattern — no API route needed for Supabase mutations
'use server';
export async function createRepo(formData: FormData) {
  const supabase = await createClient();
  await supabase.from('repos').insert({ owner, name, enabled: false });
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
-- Atomic first-user-is-admin: SECURITY DEFINER + LOCK prevents race conditions
-- Returns: 'admin' | 'viewer' | 'denied'
CREATE OR REPLACE FUNCTION bootstrap_user_access(p_user_id uuid, p_provider_handle text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
  -- LOCK TABLE team_members; check first user → admin, else match invitation
$$;
```

```sql
-- Credential encryption: SECURITY DEFINER keeps encryption key out of app runtime
-- Dashboard writes via supabase.rpc('upsert_api_key_encrypted', {...})
CREATE OR REPLACE FUNCTION upsert_api_key_encrypted(p_repo_id uuid, p_key_type text, p_plaintext text)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO api_keys ... VALUES (... pgp_sym_encrypt(p_plaintext, current_setting('app.encryption_key')))
  ON CONFLICT (repo_id, key_type) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value;
$$;
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
