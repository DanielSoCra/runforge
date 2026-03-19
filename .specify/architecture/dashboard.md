---
id: ARCH-AC-DASHBOARD
type: architecture
domain: auto-claude
status: draft
version: 2
layer: 2
references: FUNC-AC-DASHBOARD
---

# ARCH-AC-DASHBOARD — Dashboard Service

## Overview

The Dashboard Service is a web application that provides a UI for managing repositories, monitoring runs, tracking costs, and controlling the daemon. It uses an external authentication provider for identity, a hosted database for configuration and history, and communicates with the daemon over an internal container network.

## Data Model

**User** represents an authenticated person. It contains: a unique identifier (from the auth provider), a display name, an avatar URL, an email, and a role (admin or viewer). The first user to authenticate is automatically assigned the admin role.

**GlobalSettings** stores system-wide configuration. It contains: a unique identifier (single-row table), a global concurrency limit (maximum concurrent workers across all repos), and timestamps for creation and last update. The daemon reads this on every config sync.

**Repo** represents a monitored repository. It contains: a unique identifier, an owner (organization or username), a name, an enabled flag (defaults to false — admin must explicitly enable after credentials are set), branch configuration (staging branch name, production branch name), a per-run budget limit, a per-repo concurrency limit, a poll interval override (optional), a soft-delete timestamp (`deleted_at`, null when active), and timestamps for creation and last update. Repos with `deleted_at` set are excluded from daemon sync but their run history is preserved.

**ApiKey** stores credentials for a repository. It contains: a unique identifier, a reference to the repo, a key type (`source-control` or `model-provider`), an encrypted value, and timestamps for creation and last update. Values are encrypted at rest and are write-only — the dashboard never reads back the plaintext. Updating a key overwrites the existing record for that (repo, key_type) pair.

**Invitation** represents a pending access grant. It contains: a unique identifier, the identity provider handle (e.g. GitHub username), an assigned role (admin or viewer), a reference to the inviting user, a status (pending or accepted), an expiry timestamp, and a creation timestamp. On first login, if the user's provider handle matches a pending invitation, the invitation is accepted and a TeamMember record is created.

**TeamMember** represents a user who has accepted an invitation. It contains: a unique identifier, a reference to the user, a role (admin or viewer), and the timestamp when access was granted. Roles can be changed by any admin, with the constraint that the last admin cannot be demoted.

**Run** represents a completed or in-progress pipeline execution. It contains: a unique identifier, a reference to the repo, a snapshot of the repo owner and name at run time (preserved even if the repo is later deleted), the issue number, the issue title, the pipeline variant, the current phase name, the outcome (`in-progress`, `complete`, `stuck`, or `escalated`), the total cost, a `phases` array of `PhaseEvent` objects (name, started_at, duration_ms, cost), a fix attempt count, a `report` text field (null until completion), and timestamps for start and completion. The daemon upserts this record on every phase transition, not only at completion.

**PhaseEvent** is an embedded structure within Run. It contains: a phase name, a start timestamp, a duration in milliseconds, and a cost amount.

**CostEvent** represents a single cost entry. It contains: a unique identifier, a reference to the run, a session type (one of: `planning`, `implementation`, `validation`, `diagnosis`, `fix`), a cost amount, and a timestamp. Cost events enable per-day, per-repo, and per-session-type cost breakdowns.

## API Contract

### Dashboard Web Application

The Dashboard is a server-rendered web application. It uses **Server Actions** for all Database Service mutations (repos, settings, invitations, team members, API keys) — no REST API routes are needed for these. Explicit API routes exist only for operations that cannot use Server Actions: daemon proxy commands and any webhook receivers.

**Auth Service (external)** — handles authentication flows. The Dashboard redirects users to the auth provider for sign-in and receives identity tokens on callback.

**Database Service (external)** — stores all persistent data. The Dashboard reads and writes repos, runs, cost events, team members, and invitations. Supports realtime subscriptions for live updates.

**Daemon API (internal network)** — the Dashboard proxies operational commands to the daemon over the internal container network. The daemon's service name and port are defined in deployment configuration (L3).

Dashboard API routes (daemon proxy only):

- `POST /api/daemon/pause` — pause the daemon (admin only, proxied to daemon)
- `POST /api/daemon/resume` — resume the daemon (admin only, proxied to daemon)
- `GET /api/daemon/status` — daemon status: `{ state: "running" | "paused" | "offline", active_runs: number, version: string }` (proxied to daemon)

All other operations (CRUD for repos, settings, team, invitations, API keys) are implemented as Server Actions that query the Database Service directly from Next.js server context.

### Daemon Configuration Sync

The Daemon fetches its configuration from the Database Service instead of a local config file.

**Sync flow (Daemon reads config):**
1. On startup and periodically (interval defined in L3), the Daemon queries the Database Service for all enabled, non-deleted repos and GlobalSettings.
2. The response includes: owner, name, branch config, budget, concurrency limit, and decrypted credentials. Credentials are decrypted via a `SECURITY DEFINER` Postgres function callable only by the daemon's service-role — the dashboard runtime never calls this function (see L3 for the RPC pattern).
3. The Daemon caches the result locally as JSON. If the Database Service is unreachable, the cache is used.

**Sync flow (Daemon writes results):**
1. On each phase transition during a run, the Daemon upserts a Run record to the Database Service with the current phase, phases-so-far, and running cost. This enables live phase updates in the dashboard.
2. On run completion, the Daemon finalizes the Run record (outcome, report, total cost) and writes CostEvent records for each session within the run.
3. The Database Service broadcasts a realtime event on each upsert.

**Source of truth:** Supabase is the canonical store for all config and run history. Local JSONL is a write-ahead buffer — if the Database Service is unreachable, run events are buffered to JSONL. On startup, the Daemon replays any unsynced JSONL entries (idempotent via run ID) before beginning normal operation.

## System Boundaries

- Dashboard Service OWNS: the web UI, Server Actions, auth flow, and team management logic.
- Database Service (external) OWNS: persistent storage for repos, runs, cost events, team members, invitations, and encrypted API keys.
- Auth Service (external) OWNS: identity verification and session tokens.
- Daemon OWNS: pipeline execution, worker dispatch, and local write-ahead state. It READS repo config from the Database Service and WRITES run results back.
- Dashboard Service PROXIES daemon commands (pause, resume, status) to the Daemon over the internal container network.
- Dashboard Service DOES NOT execute pipelines, spawn workers, or access repositories directly.

## Event Flows

**User authentication flow:**
1. User visits the Dashboard. Middleware checks for a valid session.
2. No session → redirect to auth provider's sign-in page.
3. User authenticates with the provider → redirected back with an auth token.
4. Dashboard creates or updates the User record in the Database Service.
5. If no other users exist, assign admin role atomically (single transaction — see L3). Otherwise, check Invitation for a pending record matching the user's provider handle.
6. If a matching pending Invitation exists, accept it (create TeamMember, mark invitation accepted). Otherwise deny access: "Access denied — ask an admin to invite you."

**Add repository flow:**
1. Admin fills in owner, name, branch config, budget, concurrency limit.
2. Dashboard validates inputs and writes a Repo record with `enabled: false` to the Database Service.
3. Admin provides credentials (source-control token, model-provider key). Dashboard writes encrypted ApiKey records.
4. Admin explicitly enables the repo. Only then does the daemon pick it up on its next sync cycle.

**Run sync flow:**
1. Daemon begins a pipeline run — upserts a Run record with `outcome: in-progress`.
2. On each phase transition, Daemon upserts the Run record with updated phase, phases array, and running cost.
3. Database Service broadcasts a realtime event on each upsert. Dashboard updates the UI without a page refresh.
4. On completion, Daemon finalizes the Run record and writes CostEvent records.

**Daemon control flow:**
1. Admin clicks "Pause" in the Dashboard.
2. Dashboard sends `POST /api/daemon/pause` to its own API route.
3. API route proxies the request to the daemon via the internal container network.
4. Daemon pauses. Dashboard polls `/api/daemon/status` to confirm.

## Error Handling

**Auth provider unavailable:** Show an error page. The Dashboard cannot function without authentication.

**Database Service unavailable:** The Dashboard shows a degraded state indicator. Cached data (if available on the client) remains visible. Write operations fail with a clear error message.

**Daemon unreachable:** The Dashboard shows "Daemon offline" status. Repo configuration and run history remain viewable (from the Database Service). Daemon control buttons are disabled.

**Credential decryption failure:** The Daemon logs the error and skips the affected repo. The Dashboard shows a "credential error" status on that repo. The admin must re-enter credentials to resume polling.

**First user denied access:** Cannot happen — the first user is always granted admin. Subsequent users without a matching pending invitation see an "Access denied — ask an admin to invite you" page.

**Last admin demotion:** Prevented — before demoting a TeamMember, the system checks that at least one other admin exists. If not, the operation is rejected with a clear error.

**Run sync failure (Database Service unreachable):** The Daemon buffers run events to local JSONL. On next startup or successful reconnection, buffered entries are replayed idempotently via run ID. The Dashboard shows slightly stale data until sync succeeds.

**Repo deletion with run history:** Repos are soft-deleted (`deleted_at` set, `enabled` forced false). Run records retain a snapshot of the repo's owner and name, so history remains intact and displayable after the repo is removed.

## Integration Path

The current daemon is single-repo and reads config from local files. Migration is phased:

1. **Schema first** — deploy Supabase schema (tables, RLS, migrations). Dashboard is read-only from existing JSONL-exported data.
2. **Dashboard read-write** — Dashboard manages repos and config. Daemon still reads from local config.
3. **Daemon reads from Supabase** — refactor daemon config loading to query Database Service; local config becomes fallback only.
4. **Daemon writes to Supabase** — add run upsert and CostEvent writes on phase transitions and completion.
5. **Multi-repo** — daemon scheduler handles multiple repos from Supabase config; per-repo concurrency enforced.
