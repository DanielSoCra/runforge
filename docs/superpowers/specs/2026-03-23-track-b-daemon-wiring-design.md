# Design: Track B — Daemon Wiring, Simplification, and PO Live

**Date:** 2026-03-23
**Status:** Draft
**Scope:** Strip multi-repo from daemon, strip GitHub repo flow from dashboard, implement PO tools, wire coordination into daemon startup, end-to-end test

## Problem

The auto-claude daemon has all coordination components built and tested (PO agent, coordinator, merge agent, terminal server, batch manager, work claimer) but none are wired into the daemon's startup sequence. The daemon also carries multi-repo complexity (RepoManager, DB-mode vs legacy-mode, per-repo state namespacing) that is premature — a single-daemon-per-repo architecture is simpler, scales better to containers, and removes an entire abstraction layer. The dashboard has GitHub repo connection UI that is dead in the single-daemon model.

The PO agent's `spawnPOSession()` is a stub — it needs a prompt template and MCP tools so it can analyze the codebase and generate proposals.

## Architecture Decision: Single Daemon Per Repo

Each daemon instance manages exactly one repository. Multiple repos means multiple daemon processes.

**Why this is better than multi-repo-per-daemon:**
- Process isolation: one crash affects one repo, not all
- Horizontal scaling: distribute daemons across machines or containers
- Simple state: flat `state/` directory, no per-repo namespacing
- Simple config: one repo, one set of limits
- Container-native: one daemon = one container, managed by orchestrator

**Scaling path:**

| Phase | Runtime | Fleet management |
|---|---|---|
| Now (1-3 repos) | launchd on Mac mini | Shell script |
| Soon (10-20 repos) | Docker Compose | `docker compose up -d` |
| Scale (100+ repos) | Kubernetes | Helm chart + repo controller |

The fleet controller (which daemons should exist) is a separate concern built later — not part of the daemon.

## Changes

### 1. Strip Multi-Repo from Daemon

**Remove:**
- `RepoManager` class and all DB-mode polling (`pollRepos`, `processRepo` iteration)
- DB-mode vs legacy-mode conditional branching in `daemon.ts`
- Per-repo concurrency config and per-repo state namespacing
- Supabase repos table dependency for core daemon operation

**Simplify config to:**
```yaml
repo: owner/repo-name
githubToken: $GITHUB_TOKEN
stateDir: ./state
supabaseUrl: $SUPABASE_URL          # optional — for dashboard sync
supabaseServiceKey: $SUPABASE_KEY   # optional
budget:
  dailyLimitUsd: 50
coordination:
  tickIntervalMs: 30000
  maxAgents: 4
  diskSpaceThresholdMb: 1000
  po:
    intervalMs: 1800000       # 30 minutes
    debounceMs: 300000        # 5 minutes
    maxProposals: 3
    proposalExpiryDays: 7
```

**Simplified startup sequence:**
1. Validate config (single repo, token)
2. Init StateManager, CostTracker, SessionRuntime, GotchaStore, ImplementationCoordinator
3. Init coordination: WorkClaimer, BatchManager, MergeAgent, Coordinator, POAgent
4. Start ReviewScheduler
5. Start Coordinator and PO Agent
6. Start control server (REST API)
7. Self-register in Supabase (if configured)
8. Crash recovery (resume incomplete runs)
9. Enter main loop — work detection for the single repo, dispatch via coordinator

**State directory (flat, no per-repo namespacing):**
```
state/
  daemon.json
  coordination/
    proposals.json
    ideas.json
    batches.json
    merge-queue.json
    claims/
      {issue-number}.json
```

**What stays:**
- Supabase sync layer (optional) — for dashboard visibility of runs, costs, proposals
- Control server REST API
- Review scheduler
- All coordination components
- Work detection (ready work, bug fixes, feature pipeline)

### 2. Strip Dashboard GitHub Repo Flow

**Remove:**
- `/command-center` page
- GitHub repo connection OAuth flow (callback route, token exchange, storage)
- `github_connections` Supabase table
- Repo CRUD pages (`/repos`, `/repos/[id]`, `/repos/[id]/plugins`)
- Repo add/remove/enable/disable API routes

**Keep:**
- Supabase auth with GitHub provider (dashboard login for team members)
- All non-repo pages: `/runs`, `/runs/[id]`, `/cost`, `/team`, `/settings`, `/briefing`

**Add:**
- `daemons` Supabase table: `(id, repo_owner, repo_name, url, status, last_heartbeat, created_at)`
- `proposals` Supabase table: `(id, repo_owner, repo_name, title, rationale, status, spec_references, estimated_scope, created_at, expires_at, decided_at, decision_notes)`
- Replace `/repos` with fleet status page reading from `daemons` table (read-only — shows which daemons are running, their repo, status, pending proposals)
- Update `/briefing` page to show pending proposals with approve/reject buttons

**Dashboard becomes:** Read-only fleet aggregator + proposal approval UI. No repo CRUD.

### 3. PO Session Tools

Four MCP tools the PO session uses to gather signals and act. Implemented in a new file `packages/daemon/src/coordination/po-tools.ts`.

**`scan_spec_pipeline()`**
- Reads `.specify/` directory and `traceability.yml`
- Returns list of specs with: specId, layer (L0/L1/L2/L3), status, whether next layer exists, whether implemented
- Pure filesystem read — no external dependencies

**`get_backlog()`**
- Queries GitHub API for open issues on the configured repo
- Returns issues with: number, title, labels, age (days since creation), staleness (days since last activity)
- Filters out: `in-progress`, `blocked`, `review-finding` labels (not executable backlog)
- Uses Octokit (already available in daemon)

**`create_proposal(title, rationale, specReferences?, estimatedScope?)`**
- Writes new proposal to `state/coordination/proposals.json`
- Sets status `proposed`, generates UUID, sets `expiresAt` from config
- Syncs to Supabase proposals table (if configured)
- Returns created proposal with ID

**`list_proposals(statusFilter?)`**
- Already exists in terminal server handlers
- Reads from `state/coordination/proposals.json`
- PO uses this to check proposal history (avoid re-proposing rejected work)

Tools are registered as MCP tools on the PO session via session options.

### 4. PO Prompt Template and Daemon Wiring

**Prompt template** at `packages/daemon/prompts/po.md`:

The PO session receives:
- System identity: "You are the Product Owner agent for {{repoName}}"
- Available tools: `scan_spec_pipeline`, `get_backlog`, `create_proposal`, `list_proposals`
- Analysis instructions:
  1. Check proposal history (avoid duplicates)
  2. Scan spec pipeline (find gaps)
  3. Read backlog (find stale/ready items)
  4. Analyze signals together, prioritize: spec advancement > stale work > backlog
  5. Create at most {{maxProposals}} proposals per cycle
- Constraints: no implementation details, no direct work creation, silence is valid output
- Pending ideas: {{pendingIdeas}} (operator-submitted ideas to refine)

**`spawnPOSession` implementation:**

The PO agent's `spawnPOSession` callback:
1. Loads pending ideas from ideas store
2. Calls `runtime.spawnSession('po', { repoName, maxProposals, pendingIdeas })` with PO tools registered
3. Session runs, calls tools, creates proposals
4. On completion, syncs any new proposals to Supabase

**Daemon REST API additions:**
- `POST /proposals/:id/approve` — approves proposal, creates GitHub issue with `ready` label via Octokit, updates local state, syncs to Supabase
- `POST /proposals/:id/reject` — rejects proposal with decision notes, updates local state, syncs to Supabase
- `GET /proposals` — lists proposals (shortcut for terminal/dashboard)

**Daemon self-registration:**
- On startup, writes entry to Supabase `daemons` table with repo, URL, status
- Periodic heartbeat updates `last_heartbeat`
- On clean shutdown, marks status as `stopped`

### 5. End-to-End Test Plan

**Prerequisites:** Daemon built with Track B changes, config file, empty state directory.

**Test sequence:**

1. Start daemon — verify clean boot, coordinator tick logged, PO cycle scheduled
2. Check self-registration — verify `daemons` entry in Supabase (if configured)
3. Wait for first PO cycle (or trigger via REST `POST /po/trigger`) — verify PO session:
   - Calls `scan_spec_pipeline()` — finds spec gaps
   - Calls `get_backlog()` — finds open issues
   - Calls `list_proposals()` — sees empty
   - Calls `create_proposal()` — generates 1-3 proposals
4. Check proposals — verify in `state/coordination/proposals.json` and Supabase
5. Approve a proposal — `POST /proposals/:id/approve` — verify GitHub issue created with `ready` label
6. Watch work detection — next tick picks up the new `ready` issue and claims it
7. Verify coordination loop — claim → dispatch worker → completion → merge queue

Steps 1-5 validate the PO → proposal → approval → issue path. Steps 6-7 validate the full loop (already tested infrastructure, mainly verifying it works with the new wiring).

## Workstream Dependencies

```
1. Strip multi-repo ──────────┐
                               ├──► 4. PO prompt + daemon wiring ──► 5. E2E test
3. PO tools ──────────────────┘

2. Strip dashboard repo flow ──► (independent, can parallel with 1+3)
```

Workstreams 1, 2, and 3 can run in parallel. Workstream 4 depends on 1 and 3. Workstream 5 depends on all.

## What This Does NOT Include

- Tech Lead agent wiring (Track A pipeline will generate L2/L3 and implement)
- Fleet controller (future — manages which daemons exist)
- Delivery stats tool for PO (v2 signal source)
- Dashboard proposal approval UI updates (can be a fast follow after the REST endpoints exist)
- Terminal server integration (already built, wiring deferred to after PO is running)
