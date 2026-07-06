---
id: ARCH-AC-DASHBOARD
type: architecture
domain: runforge
status: draft
version: 4
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

**Briefing** represents an AI-generated status summary. It contains: a unique identifier, a status line (one sentence), a changes array (what happened since the previous briefing), an attention array (items needing human action, each with: issue number, reason, wait duration, action links), a forecast (what happens next with and without human action), a generated-at timestamp, and a signal snapshot (the raw data the summarizer consumed, retained for debugging). The Dashboard queries the most recent Briefing on page load.

**ActivityEvent** represents a single chronological event in the activity feed. It contains: a unique identifier, a timestamp, an event type (one of: `state-transition`, `merge`, `error`, `heartbeat`, `completion`), a severity (one of: `info`, `warning`, `error`), a summary (one-line human-readable description), and a links array (each with: label, URL). Activity events are written by the briefing summarizer from the signals it processes.

**NotificationChannelConfig** represents a configured notification delivery method. It contains: a unique identifier, a channel type (one of: `web-push`, `slack`, `macos`, `webhook`), a target (channel-specific destination — URL, channel name, or empty for local), and an events array (which event types to deliver: `attention-required`, `work-completed`, `error`, `digest`). This model is defined but no channel implementations exist in this version.

## API Contract

### Dashboard Web Application

The Dashboard is a server-rendered web application. It uses **server-side mutation handlers** for all Database Service mutations (repos, settings, invitations, team members, API keys) — no REST API routes are needed for these. Explicit API routes exist only for operations that cannot use server-side handlers: daemon proxy commands and any webhook receivers.

**Auth Service (external)** — handles authentication flows. The Dashboard redirects users to the auth provider for sign-in and receives identity tokens on callback.

**Database Service (external)** — stores all persistent data. The Dashboard reads and writes repos, runs, cost events, team members, and invitations. Supports realtime subscriptions for live updates.

**Daemon API (internal network)** — the Dashboard proxies operational commands to the daemon over the internal container network. The daemon's service name and port are defined in deployment configuration (L3).

Dashboard API routes (daemon proxy only):

- `POST /api/daemon/pause` — pause the daemon (admin only, proxied to daemon)
- `POST /api/daemon/resume` — resume the daemon (admin only, proxied to daemon)
- `GET /api/daemon/status` — daemon status: `{ state: "running" | "paused" | "offline", active_runs: number, version: string }` (proxied to daemon)

All other operations (CRUD for repos, settings, team, invitations, API keys) are implemented as server-side mutation handlers that query the Database Service directly from the Backend's server context.

### Briefing API

The briefing page queries the Database Service directly (no daemon proxy needed):

- `GET /briefing` — Dashboard page that renders the latest Briefing, live panels (Active Now, Needs Attention, Up Next), and the Activity Feed
- The live panels are assembled server-side from: Run records (in-progress runs), work request states (from issue tracker integration or daemon status), and the priority queue (issue labels matching pipeline stages)
- The AI briefing and activity feed are read from the Briefing and ActivityEvent tables

### Briefing Summarizer

A background process runs on a configurable interval (default: 5 minutes). It is not part of the Dashboard web application — it is a standalone scheduled job.

**Signal sources:**
1. Work request tracker (issue states, labels, timestamps) — what is in progress, queued, blocked, or waiting for review
2. Daemon state (via status endpoint or Database Service) — active runs, phases, cost
3. Version control log (recent commits on the integration branch) — what code merged
4. Pipeline heartbeat (filesystem timestamp) — is the orchestrator alive and cycling

**Summarizer output:**
1. Read all four signal sources
2. Produce a Briefing record: status line, changes since previous briefing, attention items with action links, forecast
3. Produce ActivityEvent records for each state transition detected since the previous briefing
4. Write both to the Database Service
5. If notification channels are configured (future), evaluate attention items against channel routing rules and dispatch notifications

**Cost model:** The summarizer uses a low-cost model (sufficient for structured summarization). At 5-minute intervals, estimated cost is bounded (see L3 for model selection and budget cap).

### Daemon Configuration Sync

The Daemon fetches its configuration from the Database Service instead of a local config file.

**Sync flow (Daemon reads config):**
1. On startup and periodically (interval defined in L3), the Daemon queries the Database Service for all enabled, non-deleted repos and GlobalSettings.
2. The response includes: owner, name, branch config, budget, concurrency limit, and decrypted credentials. Credentials are decrypted via a privileged database function callable only by the daemon's service-role — the dashboard runtime never calls this function (see L3 for the implementation pattern).
3. The Daemon caches the result locally as JSON. If the Database Service is unreachable, the cache is used.

**Sync flow (Daemon writes results):**
1. On each phase transition during a run, the Daemon upserts a Run record to the Database Service with the current phase, phases-so-far, and running cost. This enables live phase updates in the dashboard.
2. On run completion, the Daemon finalizes the Run record (outcome, report, total cost) and writes CostEvent records for each session within the run.
3. The Database Service broadcasts a realtime event on each upsert.

**Source of truth:** The Database Service is the canonical store for all config and run history. Local JSONL is a write-ahead buffer — if the Database Service is unreachable, run events are buffered to JSONL. On startup, the Daemon replays any unsynced JSONL entries (idempotent via run ID) before beginning normal operation.

## System Boundaries

- Dashboard Service OWNS: the web UI, server-side mutation handlers, auth flow, and team management logic.
- Database Service (external) OWNS: persistent storage for repos, runs, cost events, team members, invitations, and encrypted API keys.
- Auth Service (external) OWNS: identity verification and session tokens.
- Daemon OWNS: pipeline execution, worker dispatch, and local write-ahead state. It READS repo config from the Database Service and WRITES run results back.
- Dashboard Service PROXIES daemon commands (pause, resume, status) to the Daemon over the internal container network.
- Dashboard Service DOES NOT execute pipelines, spawn workers, or access repositories directly.
- Briefing Summarizer OWNS: periodic signal collection, AI-generated briefing production, and activity event extraction. It READS from all four signal sources and WRITES Briefing and ActivityEvent records to the Database Service. It is a standalone scheduled job, not part of the Dashboard web application or the Daemon.
- Notification Channels (future) OWNS: delivery of notifications to external systems. Channels are dispatched by the Briefing Summarizer after producing a Briefing. Channel implementations are deferred.

## Event Flows

**User authentication flow:**
1. User visits the Dashboard. Middleware checks for a valid session.
2. No session → redirect to auth provider's sign-in page.
3. User authenticates with the provider → redirected back with an auth token.
4. Dashboard creates or updates the User record in the Database Service.
5. Check TeamMember for an existing record matching the user's ID. If found → user is already a member, return their current role (re-login path — no further checks needed).
6. If no TeamMember exists and no other users exist, assign admin role atomically (single transaction — see L3).
7. Otherwise, check Invitation for a pending record matching the user's provider handle. If a matching pending Invitation exists, accept it (create TeamMember, mark invitation accepted). Otherwise deny access: "Access denied — ask an admin to invite you."

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

**Budget enforcement visibility:**
1. For each active run, the Dashboard computes the ratio of the run's current cost to the repo's per-run budget limit.
2. When cost reaches 80% of the budget limit, the Dashboard displays a warning state on the run and the repo.
3. When cost reaches 100% of the budget limit, the Dashboard displays an exceeded state.
4. Budget limits are advisory in this version — the daemon does not abort runs that exceed the limit. The 80% warning threshold is the default; making it configurable is deferred to a future iteration.
5. The Dashboard derives budget status client-side from Run.total_cost and Repo.budget_limit — no additional data model is required.

**Briefing generation flow:**
1. Scheduled job wakes up (configurable interval, default 5 minutes).
2. Reads the previous Briefing's generated-at timestamp from the Database Service to determine the time window.
3. Queries all four signal sources in parallel: issue tracker state, daemon status / Run records, version control log, pipeline heartbeat.
4. Sends the raw signal data to a low-cost model with a structured prompt requesting: status line, changes array, attention array (with action links), and forecast.
5. Writes the resulting Briefing record and ActivityEvent records to the Database Service.
6. If notification channel configs exist (future), evaluates attention items against routing rules and dispatches.

**Briefing page load flow:**
1. User navigates to /briefing.
2. Dashboard queries the latest Briefing record from the Database Service (single row, most recent).
3. Dashboard queries live panel data in parallel: in-progress Run records (Active Now), issue states matching attention criteria (Needs Attention), issue states matching pipeline priority queue (Up Next).
4. Dashboard queries recent ActivityEvent records (last N events, configurable in L3).
5. Page renders all sections. Auto-refresh interval (default 30 seconds) re-queries live panels and checks for newer Briefing.

**Notification dispatch flow (future):**
1. After the summarizer produces a Briefing, it inspects the attention array.
2. For each attention item, it checks NotificationChannelConfig records for channels subscribed to the `attention-required` event type.
3. For each matching channel, it formats the notification according to the channel type and dispatches.
4. Dispatch failures are logged but do not block briefing storage.

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

**Briefing summarizer failure:** If the summarizer fails (model error, signal source unavailable), the Dashboard displays the most recent successful Briefing with a "stale" indicator showing when it was generated. The live panels continue to function independently — they query structured data directly, not the AI summary.

**Signal source partially unavailable:** If one of the four signal sources is unreachable during summarization, the summarizer proceeds with available sources and notes the gap in the Briefing (e.g., "Git log unavailable — commit data may be incomplete"). The Briefing is still generated with partial data rather than failing entirely.

**Notification dispatch failure (future):** Failed notification deliveries are logged with the channel type, target, and error. Dispatch failures do not block briefing storage or subsequent notification attempts. The Dashboard does not retry failed notifications — the next briefing cycle will surface the same attention items if they are still unresolved.
