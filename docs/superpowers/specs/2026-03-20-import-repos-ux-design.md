---
date: 2026-03-20
status: superseded
superseded_by: .specify/L0-ac-vision.md  # unified L0-AC-VISION v5 + its L1 children (per the 2026-05-29 spec-reconciliation ledger)
superseded_date: 2026-06-11
---

# Import Repositories UX Design

> **⛔ SUPERSEDED (2026-06-11).** The canonical specs now live in the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children in `.specify/` (per the Spec Reconciliation Ledger, `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). Retained for history — do not act on this doc. <!-- RECONCILIATION-LEDGER-BANNER -->

**Date:** 2026-03-20
**Status:** Approved

---

## Goal

Replace the current flat-checkbox import modal with a split-panel dialog that supports search, filtering, and inline management of already-imported repositories.

## Current State

The existing `ImportReposModal` opens a dialog, fetches orgs, and renders a nested checkbox tree: select an org to expand its repos, then tick individual repos. There is no search, no filtering, and no way to manage already-imported repos from this surface. The layout is cramped and the UX is opaque.

## Design

### Layout

A wider dialog (`max-w-3xl`) with two panels side by side.

**Left panel (188px):** Account/org list. Each row shows an avatar (the org's `avatar_url` image; fall back to generated initials if null) and org name. Clicking a row selects it and loads its repos into the right panel. Only one org is active at a time.

**Right panel:** Toolbar, table, and footer.

### Toolbar

Three controls:

- **Search** — text input, filters the visible repo list client-side by name.
- **Visibility** — dropdown: All / Public / Private. Default: All.
- **Status** — dropdown: All / Not imported. Default: Not imported.

### Table

Two row types share the same column grid: checkbox · name · visibility · actions.

**Not-imported rows** show a checkbox, monospace repo name, and a visibility badge. The header row has a select-all checkbox. Users select repos here for bulk import.

**Already-imported rows** (visible only when Status = All) replace the checkbox with a bullet, render the name in muted text, and show two inline action buttons: **Resync** and **Remove**. These rows are not selectable for import.

### Loading States

- **Org click:** the repo panel shows skeleton rows while the GitHub API call resolves.
- **Import button:** shows a spinner while the server action runs. The button is disabled during loading.

### Footer

Left side: `N repos selected`. Right side: Cancel + Import button. The import count reflects only not-imported selections; already-imported rows do not count toward it.

---

## Behaviour

### Filtering

Filters apply client-side to the loaded repo list. The status filter hides already-imported rows by default; switching to "All" reveals them inline, sorted alphabetically with the rest.

### Import

Submits selected not-imported repos to the existing `importRepos` server action. On success, closes the modal and refreshes the page.

### Resync

Re-submits that single repo to `importRepos`, passing the modal's current `connectionId`. Updates `connection_id` to this connection without confirmation. Useful when a repo was previously imported under a different connection.

### Remove

Expands an inline confirmation inside the row before proceeding. On confirm, calls a new `removeRepo` server action that soft-deletes the repo (`deleted_at = now()`). The row disappears from the list after success. If the user re-imports the same repo afterward, `importRepos` clears `deleted_at` on the upsert conflict so the repo becomes active again.

---

## Data

| Source | How |
|---|---|
| Org list | Fetched once on modal open via `/api/github/connections/[id]/orgs` |
| Repos per org | Fetched on org click via `/api/github/connections/[id]/repos` |
| Already-imported repos | Fetched from Supabase `repos` table on modal open (`deleted_at IS NULL`); cross-referenced by `owner/name` |

Already-imported data loads in parallel with the org list so the status column is ready before the user clicks an org.

---

## Changes Required

### New

- `removeRepo(repoId: string)` server action in `actions/github-connections.ts` — calls `requireAdmin`, soft-deletes a repo (`deleted_at = now()`), revalidates `/repos`.
- `/api/github/connections/[id]/orgs` route — upgrade auth check from `getUser()` to `requireAdmin()` to match the repos route.

### Modified

- `components/import-repos-modal.tsx` — full rewrite to split-panel layout with search, filters, skeleton loading, and inline Resync/Remove.
- `importRepos` server action — update the upsert to also clear `deleted_at` on conflict, so re-importing a previously removed repo restores it.
- `/api/github/connections/[id]/orgs` route
- `/api/github/connections/[id]/repos` route
- `components/ui/checkbox.tsx`

---

## Error Handling

- GitHub API failure on org click: show an error message in the repo panel ("Could not load repositories").
- Import failure: show a toast or inline error; keep the modal open.
- Remove failure: show an inline error on the row; leave the row in place.
