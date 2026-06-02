> **🗄 HISTORICAL (2026-06-02).** Completed/superseded record, kept for provenance — superseded by the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. The canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

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
- Per-repo state namespacing
- Supabase repos table dependency for core daemon operation
- Legacy polling loop (replaced by Coordinator tick-based dispatch)

**Keep `perRepoLimits` in `CoordinatorConfig` but always pass `{}`** — removing it requires changing `EvalContext` and the pool evaluation algorithm in `concurrency.ts`. Passing an empty object is simpler and backward-compatible. The field becomes a no-op in single-daemon mode.

**Supabase responsibilities audit** — what stays vs. goes:

| Supabase responsibility | Decision | Rationale |
|---|---|---|
| Repo discovery/config | Remove | Single repo in config file |
| Run persistence | Keep | Dashboard needs run history |
| Cost tracking | Keep | Dashboard cost page, budget enforcement |
| Plugin activation per repo | Keep (simplify) | Single repo, but plugins still useful |
| Global limits | Keep | Budget limits still Supabase-backed |
| Proposal sync | Add (new) | Dashboard needs proposal visibility |
| Daemon registration | Add (new) | Fleet status page |
| Repo reload/scan controls | Remove | Single repo, restart daemon instead |

**Simplify config to:**
```yaml
repo: owner/repo-name
githubToken: $GITHUB_TOKEN
stateDir: ./state
supabaseUrl: $SUPABASE_URL          # optional — for dashboard sync
supabaseServiceKey: $SUPABASE_KEY   # optional
budget:
  dailyLimitUsd: 50
  perRunBudget: 5.00                # preserved from existing config
maxConcurrentRuns: 4                # preserved, maps to coordination.maxAgents
controlPort: 3100                   # preserved
webhooks: {}                        # preserved
gracePeriodMs: 30000                # preserved
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

Existing config fields are preserved with their current names. The `coordination` section is additive. The `repo` field replaces the `repos[]` array in DB mode. Legacy single-repo config continues to work. No migration script needed.

**Simplified startup sequence:**
1. Validate config (single repo, token)
2. Init StateManager, CostTracker, SessionRuntime, GotchaStore, ImplementationCoordinator
3. Init RemoteControlManager (handles remote pause/resume)
4. Init coordination: WorkClaimer, BatchManager, MergeAgent, Coordinator, POAgent
5. Start ReviewScheduler
6. Start Coordinator and PO Agent
7. Start control server (REST API)
8. Self-register in Supabase (if configured)
9. Crash recovery (resume incomplete runs)

**No main loop** — the Coordinator's tick replaces the legacy polling loop. Work detection is called by the Coordinator on each tick (see "Coordinator Wiring" in Section 4).

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

**Shutdown sequence:** Coordinator (`coordinator.stop()`), PO Agent (clear interval), ReviewScheduler, RemoteControlManager, control server. RepoManager and legacy poller removed.

### 2. Strip Dashboard GitHub Repo Flow

**Remove:**
- `/command-center` page
- GitHub repo connection OAuth flow (callback route, token exchange, storage)
- `github_connections` Supabase table
- Repo CRUD pages (`/repos`, `/repos/[id]`, `/repos/[id]/plugins`)
- Repo add/remove/enable/disable API routes, specifically:
  - `packages/dashboard/app/api/github/connections/` (entire directory)
  - `packages/dashboard/actions/github-connections.ts`
  - `packages/dashboard/components/github-connections-section.tsx`
  - `packages/dashboard/app/(dashboard)/command-center/` (entire directory)
  - Sidebar link to command center in `packages/dashboard/components/sidebar.tsx`

**Keep:**
- Supabase auth with GitHub provider (dashboard login for team members)
- All non-repo pages: `/runs`, `/runs/[id]`, `/cost`, `/team`, `/settings`, `/briefing`

**Add:**
- Supabase migration file (next sequential number after existing migrations in `packages/dashboard/supabase/migrations/`)
- `daemons` table: `(id uuid primary key, repo_owner text, repo_name text, url text, status text, last_heartbeat timestamptz, created_at timestamptz default now())`. Dashboard treats `last_heartbeat` older than 5 minutes as "unresponsive".
- `proposals` table: `(id uuid primary key, repo_owner text, repo_name text, title text, rationale text, status text, related_specs text[], scope text, created_at timestamptz default now(), expires_at timestamptz, decided_at timestamptz, decision_notes text)`. Column names match the existing `Proposal` type fields (`related_specs` ↔ `relatedSpecs`, `scope` ↔ `scope`).
- Replace `/repos` with fleet status page reading from `daemons` table (read-only)
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

**`create_proposal(title, rationale, relatedSpecs?, scope?)`**
- Parameter names match the existing `Proposal` type fields
- Writes new proposal to `state/coordination/proposals.json`
- Sets status `proposed`, generates UUID, sets `expiresAt` from config
- Syncs to Supabase proposals table eagerly (if configured) — dashboard sees proposals in real-time
- Deduplication: rejects proposals with duplicate titles within a 24-hour window
- Returns created proposal with ID

**`list_proposals(statusFilter?)`**
- Extract the handler logic from terminal server (`listProposalsHandler`) into a shared function in `po-tools.ts`. Both terminal server and PO session call the same function.
- Reads from `state/coordination/proposals.json`
- PO uses this to check proposal history (avoid re-proposing rejected work)

**Tool registration mechanism:** The PO tools are hosted as a **local MCP server** started by the daemon before spawning the PO session. The daemon starts a lightweight MCP server (on a Unix socket or local TCP port) that exposes the four PO tools. The PO session receives this server's address as an `mcpConfig` entry — using the existing `mcpConfigs` field on `ProviderAdapter.spawn()`. This requires no changes to the adapter interface or `AgentDefinition` type. The local MCP server is started before the PO session and stopped after it completes.

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
- Pending ideas: {{pendingIdeas}} (operator-submitted ideas to refine, serialized as JSON string)

**SessionType and AgentDefinition additions:**

Add `'po'` to the `SessionType` union in `packages/daemon/src/types.ts`. Audit all `switch (type: SessionType)` exhaustiveness patterns for breakage. Add a PO entry to `DEFAULT_AGENT_DEFS`:
```
po: {
  name: 'po',
  promptFile: 'po.md',
  maxTurns: 20,
  budgetPerSession: 0.50
}
```

Note: tools are NOT in `AgentDefinition` — they're provided via the local MCP server (see Section 3).

**`spawnPOSession` implementation:**

The PO agent's `spawnPOSession` callback:
1. Loads pending ideas from ideas store
2. Starts the local PO MCP tool server (if not already running)
3. Calls `runtime.spawnSession('po', { variables: { repoName: config.repo, maxProposals: String(config.maxProposals), pendingIdeas: JSON.stringify(pendingIdeas) } }, 0)` — issueNumber `0` since PO is not tied to a specific issue. All variable values are strings (as required by `SessionContext.variables`).
4. Session runs, calls tools via MCP, creates proposals
5. Stops the local MCP server after session completes

**POAgent interface change:** Add `runCycle(): Promise<void>` to the `POAgent` interface (currently `runCycle` is a private closure). Needed for the `/po/trigger` endpoint.

**PO session error handling:** If `spawnPOSession` fails (budget exceeded, rate limited, adapter crash), the error is logged and the cycle is retried on the next scheduled interval. Partial proposal creation is acceptable since each tool call is independent and proposals are idempotent-ish (deduplication prevents exact duplicates).

#### Coordinator Wiring (CoordinatorDeps implementation)

This is the core integration. Each `CoordinatorDeps` field maps to an existing daemon component:

| CoordinatorDeps field | Implementation |
|---|---|
| `workClaimer` | `createWorkClaimer(stateDir)` — already implemented, file-based |
| `batchManager` | `createBatchManager(stateDir)` — already implemented, file-based |
| `mergeAgent` | `createMergeAgent(deps)` — already implemented |
| `spawnWorker(claim, decision)` | See below |
| `checkDiskSpace()` | Call `checkDiskSpace()` from `packages/daemon/src/infra/disk.ts` |
| `getDispatchQueue()` | See below |
| `getActiveClaimRepoKeys()` | `workClaimer.getActiveClaims().map(c => c.repoKey)` |
| `isPaused()` | Reference `remoteControl.isPaused() \|\| daemon.paused` |
| `isShuttingDown()` | Reference `daemon.shuttingDown` flag |
| `onMergeAgentCrash(cb)` | Register crash handler on merge agent |
| `protocolOrchestrator` | Leave `undefined` for now — future work |

**`getDispatchQueue` adapter:**

Calls the three work detection functions and converts results to `DispatchQueueItem[]`:

```typescript
async function getDispatchQueue(): Promise<DispatchQueueItem[]> {
  const items: DispatchQueueItem[] = [];
  const ready = await detectReadyWork(octokit, repo);
  const bugFix = await detectBugFixWork(octokit, repo);
  const feature = await detectFeaturePipelineWork(octokit, repo);

  // Cache full WorkRequest objects for spawnWorker to look up later
  for (const wr of [...ready, ...(bugFix ? [bugFix] : []), ...(feature ? [feature] : [])]) {
    workRequestCache.set(wr.issueNumber, wr);
    items.push({ issueNumber: wr.issueNumber, repoKey: `${repo.owner}/${repo.name}` });
  }
  return items;
}
```

**`spawnWorker` adapter:**

Bridges Coordinator's dispatch decision to the existing work processing:

```typescript
async function spawnWorker(claim: WorkerClaim, decision: SpawnDecision): Promise<void> {
  // 1. Update GitHub labels (unify claiming systems)
  const wr = workRequestCache.get(claim.issueNumber);
  if (wr) {
    await claimWorkOnGitHub(octokit, repo, wr); // Updates GitHub labels
  }

  // 2. Spawn the session via existing processWorkRequest
  await processWorkRequest(wr, runtime, config);
}
```

**Claiming unification:** Both claiming systems are used:
- `WorkClaimer.claim()` — local state tracking (Coordinator manages this internally)
- `claimWorkOnGitHub()` — GitHub label manipulation (called by `spawnWorker`)

The Coordinator claims locally first (atomic, fast), then `spawnWorker` updates GitHub labels. If GitHub label update fails, the local claim still prevents re-dispatch on the next tick. The GitHub label is a visibility aid, not the source of truth for dispatch.

#### `review-finding` L0 Boundary Fix

The current `detectBugFixWork()` in `work-detection.ts` auto-detects `review-finding` labeled issues as executable bug-fix work. This violates the L0 boundary: review findings must NOT become executable work without the PO → Tech Lead → operator approval chain (see FUNC-AC-QUALITY v3, "Proactive review work detection boundary" scenario).

**Fix:** Modify `detectBugFixWork()` to exclude issues that ONLY have the `review-finding` label. Bug fixes should require an additional label (e.g., `auto-fix-approved` which already exists) to be picked up. Issues with `review-finding` alone are signal inputs for the Tech Lead, not work items.

#### Terminal Server Process Model

The terminal server uses stdio MCP transport. It cannot share the daemon's stdout/stderr (contention with daemon logging). Two options:

**(A) Separate entrypoint** — `auto-claude-terminal` binary that connects to the daemon's REST API. The terminal server is a thin CLI tool, not part of the daemon process. Simple but requires the daemon REST API to expose everything the terminal needs.

**(B) Child process** — Daemon spawns the terminal server as a child process with its own stdio. The child communicates with the daemon via IPC.

**Decision: (A) for v1.** The daemon REST API already has `/proposals/:id/approve`, `/proposals/:id/reject`, `GET /proposals`, `POST /po/trigger`, `/pause`, `/resume`, `/status`. The terminal server becomes a thin MCP wrapper around REST calls. This is simpler and doesn't require IPC.

**Daemon REST API additions:**
- `POST /proposals/:id/approve` — approves proposal, creates GitHub issue with `ready` label (using the `labels` parameter on issue creation for atomicity), updates local state, syncs to Supabase
- `POST /proposals/:id/reject` — rejects proposal with decision notes, updates local state, syncs to Supabase
- `GET /proposals` — lists proposals (shortcut for terminal/dashboard)
- `POST /po/trigger` — manually triggers a PO cycle (calls `poAgent.runCycle()`). Requires adding `runCycle` to the `POAgent` public interface.

**Daemon self-registration:**
- On startup, writes entry to Supabase `daemons` table with repo, URL, status
- Periodic heartbeat updates `last_heartbeat` (every 60 seconds)
- On clean shutdown, marks status as `stopped`
- Dashboard treats `last_heartbeat` older than 5 minutes as "unresponsive"

### 5. End-to-End Test Plan

**Prerequisites:** Daemon built with Track B changes, config file, empty state directory.

**Test sequence:**

1. Start daemon — verify clean boot, coordinator tick logged, PO cycle scheduled
2. Check self-registration — verify `daemons` entry in Supabase (if configured)
3. Trigger PO cycle via `POST /po/trigger` — verify PO session:
   - Calls `scan_spec_pipeline()` — finds spec gaps
   - Calls `get_backlog()` — finds open issues
   - Calls `list_proposals()` — sees empty
   - Calls `create_proposal()` — generates 1-3 proposals
4. Check proposals — verify in `state/coordination/proposals.json` and Supabase
5. Approve a proposal — `POST /proposals/:id/approve` — verify GitHub issue created with `ready` label (atomic via `labels` parameter)
6. Watch work detection — next coordinator tick picks up the new `ready` issue, claims locally + updates GitHub labels
7. Verify coordination loop — claim → dispatch worker → completion → merge queue

Steps 1-5 validate the PO → proposal → approval → issue path. Steps 6-7 validate the full loop.

**Rollback plan:** If coordinator dispatch causes issues, the legacy polling loop code can be restored from git. The migration is all-in-one (no feature flag) but the risk is mitigated by the coordinator being already tested in isolation.

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
- Terminal server as full MCP client (v1 is a thin REST wrapper)
- `protocolOrchestrator` wiring in Coordinator (future work)
