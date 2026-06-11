---
date: 2026-03-20
status: superseded
superseded_by: .specify/L0-ac-vision.md  # unified L0-AC-VISION v5 + its L1 children; the daemon polls repo config from Postgres now
superseded_date: 2026-06-11
---

# GitHub OAuth Repo Import & Multi-Repo Polling — Design

> **⛔ SUPERSEDED (2026-06-11).** The canonical specs now live in the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children in `.specify/` — the daemon polls repo configuration from Postgres now (per the Spec Reconciliation Ledger, `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). Retained for history — do not act on this doc. <!-- RECONCILIATION-LEDGER-BANNER -->

**Date:** 2026-03-20
**Status:** Approved

## Summary

Replace the manual repo-entry flow with GitHub OAuth-based repo discovery and import. Admins connect one or more GitHub accounts or organizations at the system level. They select which orgs and repos to import, then toggle polling per repo in the dashboard. The daemon dynamically reloads its poller set from the database without restart.

---

## 1. Data Model

### New table: `github_connections`

Stores each connected GitHub account or machine account.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `display_name` | text | e.g. "danieleberl (personal)" |
| `github_login` | text | GitHub username or org slug |
| `avatar_url` | text | |
| `connection_type` | text | `oauth_token` \| `github_app_installation` (future) |
| `encrypted_token` | bytea NOT NULL | `pgp_sym_encrypt` output, same pattern as `api_keys.encrypted_value` |
| `token_expires_at` | timestamptz | null for non-expiring tokens |
| `scopes` | text | comma-separated granted scopes |
| `status` | text | `active` \| `token_invalid` |
| `created_by` | uuid FK `auth.users` | |
| `created_at` | timestamptz | |

### New table: `github_orgs`

Orgs and personal accounts accessible via a connection. The system populates this table after OAuth completes.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `connection_id` | uuid FK `github_connections` | |
| `github_id` | bigint | GitHub's internal org ID |
| `login` | text | org or user slug |
| `name` | text | display name |
| `avatar_url` | text | |
| `is_selected` | bool | admin chose to import repos from this org |

### Change to `repos`

Add two nullable columns:
- `connection_id uuid FK github_connections` — links the repo to its GitHub connection. Null for manually-added repos.
- `github_status text` — allowed values: `ok` (default), `not_found`. Set to `not_found` when the daemon receives a 404 from GitHub for this repo.

### RLS policies

Both new tables require RLS enabled from creation.

**`github_connections`:**
- Authenticated users (`member` role): row-level `SELECT` policy (all rows visible to team members).
- Admins: `INSERT`, `UPDATE`, `DELETE`.
- `encrypted_token` is excluded at the column level via `REVOKE SELECT (encrypted_token) ON github_connections FROM authenticated;` in the migration. RLS row policies alone do not restrict columns. Verify with a test query confirming the column is absent from results for the `authenticated` role.
- Token reads go through `decrypt_github_token` only (see Section 4).

**`github_orgs`:**
- Authenticated users: `SELECT`.
- Admins: `INSERT`, `UPDATE`, `DELETE`.

The migration runs `REVOKE EXECUTE ON FUNCTION decrypt_github_token FROM PUBLIC`, matching the `decrypt_api_key` pattern in `001_initial.sql`. No explicit grant to `service_role` is needed — `service_role` bypasses RLS and holds execute by default.

---

## 2. OAuth Flow & Connection Management

### Prerequisites

Two environment variables: `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`. This OAuth App is separate from the one Supabase uses for user login.

### Requested scopes

`repo`, `read:org`, `read:user`

### Flow

1. Admin navigates to **Settings → GitHub Connections** and clicks "Add GitHub Account."
2. Dashboard redirects to GitHub OAuth with a `state` param (CSRF token stored in a signed, HttpOnly cookie with a 10-minute expiry).
3. GitHub prompts the user to authorize. The user can restrict access to specific orgs at this step.
4. GitHub redirects to `/api/auth/github-connection/callback?code=…&state=…`.
5. The callback route validates the state, exchanges the code for a token, fetches `/user` and `/user/orgs`, and stores the connection and orgs in the database. The token is encrypted with pgcrypto.
6. The user is redirected to Settings where the new connection appears with its accessible orgs listed.

### Managing connections

The Settings page lists each connection with its avatar, login, accessible orgs, and date added. Two actions are available:

- **Remove** — soft-deletes the connection. Repos linked to it are set to `enabled = false` and `connection_id = null`. They appear as "disconnected" in the dashboard.
- **Re-authorize** — re-runs the OAuth flow to refresh the token or change the scope.

### Token validity

GitHub OAuth tokens remain valid until revoked, so no proactive refresh loop is needed. When any GitHub API call returns 401, the system marks the connection `status = 'token_invalid'` and displays a warning banner in the dashboard. The daemon stops polling repos tied to that connection; other connections continue unaffected.

---

## 3. Repo Discovery & Import

### Entry point

The `/repos` page gains an "Import repositories" button per connected GitHub account.

### Import flow

1. Clicking the button opens a modal.
2. The modal lists all orgs for that connection (from `github_orgs`), each with a checkbox. A "Select all" toggle appears at the top.
3. For each selected org, the dashboard calls GitHub's `/orgs/{org}/repos` (or `/user/repos` for personal accounts) and displays the results in a paginated, searchable list with per-repo checkboxes and a per-org "Select all" toggle.
4. Clicking "Import selected" upserts the chosen repos into the `repos` table with `connection_id` set and `enabled = false` by default.
5. The modal closes and the imported repos appear on `/repos`, ready for the admin to enable polling.

### Import conflicts

If an imported repo matches an existing row by `owner/name`, the upsert updates `connection_id` and leaves all other settings (enabled state, poll interval, budgets) unchanged.

### `/repos` page after import

Each repo row shows: owner/name, a connection badge, a polling toggle, the poll interval (editable inline), and last-seen activity. A filter bar allows filtering by connection, enabled/disabled state, and owner.

### Re-sync

A "Sync repos" button per connection re-fetches the org's repo list from GitHub and adds any new repos (disabled by default). Repos deleted on GitHub remain in the dashboard and receive a "not found on GitHub" warning badge.

---

## 4. Daemon — Multi-Repo Polling & Dynamic Reload

### Architecture change

The daemon maintains a live map of `repoId → RepoPoller` instances. `RepoPoller` is a thin wrapper around the existing `work-detection.ts` logic, scoped to one repo. It decrypts the GitHub token via a new `decrypt_github_token(p_connection_id uuid)` Postgres function (separate from the existing `decrypt_api_key`, which operates on `api_keys` — not `github_connections`). The daemon calls `decrypt_github_token` using the service-role client and caches the result in memory for the lifetime of the poller. It polls at the repo's `poll_interval_ms` (default 30s).

### Startup

On startup, the daemon reads all `enabled = true` repos from the database and starts a `RepoPoller` for each.

### Dynamic reload — two mechanisms

1. **Explicit signal.** A new `POST /repos/reload` endpoint on the daemon's control server (`:3847`) triggers an immediate diff: new enabled repos get a poller started, disabled repos get their poller stopped. The dashboard server action calls this endpoint whenever a repo is toggled or imported.

2. **Periodic fallback.** The daemon re-reads the `repos` table every 60 seconds, catching any changes that missed the explicit signal (direct DB edits, network failures).

### Graceful disable

When a repo is disabled, its `RepoPoller` stops picking up new issues. In-flight runs for that repo complete normally. The daemon removes the poller from the map only after its active run count reaches zero; if already at zero, it removes the poller immediately.

### Wiring — control server & dashboard proxy

Add `POST /repos/reload` to the daemon's `ControlHandlers` interface in `server.ts` alongside the existing `/pause`, `/resume`, `/retry/:id` routes. The handler calls the poller-map diff function and returns `{ reloaded: true, active: number }`.

Add a new dashboard API proxy route at `packages/dashboard/app/api/daemon/repos-reload/route.ts`, matching the pattern of the existing `pause/route.ts` and `resume/route.ts` proxies.

### Backwards compatibility

`ConfigSchema.repo` in the daemon's `config.ts` must become optional (`.optional()`). On startup, the daemon branches:
- If `config.repo` is present: upsert that repo into the `repos` table (`enabled = true`, `connection_id = null`) and start its poller.
- Otherwise: load all `enabled = true` repos directly from the database.

Existing single-repo deployments that keep `repo` in their config require no other change.

---

## 5. Error Handling

| Scenario | Behavior |
|---|---|
| CSRF state mismatch in OAuth callback | Redirect to Settings with error toast; no connection stored |
| User denies GitHub authorization | Redirect to Settings with clear message |
| Token exchange fails | Server-side log; error toast in dashboard |
| Token revoked (401 from GitHub API) | Connection marked `token_invalid`; dashboard warning banner; daemon stops polling that connection's repos |
| Repo not found on GitHub (404) | Repo flagged `github_status = 'not_found'`; poller backs off; warning badge in dashboard; running tasks unaffected |
| Connection removed with active repos | Linked repos set to `enabled = false`, `connection_id = null`; shown as "disconnected" |
| `POST /repos/reload` times out (daemon down) | Dashboard ignores failure silently; 60s fallback handles it when daemon restarts |
| No `config.repo` and DB unreachable on startup | Daemon exits immediately with a clear error message; does not start with zero pollers silently |

---

## 6. Testing

### OAuth flow
- Unit: CSRF state generation and validation; token exchange request shape; pgcrypto encryption/decryption round-trip.
- Integration: callback route with mocked GitHub API — success path, user-denied, invalid state, 401 response.

### Repo import
- Unit: upsert logic for new repos; conflict handling (existing `owner/name`, `connection_id` update, other fields preserved).
- Integration: full modal flow — fetch orgs → select repos → upsert → verify `repos` table state.

### Daemon multi-repo
- Unit: `RepoPoller` start/stop lifecycle; poller map diff (add enabled, remove disabled, leave running unchanged).
- Integration: seed DB with three repos (two enabled, one disabled) → start daemon → assert two pollers running → disable one via `POST /repos/reload` → assert graceful drain (running tasks finish, no new polling from that repo).
- Integration: enable a repo while another run is in progress → assert new poller starts without affecting the running task.

### Token invalid handling
- Unit: 401 response → connection status update; poller stops; other connections unaffected.

### Backwards compatibility
- Integration: daemon starts with `auto-claude.config.json` `repo` key → repo upserted into DB → poller starts normally.

### Existing repos page
- E2e: manually-added repos still display correctly; polling toggle still works.

---

## 7. Future Upgrade Path — GitHub App

The `github_connections` table supports `connection_type = 'github_app_installation'`. When a GitHub App is added later:

- A new installation flow writes a row with `connection_type = 'github_app_installation'` and the installation ID instead of a token.
- The daemon's token-fetching layer reads `connection_type` and calls the GitHub App JWT generation path instead of using a stored token.
- The dashboard UI, repo import flow, polling toggle, and error handling remain unchanged.

Every other part of the system remains unchanged.
