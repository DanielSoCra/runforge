---
date: 2026-03-20
status: superseded
superseded_by: .specify/L0-ac-vision.md  # unified L0-AC-VISION v5 + its L1 children (per the 2026-05-29 spec-reconciliation ledger)
superseded_date: 2026-06-11
---

# Issues Board & Session Controls — Design Spec

> **⛔ SUPERSEDED (2026-06-11).** The canonical specs now live in the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children in `.specify/` (per the Spec Reconciliation Ledger, `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). Retained for history — do not act on this doc. <!-- RECONCILIATION-LEDGER-BANNER -->

**Date:** 2026-03-20
**Status:** Approved

## Problem

Two gaps in the current operator experience:

1. The Claude Console panel shows "Waiting for session…" indefinitely when `claude remote-control` fails or never starts. There is no way to recover from the UI — the only option is to SSH into the server and restart the daemon manually.

2. There is no way to see which GitHub issues are visible to the daemon, why an issue is not being picked up, or trigger an immediate scan without waiting for the next poll interval (up to 60 s).

---

## Solution Overview

Three additions:

1. **Start / Restart Session button** in the Claude Panel — recovers from `offline` and `failed` session states without touching the server.
2. **Issues Board** — a new `/issues` page with a 5-column read-only kanban showing all open issues across enabled repos and exactly what is blocking each one from being picked up.
3. **Scan Now button** on the Issues page — immediately triggers the daemon's work-detection loop across all active pollers.

---

## Feature 1: Start / Restart Session (Claude Panel)

### Behaviour

- When `sessionState === 'offline'`: show **"▶ Start Session"** button below the "Waiting for session…" text.
- When `sessionState === 'failed'`: show **"↺ Restart Session"** button (styled with destructive border to match the existing error alert).
- Clicking either calls `POST /api/daemon/remote-control/restart`.
- Button is disabled and shows a spinner while the request is in flight.
- On success the button disappears; the existing 5 s poll loop will pick up the new state naturally.
- On error the button re-enables and shows a brief inline error message.
- Button is not shown when `sessionState === 'active'`.

### Daemon changes

**`RemoteControlManager`** — add `restart()`:
```
restart(): void
  stop()  // kills existing process, cancels restart timers, resets failure count
  start() // spawns fresh process
```
Both `stop()` and `start()` already exist; `restart()` is a thin wrapper that resets `stopped = false` and `failureCount = 0` before calling `start()`, ensuring a clean slate.

**Control server** — add `POST /remote-control/restart`:
- Calls `handlers.restartRemoteControl()` if present.
- Returns `{ restarted: true }`.

**`ControlHandlers`** — add optional `restartRemoteControl?: () => void`.

### Dashboard changes

**New API route:** `POST /api/daemon/remote-control/restart`
- Auth-gated (admin only), same pattern as `/api/daemon/pause`.
- Proxies to `DAEMON_URL/remote-control/restart` with a 5 s timeout.

**`useClaudePanel`** — add `startSession()`:
- Sets `isStarting` loading state, calls the route, clears on completion.

**`ClaudePanel`** — render button conditionally on `sessionState !== 'active'`.

---

## Feature 2: Issues Board (/issues)

### Navigation

New entry **"Issues"** added to the sidebar nav between "Runs" and "Repos".

### Page structure

`app/(dashboard)/issues/page.tsx` — server component:
1. Fetches enabled repos from Supabase.
2. For each repo, decrypts its GitHub token via `decrypt_github_token` RPC.
3. Calls GitHub API (`GET /repos/{owner}/{repo}/issues?state=open&per_page=100`) for each repo. This returns open issues only — closed issues are not fetched.
4. Fetches all runs from Supabase `runs` table (any outcome) to enrich column classification — in particular, runs with `outcome = 'complete'` represent issues the daemon finished (which are now closed on GitHub and absent from the API response).
5. Classifies issues into columns (see below).
6. Renders `<IssuesBoard>` client component with the classified data.

### Column classification (server-side, evaluated in order)

| Column | Condition |
|---|---|
| **Running** | Has `in-progress` label, OR there is a matching run in DB with `outcome = 'in-progress'` |
| **Stuck** | Has `stuck` label, OR matching run with `outcome = 'stuck'` |
| **Complete** | Has a matching run in DB with `outcome = 'complete'`. These issues are closed on GitHub (daemon calls `issues.update({state: 'closed'})`), so they will not appear in the GitHub API response. The Complete column is sourced entirely from DB runs, not GitHub. |
| **Ready** | Has `ready` label (and none of the above) |
| **Not Ready** | Everything else |

### Issue card design

**All cards** show: issue number, repo slug, title, existing GitHub labels (chips), GitHub ↗ link.

**Not Ready cards** additionally show at the bottom:
```
Missing: [ready]  — add in GitHub to queue
```

**Ready cards** show: "Queued for pickup" status line (green).

**Running cards** show: current pipeline phase from the matched DB run (e.g. "● planning").

**Complete cards**: dimmed opacity.

**Stuck cards** show: "✗ stuck — needs attention" (red).

### Error handling

If GitHub API fails for a repo, that repo's issues are omitted and a small warning banner appears at the top of the board: "Could not load issues for `owner/repo`."

If no enabled repos have a GitHub token, the board shows an empty-state prompt pointing to Settings.

### Data freshness

The page is a server component with `cache: 'no-store'` — every navigation loads fresh data. No polling. The "Scan Now" button triggers a daemon pickup attempt; it does not reload the board (the user refreshes manually or navigates away and back).

---

## Feature 3: Scan Now Button (Issues page header)

### Behaviour

- Rendered in the Issues page header, right-aligned.
- On click: calls `POST /api/daemon/issues/scan`, shows spinner, button disabled.
- On success: brief "Scanned N repos" text next to button (fades after 3 s).
- On error: brief "Daemon unreachable" message.
- Button is always visible (not admin-gated in the UI, but the API route is admin-gated).

### Daemon changes

**`RepoManager`** — add `scanNow()`:
- Iterates all active pollers (not `pendingDisable`).
- Calls `this.onPoll(repoId, owner, name, detector)` immediately for each.
- Returns `{ scanned: N }` where N is the number of pollers triggered.

**Control server** — add `POST /issues/scan`:
- Calls `handlers.scanIssues()` if present.
- Returns `{ scanned: N }`.

**`ControlHandlers`** — add optional `scanIssues?: () => Promise<{ scanned: number }>`.

### Dashboard changes

**New API route:** `POST /api/daemon/issues/scan`
- Admin-gated, same pattern as other daemon proxy routes.
- Proxies to `DAEMON_URL/issues/scan` with a 5 s timeout.

**`IssuesBoard`** — client component that owns the Scan Now button state.

---

## Out of Scope

- Creating or editing issues from the dashboard (read-only board).
- Filtering, sorting, or searching issues.
- Realtime / WebSocket updates to the board.
- Per-repo scoped views (cross-repo only for now).
- Pagination (100 issues per repo via GitHub API is sufficient for now).

---

## Files to Create / Modify

### New files
- `packages/dashboard/app/api/daemon/remote-control/restart/route.ts`
- `packages/dashboard/app/api/daemon/issues/scan/route.ts`
- `packages/dashboard/app/(dashboard)/issues/page.tsx`
- `packages/dashboard/components/issues-board.tsx`

### Modified files (existing files)
- `packages/daemon/src/control-plane/remote-control.ts` — add `restart()` method
- `packages/daemon/src/control-plane/repo-manager.ts` — add `scanNow()` method
- `packages/daemon/src/control-plane/server.ts` — add two new endpoints + handler types
- `packages/daemon/src/control-plane/daemon.ts` — wire `restartRemoteControl` and `scanIssues` handlers
- `packages/dashboard/components/claude-panel/use-claude-panel.ts` — add `startSession()`
- `packages/dashboard/components/claude-panel/claude-panel.tsx` — render Start/Restart button
- `packages/dashboard/components/sidebar.tsx` — add Issues nav item
