> **🗄 HISTORICAL (2026-06-02).** Completed/superseded record, kept for provenance — superseded by the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. The canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Deployment Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Docker Compose configuration so the same file runs on Mac Mini (LAN, no auth) and Hetzner (public, TLS, OAuth), then deploy the stack on the Mac Mini.

**Architecture:** Single `docker-compose.yml` with Docker Compose profiles (Caddy gated behind `public` profile) and interpolated `env_file` paths. Auth bypass via `AUTH_DISABLED` env var propagated through proxy, auth helper, server actions, and API routes.

**Tech Stack:** Docker Compose, Next.js 16, Supabase, Caddy

**Important context:** The Mac Mini currently runs `pipeline.sh`, `reviewer.sh`, and `developer.sh` via launchd plists. These scripts must be stopped before starting the Docker daemon to avoid dual operation. The cutover happens in the final task.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `docker-compose.yml` | Unified compose (replaces both existing compose files) | Rewrite |
| `.env.mac.example` | Mac Mini environment template | Create |
| `.env.prod.example` | Hetzner environment template (add new vars) | Modify |
| `packages/dashboard/lib/auth.ts` | Auth helper with `AUTH_DISABLED` support | Modify |
| `packages/dashboard/proxy.ts` | Request proxy with auth bypass | Modify |
| `packages/dashboard/app/api/daemon/pause/route.ts` | Daemon proxy using auth helper | Modify |
| `packages/dashboard/app/api/daemon/resume/route.ts` | Daemon proxy using auth helper | Modify |
| `packages/dashboard/app/api/daemon/repos-reload/route.ts` | Daemon proxy using auth helper | Modify |
| `packages/dashboard/app/api/daemon/issues/scan/route.ts` | Daemon proxy using auth helper | Modify |
| `packages/dashboard/app/api/daemon/remote-control/restart/route.ts` | Daemon proxy (already uses helper) | Verify |
| `packages/dashboard/app/login/page.tsx` | Login page redirect when auth disabled | Modify |
| `docs/running.md` | Update compose references | Modify |
| `docs/hetzner-setup.md` | Update compose references | Modify |
| `.specify/traceability.yml` | Update governed file references | Modify |

---

### Task 1: Unified docker-compose.yml

**Files:**
- Create: `docker-compose.yml` (rewrite — replaces existing dev-only version)
- Remove: `docker-compose.prod.yml` (deleted after new file is verified)

- [ ] **Step 1: Write the new docker-compose.yml**

```yaml
networks:
  app:
    driver: bridge

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    profiles: ["public"]
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
      context: .
      dockerfile: packages/dashboard/Dockerfile
      args:
        - NEXT_PUBLIC_SUPABASE_URL
        - NEXT_PUBLIC_SUPABASE_ANON_KEY
    restart: unless-stopped
    env_file: ${ENV_FILE:-.env.prod}
    environment:
      NODE_ENV: production
      PLUGINS_DIR: /app/plugins
    ports:
      - "${DASHBOARD_PORT:-3000}"
    volumes:
      - ./plugins:/app/plugins:ro
    networks:
      - app
    depends_on:
      - daemon

  daemon:
    build:
      context: .
      dockerfile: packages/daemon/Dockerfile
    restart: unless-stopped
    env_file: ${ENV_FILE:-.env.prod}
    environment:
      DAEMON_HOST: "0.0.0.0"
    ports: []
    command: >
      sh -c "
        git config --global user.name 'Auto-Claude' &&
        git config --global user.email 'auto-claude@localhost' &&
        pnpm start
      "
    volumes:
      - ./prompts:/app/packages/daemon/prompts:ro
      - ./fitness:/app/packages/daemon/fitness:ro
      - ./plugins:/app/plugins:ro
      - ./auto-claude.config.json:/app/packages/daemon/auto-claude.config.json:ro
      - daemon-state:/app/packages/daemon/state
    networks:
      - app

  briefing-summarizer:
    build:
      context: .
      dockerfile: packages/briefing-summarizer/Dockerfile
    restart: unless-stopped
    env_file: ${ENV_FILE:-.env.prod}
    environment:
      NODE_ENV: production
      DAEMON_URL: http://daemon:3847
    networks:
      - app
    depends_on:
      - daemon

volumes:
  caddy_data:
  caddy_config:
  daemon-state:
```

- [ ] **Step 2: Verify compose file parses correctly**

Run: `docker compose config --quiet`
Expected: No output (success). If errors, fix syntax.

- [ ] **Step 3: Delete docker-compose.prod.yml**

```bash
git rm docker-compose.prod.yml
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: unify docker-compose with profiles for Mac Mini and Hetzner

Replace docker-compose.prod.yml and dev-only docker-compose.yml with a
single file. Caddy gated behind 'public' profile. env_file interpolated
via ENV_FILE variable."
```

---

### Task 2: Environment file templates

**Files:**
- Create: `.env.mac.example`
- Modify: `.env.prod.example`

- [ ] **Step 1: Create .env.mac.example**

```bash
# === Mac Mini Environment ===
# Copy to .env.mac and fill in values:  cp .env.mac.example .env.mac

# Dashboard port binding — exposed on LAN
DASHBOARD_PORT=0.0.0.0:3000:3000

# Auth disabled — private network, single operator
AUTH_DISABLED=true

# Site URL — used for internal redirects
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# Daemon URL — Docker service name resolution (do not change)
DAEMON_URL=http://daemon:3847

# --- Supabase ---
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# --- API Keys ---
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# --- Dashboard ---
ENCRYPTION_KEY=<32+-char-random-secret>

# --- Daemon ---
DAEMON_SYNC_INTERVAL_MS=60000
```

- [ ] **Step 2: Update .env.prod.example**

Read `/.env.prod.example`. Add these variables at the top (before the existing content):

```bash
# Dashboard port binding — loopback only, Caddy handles public traffic
DASHBOARD_PORT=127.0.0.1:3000:3000

# Auth is enabled in production (do NOT set AUTH_DISABLED)
```

- [ ] **Step 3: Commit**

```bash
git add .env.mac.example .env.prod.example
git commit -m "feat: add Mac Mini env template, update prod template with DASHBOARD_PORT"
```

---

### Task 3: AUTH_DISABLED in auth helper

**Files:**
- Modify: `packages/dashboard/lib/auth.ts`
- Test: `packages/dashboard/lib/auth.test.ts` (create if not exists)

- [ ] **Step 1: Check if auth.test.ts exists**

Run: `ls packages/dashboard/lib/auth.test.ts 2>/dev/null || echo "no test file"`

- [ ] **Step 2: Write failing tests for AUTH_DISABLED**

Create or append to `packages/dashboard/lib/auth.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('auth helpers with AUTH_DISABLED', () => {
  const originalEnv = process.env.AUTH_DISABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = originalEnv;
    }
  });

  describe('isAuthDisabled', () => {
    it('returns true when AUTH_DISABLED=true', () => {
      process.env.AUTH_DISABLED = 'true';
      const { isAuthDisabled } = require('./auth');
      expect(isAuthDisabled()).toBe(true);
    });

    it('returns false when AUTH_DISABLED is not set', () => {
      delete process.env.AUTH_DISABLED;
      const { isAuthDisabled } = require('./auth');
      expect(isAuthDisabled()).toBe(false);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/dashboard && npx vitest run lib/auth.test.ts`
Expected: FAIL — `isAuthDisabled` is not exported

- [ ] **Step 4: Add isAuthDisabled and update requireAdmin/isAdmin**

In `packages/dashboard/lib/auth.ts`, add at the top (after imports):

```typescript
/** Returns true when auth is disabled (private network, single operator). */
export function isAuthDisabled(): boolean {
  return process.env.AUTH_DISABLED === 'true';
}

/** Synthetic admin user for AUTH_DISABLED mode. */
const SYNTHETIC_ADMIN = {
  id: '00000000-0000-0000-0000-000000000000',
  email: 'admin@localhost',
  role: 'authenticated',
} as const;
```

Update `requireAdmin` to check `isAuthDisabled()` first:

```typescript
export async function requireAdmin(supabase: SupabaseClient) {
  if (isAuthDisabled()) return SYNTHETIC_ADMIN as any;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Unauthorized');
  const { data: member, error } = await supabase.from('team_members')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (error && error.code !== 'PGRST116') {
    console.error('[auth] team_members query failed:', error.message);
  }
  if (member?.role !== 'admin') throw new Error('Admin access required');
  return user;
}
```

Update `isAdmin` similarly:

```typescript
export async function isAdmin(supabase: SupabaseClient): Promise<boolean> {
  if (isAuthDisabled()) return true;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data: member, error } = await supabase.from('team_members')
      .select('role')
      .eq('user_id', user.id)
      .single();
    if (error && error.code !== 'PGRST116') {
      console.error('[auth] team_members query failed:', error.message);
    }
    return member?.role === 'admin';
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/dashboard && npx vitest run lib/auth.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/lib/auth.ts packages/dashboard/lib/auth.test.ts
git commit -m "feat: add AUTH_DISABLED support to auth helpers

When AUTH_DISABLED=true, requireAdmin() returns a synthetic admin user
and isAdmin() returns true, bypassing Supabase auth entirely."
```

---

### Task 4: AUTH_DISABLED in proxy

**Files:**
- Modify: `packages/dashboard/proxy.ts`
- Modify: `packages/dashboard/lib/supabase/middleware.ts`

- [ ] **Step 1: Update proxy.ts to skip auth when disabled**

```typescript
import { type NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { isAuthDisabled } from '@/lib/auth';

export async function proxy(request: NextRequest) {
  if (isAuthDisabled()) return NextResponse.next();
  return await updateSession(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/dashboard && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/proxy.ts
git commit -m "feat: skip auth proxy when AUTH_DISABLED=true"
```

---

### Task 5: AUTH_DISABLED in daemon API routes

**Files:**
- Modify: `packages/dashboard/app/api/daemon/pause/route.ts`
- Modify: `packages/dashboard/app/api/daemon/resume/route.ts`
- Modify: `packages/dashboard/app/api/daemon/repos-reload/route.ts`
- Modify: `packages/dashboard/app/api/daemon/issues/scan/route.ts`

These four routes use an inline auth pattern. Replace with `requireAdmin()` which now handles `AUTH_DISABLED`.

- [ ] **Step 1: Update pause/route.ts**

Replace the inline auth check (lines 4-11) with the helper:

```typescript
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export async function POST() {
  try {
    const supabase = await createClient();
    await requireAdmin(supabase);
  } catch (e: any) {
    const status = e.message === 'Unauthorized' ? 401 : 403;
    return NextResponse.json({ error: e.message }, { status });
  }

  try {
    const res = await fetch(`${process.env.DAEMON_URL}/pause`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'dashboard' },
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
```

- [ ] **Step 2: Update resume/route.ts with same pattern**

Read `packages/dashboard/app/api/daemon/resume/route.ts`. Apply the same transformation: replace inline auth with `requireAdmin(supabase)` in a try/catch. Keep the daemon fetch logic unchanged.

- [ ] **Step 3: Update repos-reload/route.ts with same pattern**

Read `packages/dashboard/app/api/daemon/repos-reload/route.ts`. Apply the same transformation.

- [ ] **Step 4: Update issues/scan/route.ts with same pattern**

Read `packages/dashboard/app/api/daemon/issues/scan/route.ts`. Apply the same transformation.

- [ ] **Step 5: Run existing daemon route tests**

Run: `cd packages/dashboard && npx vitest run app/api/daemon/daemon-routes.test.ts`
Expected: PASS (existing behavior preserved when AUTH_DISABLED is not set)

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/app/api/daemon/
git commit -m "refactor: use requireAdmin() in daemon API routes

Replaces inline auth checks with the shared helper, which now supports
AUTH_DISABLED mode. CSRF header check retained in all routes."
```

---

### Task 6: Login page redirect when auth disabled

**Files:**
- Modify: `packages/dashboard/app/login/page.tsx`

- [ ] **Step 1: Read the current login page**

Run: Read `packages/dashboard/app/login/page.tsx`

- [ ] **Step 2: Add redirect at the top of the page component**

Add a server-side redirect when auth is disabled. At the top of the component function (before any rendering), add:

```typescript
import { redirect } from 'next/navigation';
import { isAuthDisabled } from '@/lib/auth';

// ... existing imports ...

export default function LoginPage() {
  if (isAuthDisabled()) redirect('/');
  // ... rest of existing component
}
```

The exact modification depends on the current file structure. Read it first, then add the `isAuthDisabled()` check as the first line of the component body.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/app/login/page.tsx
git commit -m "feat: redirect login page to / when AUTH_DISABLED"
```

---

### Task 7: Update docs

**Files:**
- Modify: `docs/running.md`
- Modify: `docs/hetzner-setup.md`

- [ ] **Step 1: Update docs/running.md**

Replace all `docker-compose.prod.yml` references:

- Line 94: `docker compose -f docker-compose.prod.yml up --build -d` → `docker compose --env-file .env.prod --profile public up --build -d`
- Line 128: `docker compose -f docker-compose.prod.yml down` → `docker compose --env-file .env.prod --profile public down`

Add a "Mac Mini" section after "Running in Production" (line 95):

```markdown
## Running on Mac Mini

```bash
ENV_FILE=.env.mac docker compose --env-file .env.mac up --build -d
```

Dashboard is available at `http://localhost:3000` on the local network. Auth is disabled.
```

- [ ] **Step 2: Update docs/hetzner-setup.md**

Replace all `docker compose -f docker-compose.prod.yml` with `docker compose --env-file .env.prod --profile public`:

- Line 114: deploy command
- Line 120: ps command
- Line 145: update command
- Line 152: logs command (all services)
- Line 155-156: logs commands (single service)
- Line 162: restart command
- Line 168: down command

- [ ] **Step 3: Commit**

```bash
git add docs/running.md docs/hetzner-setup.md
git commit -m "docs: update compose commands for unified docker-compose.yml"
```

---

### Task 8: Update traceability.yml

**Files:**
- Modify: `.specify/traceability.yml`

- [ ] **Step 1: Update the governed file reference**

On line 385, replace `docker-compose.prod.yml` with `docker-compose.yml`.

- [ ] **Step 2: Commit**

```bash
git add .specify/traceability.yml
git commit -m "chore: update traceability.yml for unified docker-compose.yml"
```

---

### Task 9: Create .env.mac and deploy on Mac Mini

**Important:** This task involves stopping the currently running launchd scripts. The daemon will be offline for a few minutes during cutover.

**Files:**
- Create: `.env.mac` (from template, not committed)

- [ ] **Step 1: Create .env.mac from template**

```bash
cp .env.mac.example .env.mac
```

Fill in the actual values. Copy Supabase credentials, GitHub token, Anthropic key, and encryption key from existing environment (check `~/.zshrc`, `.env`, or the running daemon's environment).

- [ ] **Step 2: Stop launchd services**

```bash
launchctl unload ~/Library/LaunchAgents/com.autoclaude.reviewer.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.autoclaude.developer.plist 2>/dev/null
```

- [ ] **Step 3: Verify no auto-claude processes running**

```bash
ps aux | grep -E 'pipeline\.sh|reviewer\.sh|developer\.sh' | grep -v grep
```

Expected: No output. If processes remain, wait for them to finish or kill them.

- [ ] **Step 4: Build and start Docker stack**

```bash
ENV_FILE=.env.mac docker compose --env-file .env.mac up --build -d
```

- [ ] **Step 5: Verify all services are running**

```bash
docker compose ps
```

Expected: `dashboard`, `daemon`, and `briefing-summarizer` all show status `running`. No `caddy` (not using `--profile public`).

- [ ] **Step 6: Verify dashboard is accessible**

Open `http://localhost:3000` in a browser (or `curl http://localhost:3000`).
Expected: Dashboard loads without login redirect (auth disabled).

- [ ] **Step 7: Verify daemon connectivity**

```bash
curl http://localhost:3000/api/daemon/status
```

Expected: JSON response with `{ state: "running" | "paused", ... }`. If the daemon is healthy, the dashboard can reach it over the Docker network.

- [ ] **Step 8: Verify briefing page loads**

Open `http://localhost:3000/briefing` in a browser.
Expected: Briefing page renders (may show empty state if no briefings exist yet).

---
