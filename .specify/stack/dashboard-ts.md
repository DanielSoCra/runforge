---
id: STACK-AC-DASHBOARD
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-DASHBOARD
code_paths:
  - dashboard/
test_paths:
  - dashboard/**/*.test.ts
  - dashboard/**/*.test.tsx
---

# STACK-AC-DASHBOARD — Dashboard (TypeScript)

## Pattern

**Next.js App Router with Supabase.** Server components for data fetching, server actions for mutations, Supabase client for auth and database. The dashboard is a separate Next.js project in a `dashboard/` directory alongside the daemon `src/`.

**Supabase as backend.** Supabase provides: Postgres database, GitHub OAuth via Supabase Auth, Row Level Security for access control, Realtime subscriptions for live updates, and encrypted column support for API keys. No custom backend API needed — the Next.js server components query Supabase directly.

**Docker Compose for deployment.** Three services: Caddy (reverse proxy + HTTPS), Next.js dashboard, Auto-Claude daemon. Caddy routes `app.example.com` to the Next.js container.

## Key Decisions

**Framework: Next.js 15 (App Router).** Server components reduce client-side JavaScript. Server actions handle mutations without API routes. Built-in middleware for auth checks. Chosen over Pages Router (legacy pattern) and Remix (less mature Supabase integration).

**Auth: Supabase Auth with GitHub OAuth.** `@supabase/ssr` package handles server-side auth in Next.js. GitHub OAuth configured in Supabase dashboard — no custom OAuth implementation needed. Session stored in cookies (httpOnly, secure). Middleware checks session on every request.

**Database: Supabase Postgres with Row Level Security.** Tables: `repos`, `api_keys`, `runs`, `cost_events`, `team_members`. RLS policies enforce role-based access: admins can read/write everything, viewers can only read. The `api_keys.encrypted_value` column uses `pgcrypto` for at-rest encryption.

**Realtime: Supabase Realtime.** Subscribe to the `runs` table for live dashboard updates. When the daemon inserts or updates a run, connected clients receive the change instantly via WebSocket.

**Styling: Tailwind CSS + shadcn/ui.** Tailwind for utility-first styling. shadcn/ui for pre-built accessible components (tables, cards, dialogs, forms). Dark theme by default. Chosen over Material UI (heavier, opinionated) and plain CSS (too slow for a polished UI).

**Charts: Recharts.** Lightweight React charting library for cost charts. Chosen over Chart.js (not React-native) and D3 (overkill).

**Reverse proxy: Caddy.** Automatic HTTPS via Let's Encrypt. Config is 5 lines. Chosen over Nginx (manual cert management) and Traefik (more complex config).

**Daemon sync: Supabase JS client in daemon.** The daemon uses `@supabase/supabase-js` with a service-role key to read repo configs and write run results. The service-role key bypasses RLS — it's used only by the daemon, never exposed to the browser.

**Encryption: pgcrypto.** API key values are encrypted with `pgp_sym_encrypt()` using a server-side secret. The dashboard writes encrypted values, the daemon decrypts on read with the same secret. The secret is an environment variable, never stored in the database.

## Examples

```typescript
// Supabase server client (Next.js server component)
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
// Auth middleware (middleware.ts)
import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';

export async function middleware(request) {
  const supabase = createServerClient(/* ... */);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect('/login');
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
// Daemon reads repo config from Supabase
const { data: repos } = await supabase
  .from('repos')
  .select('*, api_keys(*)')
  .eq('enabled', true);
// Cache locally as fallback
await writeJsonSafe('state/repo-cache.json', repos);
```

```sql
-- pgcrypto encryption for API keys
INSERT INTO api_keys (repo_id, key_type, encrypted_value)
VALUES ($1, $2, pgp_sym_encrypt($3, current_setting('app.encryption_key')));

-- Daemon decrypts
SELECT pgp_sym_decrypt(encrypted_value, current_setting('app.encryption_key'))
FROM api_keys WHERE repo_id = $1;
```

## Gotchas

- Supabase Auth cookies must be refreshed in middleware on every request. Use the `@supabase/ssr` `updateSession` pattern — stale cookies cause silent auth failures.
- The service-role key (used by the daemon) bypasses ALL RLS policies. Never expose it to the browser. Store it only as a server-side environment variable.
- `pgp_sym_encrypt` requires the `pgcrypto` extension enabled in Supabase (it's available but not enabled by default — run `CREATE EXTENSION IF NOT EXISTS pgcrypto` in a migration).
- Supabase Realtime only broadcasts changes to rows the client can SELECT via RLS. Ensure RLS policies allow viewers to read the `runs` table.
- Next.js server components cannot use `useEffect` or browser APIs. Use client components (with `'use client'` directive) only for interactive elements like realtime subscriptions and forms.
- Caddy's automatic HTTPS requires port 80 and 443 to be open. The Hetzner firewall must allow inbound HTTP/HTTPS from anywhere for cert provisioning.
- Docker Compose networking: the Next.js container reaches the daemon via `host.docker.internal:3847` (or a shared Docker network with service name resolution).
- The first-user-is-admin logic must be atomic: check user count and insert with admin role in a single transaction to prevent race conditions.

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
    settings/page.tsx            # Global settings
    team/page.tsx                # Team management
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
      middleware.ts              # Auth middleware helper
    types.ts                     # Database types (generated from Supabase)
  middleware.ts                  # Next.js middleware (auth check)
  next.config.ts
  tailwind.config.ts
  package.json

supabase/
  migrations/
    001_initial.sql              # Tables, RLS policies, pgcrypto
  config.toml                   # Supabase project config

docker-compose.prod.yml          # Production: Caddy + Next.js + Daemon
Caddyfile                        # Reverse proxy config
```
