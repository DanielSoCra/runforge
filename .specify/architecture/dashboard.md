---
id: ARCH-AC-DASHBOARD
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-DASHBOARD
---

# ARCH-AC-DASHBOARD — Dashboard Service

## Overview

The Dashboard Service is a web application that provides a UI for managing repositories, monitoring runs, tracking costs, and controlling the daemon. It uses an external authentication provider for identity, a hosted database for configuration and history, and communicates with the daemon over a local API.

## Data Model

**User** represents an authenticated person. It contains: a unique identifier (from the auth provider), a display name, an avatar URL, an email, and a role (admin or viewer). The first user to authenticate is automatically assigned the admin role.

**Repo** represents a monitored repository. It contains: a unique identifier, an owner (organization or username), a name, enabled flag, branch configuration (staging branch name, production branch name), a per-run budget limit, a per-repo concurrency limit, a poll interval override (optional), and timestamps for creation and last update.

**ApiKey** stores credentials for a repository. It contains: a unique identifier, a reference to the repo, a key type (source-control or model-provider), an encrypted value, and a creation timestamp. Values are encrypted at rest and are write-only — the dashboard never reads back the plaintext.

**Run** represents a completed or in-progress pipeline execution. It contains: a unique identifier, a reference to the repo, the issue number, the issue title, the pipeline variant, the current phase, the outcome (in-progress, complete, stuck, or escalated), the total cost, phases executed with duration per phase, fix attempt count, and timestamps for start and completion. Runs are synced from the daemon.

**CostEvent** represents a single cost entry. It contains: a unique identifier, a reference to the run, the session type, the cost amount, and a timestamp. Cost events enable per-day, per-repo, and per-session-type cost breakdowns.

**TeamMember** represents an invited user. It contains: a unique identifier, a reference to the user, a role (admin or viewer), and an invitation timestamp.

## API Contract

### Dashboard Web Application

The Dashboard is a server-rendered web application. It communicates with two backends:

**Auth Service (external)** — handles authentication flows. The Dashboard redirects users to the auth provider for sign-in and receives identity tokens on callback.

**Database Service (external)** — stores all persistent data. The Dashboard reads and writes repos, runs, cost events, and team members. Supports realtime subscriptions for live updates.

**Daemon API (local)** — the Dashboard communicates with the daemon over localhost for operational commands.

Dashboard API routes:

- `GET /api/repos` — list all repos with latest run status
- `POST /api/repos` — add a new repo (admin only)
- `PATCH /api/repos/:id` — update repo settings (admin only)
- `DELETE /api/repos/:id` — remove a repo (admin only, must be disabled first)
- `POST /api/repos/:id/keys` — store an API key for a repo (admin only, write-only)
- `GET /api/runs` — list runs, filterable by repo, outcome, date range
- `GET /api/runs/:id` — run detail with phase breakdown
- `GET /api/costs` — cost data aggregated by day and repo
- `GET /api/team` — list team members
- `POST /api/team` — invite a member (admin only)
- `PATCH /api/team/:id` — change role (admin only)
- `DELETE /api/team/:id` — remove member (admin only)
- `POST /api/daemon/pause` — pause the daemon (admin only, proxied to daemon)
- `POST /api/daemon/resume` — resume the daemon (admin only, proxied to daemon)
- `GET /api/daemon/status` — get daemon status (proxied to daemon)

### Daemon Configuration Sync

The Daemon fetches its repo configuration from the Database Service instead of a local config file.

**Sync flow (Daemon → Database):**
1. On startup and periodically (every 60 seconds), the Daemon queries the Database Service for all enabled repos.
2. The response includes: owner, name, branch config, budget, concurrency limit, and decrypted credentials (the Daemon uses a service-role key that can read encrypted fields).
3. The Daemon caches the result locally as JSON. If the Database Service is unreachable, the cache is used.
4. When a run completes, the Daemon writes a Run record and CostEvent records to the Database Service.

## System Boundaries

- Dashboard Service OWNS: the web UI, server-side API routes, auth flow, and team management logic.
- Database Service (external) OWNS: persistent storage for repos, runs, cost events, team members, and encrypted API keys.
- Auth Service (external) OWNS: identity verification and session tokens.
- Daemon OWNS: pipeline execution, worker dispatch, and local state. It READS repo config from the Database Service and WRITES run results back.
- Dashboard Service PROXIES daemon commands (pause, resume, status) to the Daemon's local API on port 3847.
- Dashboard Service DOES NOT execute pipelines, spawn workers, or access repositories directly.

## Event Flows

**User authentication flow:**
1. User visits the Dashboard. Middleware checks for a valid session.
2. No session → redirect to auth provider's sign-in page.
3. User authenticates with the provider → redirected back with an auth token.
4. Dashboard creates or updates the User record in the Database Service.
5. If no other users exist, assign admin role. Otherwise, check TeamMember for an existing invitation.
6. If no invitation exists, deny access (user must be invited by an admin).

**Add repository flow:**
1. Admin fills in owner, name, branch config, budget, concurrency limit.
2. Dashboard validates inputs and writes a Repo record to the Database Service.
3. Admin provides credentials (source-control token, model-provider key). Dashboard writes encrypted ApiKey records.
4. Daemon picks up the new repo on its next sync cycle (within 60 seconds).

**Run sync flow:**
1. Daemon completes a pipeline run.
2. Daemon writes a Run record to the Database Service with all phase details and cost.
3. Daemon writes CostEvent records for each session within the run.
4. Database Service broadcasts a realtime event.
5. Dashboard receives the event and updates the UI without a page refresh.

**Daemon control flow:**
1. Admin clicks "Pause" in the Dashboard.
2. Dashboard sends `POST /api/daemon/pause` to its own API route.
3. API route proxies the request to `http://localhost:3847/pause` on the Daemon.
4. Daemon pauses. Dashboard polls `/api/daemon/status` to confirm.

## Error Handling

**Auth provider unavailable:** Show an error page. The Dashboard cannot function without authentication.

**Database Service unavailable:** The Dashboard shows a degraded state indicator. Cached data (if available on the client) remains visible. Write operations fail with a clear error message.

**Daemon unreachable:** The Dashboard shows "Daemon offline" status. Repo configuration and run history remain viewable (from the Database Service). Daemon control buttons are disabled.

**Credential decryption failure:** Log the error. The affected repo cannot be polled until credentials are re-entered by an admin.

**First user denied access:** Cannot happen — the first user is always granted admin. Subsequent users without an invitation see an "Access denied — ask an admin to invite you" page.

**Run sync failure:** The Daemon retries the write on the next sync cycle. Local JSONL remains the source of truth. The Dashboard shows slightly stale data until sync succeeds.
