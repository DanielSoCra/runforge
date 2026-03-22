# Deployment Topology Design

## Problem

The auto-claude system assumes a single deployment target: co-located Docker containers on a Hetzner server. The L2 and L3 specs hardcode "internal container network" language. In practice, the system runs on a Mac Mini with native processes (launchd-managed shell scripts) and no dashboard deployed. The Hetzner configuration exists but is not actively used.

The system needs to run on the Mac Mini now (Docker Compose, local network access, no TLS, no auth) and on Hetzner later (Docker Compose, public access, TLS via Caddy, GitHub OAuth). Both environments should use the same compose file with minimal configuration differences.

## Approach

Single `docker-compose.yml` with Docker Compose profiles and environment-driven configuration. One compose file serves both environments. Differences are isolated to env files and whether Caddy runs.

## Compose File

One `docker-compose.yml` replaces the current `docker-compose.prod.yml`. Four services:

**dashboard** — Next.js standalone, always runs. Port binding controlled by `DASHBOARD_PORT` env var. On the Mac Mini, exposed on all interfaces for LAN access (`0.0.0.0:3000:3000`). On Hetzner, bound to loopback only (`127.0.0.1:3000:3000`) so only Caddy can reach it.

All existing service definitions from `docker-compose.prod.yml` are preserved: bridge network (`app`), named volumes (`caddy_data`, `caddy_config`, `daemon-state`), build contexts with Dockerfile paths, volume mounts for prompts/fitness/plugins/config, and `depends_on` relationships. The only structural change is the addition of the `profiles` directive on the Caddy service and the `DASHBOARD_PORT` variable for port binding.

**daemon** — Node.js, always runs. Port 3847, never exposed externally in either environment. Dashboard reaches it via Docker service name `http://daemon:3847`. Binds `0.0.0.0` inside the container so the dashboard container can connect.

**briefing-summarizer** — Always runs, no exposed ports. Connects to daemon via `http://daemon:3847` and writes to Supabase.

**caddy** — Gated behind Docker Compose profile `public`. Only starts on Hetzner. Handles TLS termination and reverse proxies to the dashboard container. Uses automatic ACME certificate provisioning.

### Environment file loading

Docker Compose's `--env-file` flag sets variables for interpolation in the compose file (e.g., `${DASHBOARD_PORT}`). To load environment variables into container runtimes, each service uses the `env_file` directive. The compose file uses an interpolated `env_file` path so both mechanisms are driven by the same variable:

```yaml
services:
  dashboard:
    env_file: ${ENV_FILE:-.env.prod}
    ports:
      - "${DASHBOARD_PORT}"
  daemon:
    env_file: ${ENV_FILE:-.env.prod}
  briefing-summarizer:
    env_file: ${ENV_FILE:-.env.prod}
```

### Starting the stack

```bash
# Mac Mini — local network access, no TLS, no auth
ENV_FILE=.env.mac docker compose --env-file .env.mac up -d

# Hetzner — public, TLS via Caddy, GitHub OAuth
docker compose --env-file .env.prod --profile public up -d
```

The `ENV_FILE` shell variable controls which env file is loaded into containers. On Hetzner, the default (`.env.prod`) applies without setting `ENV_FILE`.

## Environment Files

### .env.mac

- `DASHBOARD_PORT=0.0.0.0:3000:3000` — dashboard accessible on LAN
- `NEXT_PUBLIC_SITE_URL=http://localhost:3000`
- `AUTH_DISABLED=true` — bypasses Supabase Auth (private network, single operator)
- `DAEMON_URL=http://daemon:3847` — Docker service name resolution
- Supabase, GitHub, and Anthropic credentials (same keys, potentially different values from prod)

### .env.prod

- `DASHBOARD_PORT=127.0.0.1:3000:3000` — loopback only, Caddy handles public traffic on 443
- `NEXT_PUBLIC_SITE_URL=https://app.example.com`
- `AUTH_DISABLED` not set (auth enforced)
- `DAEMON_URL=http://daemon:3847` — same Docker service name
- Production Supabase, GitHub, and Anthropic credentials

### Templates

`.env.mac.example` and `.env.prod.example` are committed with placeholder values. Actual `.env.mac` and `.env.prod` are gitignored.

## Authentication

On Hetzner, the dashboard uses Supabase Auth with GitHub OAuth. On the Mac Mini, auth is disabled via `AUTH_DISABLED=true`.

This avoids the OAuth callback URL problem — GitHub OAuth requires HTTPS or localhost, and `http://localhost:3000` qualifies as neither. Since the Mac Mini is on a private network with a single operator, auth adds no value.

### AUTH_DISABLED behavior (end-to-end)

When `AUTH_DISABLED=true`, the entire auth chain is bypassed:

1. **Proxy (`proxy.ts`)** — passes all requests through without redirecting to `/login`. Does not call `supabase.auth.getUser()`.
2. **Server Actions** — any action that checks user identity or admin role skips the check and treats the request as admin. A helper function (e.g., `getAuthenticatedUser()`) returns a synthetic admin user when auth is disabled, so calling code does not need per-action conditionals.
3. **API routes** (daemon proxy) — admin-only checks (pause, resume, restart) are bypassed. CSRF protection (`X-Requested-By` header) is retained regardless of auth mode.
4. **Supabase database access** — uses the service role key for all operations, bypassing RLS. This is the same key the daemon uses. No user-scoped RLS applies.
5. **Login page** — not rendered. If accessed directly, redirects to `/`.

The `AUTH_DISABLED` flag does not affect the daemon or briefing summarizer — they never use Supabase Auth.

## Configuration Differences Summary

| Concern | Mac Mini (.env.mac) | Hetzner (.env.prod) |
|---|---|---|
| Dashboard access | `0.0.0.0:3000` on LAN | `127.0.0.1:3000` + Caddy on 443 |
| TLS | None | Caddy ACME |
| Authentication | Disabled | Supabase + GitHub OAuth |
| Site URL | `http://localhost:3000` | `https://app.example.com` |
| Caddy | Not started | Started via `--profile public` |
| Daemon access | Docker internal network | Docker internal network |
| Database | Supabase (hosted) | Supabase (hosted) |

## File Changes

### Changed

- `docker-compose.yml` — new file, replaces `docker-compose.prod.yml`. Single compose file with profile-gated Caddy service and interpolated `env_file`.
- `.env.prod.example` — updated to include `DASHBOARD_PORT` and `ENV_FILE` variables.
- `.specify/traceability.yml` — update governance: replace `docker-compose.prod.yml` with `docker-compose.yml`, add `.env.mac.example`.
- `docs/running.md` — update all references from `docker-compose.prod.yml` to `docker-compose.yml`.
- Dashboard auth system — proxy, server actions, and API routes respect `AUTH_DISABLED` env var (see Authentication section).

### New

- `.env.mac.example` — template for Mac Mini environment.

### Removed

- `docker-compose.prod.yml` — superseded by `docker-compose.yml`. All references in docs and tests updated.

### Unchanged

- All Dockerfiles (dashboard, daemon, briefing-summarizer) — no changes needed.
- `Caddyfile` — unchanged, Caddy conditionally runs or not.
- `infra/main.tf`, `infra/cloud-init.yml` — Hetzner provisioning unchanged.
- `auto-claude.config.json` — unchanged.

### Superseded (not deleted)

- `scripts/com.autoclaude.reviewer.plist` — replaced by daemon running in Docker.
- `scripts/com.autoclaude.developer.plist` — replaced by daemon running in Docker.

**Cutover sequence** (to avoid dual daemon operation):

1. Unload launchd services: `launchctl unload ~/Library/LaunchAgents/com.autoclaude.*.plist`
2. Verify no auto-claude processes running: `ps aux | grep pipeline.sh`
3. Start Docker stack: `ENV_FILE=.env.mac docker compose --env-file .env.mac up -d`
4. Verify healthy: `docker compose ps` — all services should be `running`

The launchd plists are not deleted yet because the daemon's native FSM migration (issues #200, #201) is still in progress. Once the FSM replaces the shell scripts, these plists and their corresponding shell scripts can be removed.

## Spec Updates Required

### ARCH-AC-DASHBOARD (L2)

Replace hardcoded "internal container network" references with environment-agnostic language. The dashboard communicates with the daemon via a configurable service URL (`DAEMON_URL`), which resolves via Docker service name in both environments. Remove the phrase "the daemon's service name and port are defined in deployment configuration (L3)" and instead state that the daemon is always reachable at the configured `DAEMON_URL`.

Affected lines: overview (line 15), API contract (line 53), system boundaries (line 112), daemon control flow (line 171).

### FUNC-AC-DASHBOARD (L1)

Add a note to the Authentication section: authentication scenarios apply when auth is enabled. When `AUTH_DISABLED` is set, the system operates as a single-admin instance — all auth scenarios are bypassed and all users have admin access.

### STACK-AC-DASHBOARD (L3)

Replace the "Docker Compose for deployment" paragraph (line 27) with the profile-based model: single compose file, environment-driven configuration, Caddy gated behind a profile for public deployments. Update the project structure section (line 256) to reference `docker-compose.yml` instead of `docker-compose.prod.yml`.
