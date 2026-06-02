> **⛔ SUPERSEDED (2026-06-02).** This design doc's still-valid content has been folded into the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. Retained for history; the canonical specs in `.specify/` govern — do not act on it as a live instruction. See the Spec Reconciliation Ledger (`docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). <!-- RECONCILIATION-LEDGER-BANNER -->

# Command Center — Design Document

**Date:** 2026-03-19
**Status:** draft
**Domain:** auto-claude dashboard

---

## Problem

The auto-claude dashboard monitors runs and manages repositories, but the operator has no way to create new work from within it. Starting a conversation with Claude requires switching to a separate terminal or browser tab. Creating GitHub issues, editing specs, and bootstrapping new projects all happen outside the dashboard with no integration. The result is a fragmented workflow: the dashboard shows what happened, but the operator has to leave it to decide what happens next.

## Goal

A **Command Center** that makes the dashboard the operator's primary workspace for deciding, creating, and configuring — without hiding the detail that matters, while automating everything the system can safely handle on its own.

---

## Decisions

### 1. Claude Remote Control — not a custom relay

Claude Code already has `claude remote-control`, which runs locally on the server and relays the session through the Anthropic API. The dashboard does not need to build a PTY relay. It surfaces the Remote Control session as a **persistent collapsible panel**.

### 2. GitHub issue creation — native through Claude

Issue creation happens through the Claude session using existing MCPs and skills, exactly as it would in any other Claude Code session. No separate issue-creation UI is needed.

### 3. Spec editing — treated as a category of change

Editing L0–L3 specs is not a special operation. It is a ticket of category `spec`, subject to the same configurable workflow gates as any other change — with the `spec` category's SPEC gate set to `floor` (always requires human approval, cannot be automated away).

### 4. Layout — three zones

Left nav · main content · Claude panel (collapsible). The panel is a 32px slim tab when collapsed, expanding to ~320px when open. It is present on every page.

---

## Feature 1: Claude Panel

A persistent right-side panel available on every dashboard page.

### When open, shows:
- Session status dot (green = active, grey = offline)
- Session name and model/plan info
- Session URL with **Open ↗** and **QR Code** buttons
- Quick context actions (page-aware)
- Status bar: plan type, model

### Quick context actions (per page)

| Current page | Actions |
|---|---|
| `/runs/[id]` | "Share this run with Claude" · "Create follow-up issue from this run" |
| `/repos/[id]` | "Create issue for this repo" · "Review workflow matrix with Claude" |
| `/cost` | "Analyze cost trends with Claude" |
| Anywhere | "Open in new tab" · "Show QR code" |

Quick context actions open the Remote Control session URL in a new tab and copy a pre-composed, structured message to the clipboard (e.g. for "Share this run with Claude": a formatted summary of the run including repo, issue, phases, cost, and outcome). A toast notification confirms the copy: "Run context copied — paste it in your session." The user pastes it manually. This keeps the integration simple — no Claude API call, no session injection protocol required.

### Collapsed state

A 32px right-side tab with a status dot and vertical "CLAUDE" label. One click to expand.

### Infrastructure

On startup, the daemon spawns `claude remote-control` as a child process, captures the session URL from its stdout, and stores it in memory. The session URL and status are exposed via the existing `/api/daemon/status` proxy endpoint, extended to include `remote_control_url` (string | null) and `remote_control_state` (`"active"` | `"offline"`).

If the child process exits, the daemon sets `remote_control_state` to `"offline"`, clears `remote_control_url`, and attempts to restart it with exponential backoff (exact intervals are an L3 detail). After three consecutive failed restart attempts, the daemon stops retrying and sets `remote_control_state` to `"failed"` — requiring operator intervention. The dashboard surfaces a visible alert for the `"failed"` state.

The dashboard polls `/api/daemon/status` to keep the panel status dot and session URL current. Poll interval is an L3 detail; 5s is the suggested default. When the URL changes between polls (restart produced a new session), the panel updates the displayed URL without requiring a page refresh.

---

## Feature 2: Command Center Page

Route: `/command-center`

Two entry points:

**New Project** — opens the five-step wizard.

**Global Matrix Defaults** — opens the matrix editor scoped to the system-level defaults inherited by all repos.

An **Org-Level Profile** card displays the shared config repo URL (if configured), last sync time, and number of overrides active — defined as the count of matrix cells in the org-level profile that differ from system defaults.

---

## Feature 3: New Project Wizard

Route: `/command-center/new-project`

A five-step linear wizard. Each step must be valid before advancing.

### Step 1 — Basics
- GitHub org or username
- Repository name
- Description (optional)
- Visibility (private / public)
- L0 Vision starter (blank, or choose a template)

### Step 2 — Inherit
- Choose the base profile: system defaults, org-level profile (if configured), or start from scratch
- Shows a preview of the inherited gate defaults

### Step 3 — Matrix
- Inline matrix editor showing the inherited defaults
- Operator can override any non-floor gate before the repo is created

### Step 4 — Vision
- Text area for the L0 vision statement
- Quick action in the Claude panel: "Help me write the L0 vision" — pre-loads the project name and description into the running session

### Step 5 — Create
Executes the following in order, showing live progress:

1. Create GitHub repository via GitHub API
2. Commit `.specify/L0-vision.md`
3. Commit `.specify/traceability.yml` (scaffolded)
4. Commit `.auto-claude/workflow.yml` (from Step 3 configuration)
5. Commit `AGENTS.md` and `CLAUDE.md` from templates
6. Create `Repo` record in Supabase with `enabled: false`
7. Redirect to `/repos/[id]/settings` to add credentials and enable

**Partial failure handling:** If any step fails after the GitHub repository is created (step 1), the wizard surfaces an error state listing completed and failed steps with a "Retry from step N" action. Retry resumes from the failed step — completed steps are not re-executed. Deleting a partially created GitHub repo is out of scope — the operator handles cleanup manually if needed.

---

## Feature 4: Workflow Matrix Editor

Location: `/repos/[id]/settings` → Workflow tab (also accessible from `/command-center` for global defaults)

### The matrix

Rows are change categories. Columns are workflow gates. Each cell holds one of three values:

| Value | Symbol | Meaning |
|---|---|---|
| `floor` | 🛡 | Safety floor — always requires human review, cannot be changed |
| `require` | 🔒 | Human review required by default — can be set to `auto` |
| `auto` | ⚡ | Auto-proceed by default — can be set to `require` |

### Change categories (built-in)

**Tier 1 — Security & Infrastructure** (all gates floor by default): `auth`, `authorization`, `secrets`, `infra`, `data-migration`, `billing`

**Tier 2 — Data & API**: `schema`, `api-contract`, `spec`, `integration`, `dependency`

**Tier 3 — Application Logic**: `backend-logic`, `workflow`, `shared-component`, `state`, `test`

**Tier 4 — UI & Content**: `ui-feature`, `ui-layout`, `styling`, `copy`, `config`, `docs`

**Custom** — repos can define additional categories (e.g. `ai-prompt`, `llm-config`) with any tier and initial gate values.

### Workflow gates

| Gate | Controls |
|---|---|
| SPEC | Spec draft reviewed before implementation begins |
| PLAN | Implementation plan reviewed before coding starts |
| PR | Code review required before merge |
| DEPLOY | Explicit deploy approval (not auto-deploy) |
| ROLLBACK | Rollback plan must be documented before deploy |

### Most restrictive wins

When a GitHub issue spans multiple categories (e.g. `workflow` + `schema`), the gates for all matching categories are unioned. The strictest gate from any matching category applies at each step.

### Config file

The matrix is stored as `.auto-claude/workflow.yml` in each repo. The dashboard reads and writes it via the GitHub API. Every save is a git commit with a descriptive message (`chore: update workflow gates [category: schema, gate: pr → auto]`). Rolling back a gate change is a `git revert`.

### Inheritance

```
System defaults (built into auto-claude)
  └── Org-level profile (optional, shared config repo)
        └── Repo overrides (.auto-claude/workflow.yml)
```

Repos only need to declare what they override. The `extends` key is a top-level YAML key accepting either `"default"` (system defaults) or a raw GitHub URL to the org profile file.

```yaml
# Extend system defaults
extends: default

# Extend an org-level profile
extends: https://raw.githubusercontent.com/my-org/.auto-claude-defaults/main/workflow.yml
```

At sync time, the daemon fetches the URL (if not `default`), merges the org profile over system defaults, then merges the repo overrides on top. The resolved merged config is what gets written to Supabase.

**Org profile fetch failure:** If the `extends:` URL is unreachable or returns a non-200 response, the daemon logs a warning and uses the last successfully cached resolved config for that repo. It does not fall back to system defaults silently — falling back would drop intentional org-level restrictions. If no cached config exists yet (first sync), the daemon falls back to system defaults and marks the repo's matrix status as `"degraded"` in the repos table in Supabase (`matrix_status` enum: `ok | degraded | failed`) so the dashboard can surface a visible warning to the operator.

### Supabase cache

The daemon caches the merged config (system defaults → org profile → repo overrides, fully resolved) in Supabase on every sync cycle (60s). Issue evaluation reads from Supabase — no GitHub API call per issue.

**Cache invalidation — repo config:** When the dashboard saves a change to `.auto-claude/workflow.yml`, the save Server Action resolves the new merged config immediately and writes it to Supabase before returning a 200 response. The operator sees the updated state instantly. The 60s polling cycle is a safety net for out-of-band edits made directly to the file in git.

**Cache invalidation — org-level profile:** Changes to the shared org profile file affect every repo that extends it. The daemon re-fetches and re-resolves the org profile URL for all affected repos on every 60s sync cycle. There is no webhook mechanism for org profile changes — the 60s polling cadence is the propagation window. The dashboard exposes a "Force re-sync all repos" button on the Org-Level Profile card for operators who need immediate propagation. The button is disabled while a sync is in progress and re-enabled when it completes; re-triggering a sync that is already running is a no-op.

### UI behaviour

- Clicking a non-floor cell toggles between ⚡ and 🔒 instantly
- Floor cells are non-interactive with a tooltip: "Safety floor — cannot be automated"
- Cells that override an inherited value are highlighted in amber; hover shows the inherited value
- Unsaved changes show a yellow "unsaved" badge on the Save button
- "View raw YAML" opens the current file in a side drawer
- "+ Add custom category" opens an inline form at the bottom of the table

---

## The GitHub Label State Machine

Workflow state lives entirely in GitHub issue labels. The daemon processes label change events delivered by GitHub webhooks.

**Webhook setup:** When a repo is enabled in the dashboard, the dashboard registers a GitHub webhook on that repo via the GitHub API. The webhook is configured to deliver `issues` events to `POST /api/webhooks/github` on the dashboard, authenticated using a per-repo `X-Hub-Signature-256` HMAC secret stored as an `ApiKey` record (key type: `webhook-secret`). The dashboard verifies the signature before forwarding the event to the daemon over the internal Docker network.

**Missed delivery fallback:** The daemon polls each enabled repo's open issues for label changes on every 60s sync cycle. This ensures that webhook delivery failures do not permanently stall a workflow — the daemon catches up on the next poll. Polling is not a replacement for webhooks; it is a recovery path only.

### Label set

**Classification** (set by Claude at issue creation, confirmed by operator):
`size:xs` `size:s` `size:m` `size:l` `size:xl`
`spec:none` `spec:update` `spec:new`
`category:[name]` (one or more)

**Gate state** (managed by daemon and operator) — pattern `awaiting:[gate]-review` / `[gate]:approved` applies uniformly across all five gates:
`awaiting:spec-review` · `spec:approved`
`awaiting:plan-review` · `plan:approved`
`awaiting:pr-review` · `pr:approved`
`awaiting:deploy-review` · `deploy:approved`
`awaiting:rollback-review` · `rollback:approved`

**Run state**:
`ac:in-progress` `ac:blocked` `ac:complete`

### Gate flow

When a gate is configured `require`:
1. Daemon adds `awaiting:[gate]-review` and pauses
2. Operator reviews (spec draft or plan linked in issue body)
3. Operator removes `awaiting` label and adds `[gate]:approved`
4. Webhook fires → daemon resumes

When a gate is configured `auto`:
1. Daemon adds `[gate]:approved` immediately and continues (the `awaiting:[gate]-review` label is **not** added — skipping straight to approved keeps the label history clean)

The operator can always intervene manually by removing an approval label. The entire workflow is auditable from the GitHub issue label history.

### Issue classification

When creating an issue through the Claude session, Claude proposes `size:`, `spec:`, and `category:` labels based on the issue description. The operator confirms or adjusts before the issue is created (flow A — confirm before creation).

---

## System Boundaries

- **Claude Panel** owns: displaying session status, URL, QR code, quick context actions. It does not relay terminal I/O — it surfaces the Remote Control session URL only.
- **Command Center page** owns: New Project wizard, global matrix defaults editor, org profile card.
- **Workflow Matrix editor** owns: reading and writing `.auto-claude/workflow.yml` via GitHub API, displaying the merged inherited + override matrix.
- **Daemon** owns: reading the matrix from Supabase cache, evaluating gate state from issue labels, advancing or pausing the workflow, adding/removing `awaiting:[gate]-review` and `[gate]:approved` labels.
- **Claude session** owns: issue creation, spec editing, anything that requires reasoning — all through the Remote Control session with existing MCPs.

---

## What is explicitly out of scope

- Custom PTY relay or custom Remote Control client — `claude remote-control` handles this
- Separate issue-creation UI — handled by Claude + GitHub MCP
- Dedicated spec editor UI — handled by Claude
- Branching wizard flows — the New Project wizard is linear
- Real-time matrix sync across multiple browser tabs — eventual consistency is fine here

---

## Success criteria

- Operator can start a Claude session, create a GitHub issue, and bootstrap a new project without leaving the dashboard
- Every gate transition is visible in GitHub issue label history
- Rolling back a workflow matrix change is a single `git revert`
- A new installation starts with all safety floors in place and manual review on all Tier 1–2 categories
- The operator can gradually unlock gates as confidence grows, with full audit trail
