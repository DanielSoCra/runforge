---
id: STACK-AC-CONTROL-PLANE
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-CONTROL-PLANE
code_paths:
  - packages/daemon/src/control-plane/
test_paths:
  - packages/daemon/src/control-plane/**/*.test.ts
---

# STACK-AC-CONTROL-PLANE — Daemon Control Plane (TypeScript)

## Pattern

**Explicit state machine for pipeline FSM.** A plain TypeScript object mapping `(state, event) → { nextState, action }`. No state machine library — the transition table is small enough to be a literal object and easier to test than a framework. States and events are string union types enforced by TypeScript.

**Polling loop for work detection.** `setInterval` with configurable period. Each tick calls the GitHub API, processes results, and schedules work. The loop is the daemon's heartbeat.

**HTTP server for operator control.** A minimal HTTP server (Node.js `http` module, no framework) bound to a configurable port. The port also serves as the instance lock — if the port is in use, a second instance fails to bind. Endpoints: `/status`, `/health`, `/pause`, `/resume`, `/retry/:issue`, `/release`, `/logs`.

**`/health` reflects a truthful three-state liveness signal (B4).** The server maps a `getHealth()` result onto the HTTP status code: `ok:false → 503`; `ok:true, degraded:true → 200` with `degraded:true`; otherwise `200 ok`. The daemon supplies `getHealth` by gathering a live-state snapshot and delegating the matrix to the pure `evaluateHealth` (STACK-AC-OPERATIONAL-SAFETY). A non-governed/healthy daemon keeps the legacy `{ ok:true, degraded:false, lastConfigError:null }` shape byte-for-byte; the throwaway degraded-boot server is unchanged and hands off once the real server binds.

## Key Decisions

**FSM: Plain transition table.** Chosen over XState (too heavy — we need ~10 states and ~15 transitions, not a visual state chart editor). The transition table is a `Record<Phase, Record<Event, { next: Phase; action: () => Promise<void> }>>`. Type-safe, testable, zero dependencies.

**Work queue: GitHub Issues via Octokit.** `@octokit/rest` for API calls. Poll for issues with the "ready" label. Swap to "in-progress" on claim. The label state machine (ready → in-progress → complete/stuck/needs-spec-update/needs-human) is the external-visible status. Chosen over `gh` CLI (Octokit gives typed responses and better error handling for a long-running daemon).

**Instance lock: Port binding.** The HTTP server binds to a configured port. If another instance tries to bind, it gets `EADDRINUSE` and exits. Simpler and more reliable than file-based locks (no stale lock problem). The port also serves the control API — two concerns, one mechanism.

**State persistence: JSON files.** `RunState` written to `state/runs/{issue-number}.json` via atomic write (see STACK-AC-CONVENTIONS). `DaemonState` written to `state/daemon.json`. On crash recovery: scan `state/runs/` for incomplete runs, restore FSM position.

**Notifications: Webhook POST with retry.** A configurable array of webhook URLs. Each notification is a POST via `fetch()` with a JSON body containing event type, issue number, phase, and message. On failure: retry once after 5 seconds. On second failure: log a warning and continue — notification failure must not block pipeline execution. Timeout: 10 seconds per request. **Empty-channel delivery is non-silent (B1):** the daemon routes auto-pause/escalation/crash alerts through a single `notifyOperator` closure that, when `hasConfiguredAlertChannel(config)` is false, emits a structured local warning instead of `notify()`'s silent no-op on an empty `webhooks` array.

**Repo poller liveness snapshot (B5 input).** `RepoManager` tracks `pollStartedAt` (epoch-ms, set when `pollInProgress` flips true, cleared when false) per repo, behind an injectable clock, and exposes a read-only `pollerSnapshot()`. The work-loop watchdog reads it to detect a poll that started but never settled past the idle-timeout (a hung orchestration await). Read-only by design — the watchdog observes, it does not mutate poller state.

**Results ledger: JSONL file.** Append-only `state/results.jsonl`. One JSON object per completed run. Query by reading + filtering. Simple, crash-safe, no database.

**CLI: Commander.js.** `runforge start`, `runforge status`, `runforge pause`, `runforge resume`, `runforge retry <issue>`, `runforge release`, `runforge logs [issue]`, `runforge proposals`. The CLI commands call the HTTP control API — the daemon is always the server, the CLI is always the client.

**Concurrent runs: Semaphore pattern.** A simple counter tracks active runs. The polling loop checks `activeRuns < config.maxConcurrentRuns` before claiming a new issue. When the limit is reached, new issues stay in "ready" state until a slot opens. No external semaphore library — a plain variable suffices for single-process Node.js.

**Custom pipeline templates: Config-driven matcher.** Pipeline variants are loaded from `config.pipelines` (an array of `{ name, match, phases }`). The `match` field is a label pattern or spec-type filter. On work request claim, iterate matchers in order; first match wins. Built-in variants (feature, feature-simple, bug) are hardcoded as defaults if no custom template matches.

**Integration flow: Lock + rebase + PR.** Acquire an in-memory mutex (single-process, so a boolean flag suffices). Rebase the feature branch onto the latest staging branch via `git rebase staging`. If rebase conflicts: delegate to Implementation Coordinator's conflict resolver. Create an integration PR via `octokit.pulls.create()` from feature branch to staging. Delegate diff review to Validation Service. On review pass: auto-merge via `octokit.pulls.merge()`. On review fail: route findings to fix cycle, release lock, re-acquire when ready.

**Release proposal: Staging-to-production PR.** On `runforge release`: create a PR from staging to production branch via Octokit. Aggregate release notes from the results ledger (filter completed runs since last release). The PR body contains the aggregated notes. The system does NOT auto-merge — the Operator reviews and merges manually.

**Circular fix detection: Error hash tracking.** Normalize errors by stripping timestamps, line numbers, and resource-specific identifiers (regex patterns). Hash the normalized error string via `crypto.createHash('sha256')`. Store error hashes with counts in `RunState.errorHashes: Record<string, number>`. If any hash reaches 3, transition to stuck immediately.

**Graceful shutdown: Signal handling + drain.** Register `process.on('SIGTERM')` and `process.on('SIGINT')`. On signal: stop the polling interval, set `paused = true`, start a grace period timer via `AbortController.timeout(config.gracePeriodMs)`. Wait for active runs to complete (or abort on timeout). Flush all RunState files. Close the HTTP server. Release the port.

**Operator-retry handler: status-carrying, durable-first reset (`operator-retry.ts`).** `POST /retry/:issue` re-admits a `stuck` work request from scratch (realizes FUNC-AC-PIPELINE "Operator retries a stuck request"). The handler is async and returns a `HandlerResult<{ retrying } | ErrorBody>` (mirrors `answerDecision`) so the route emits the real status — the route `await`s it in `try/catch` and pipes `result.status`/`result.body`; an unexpected throw → 500, NaN issue → 400, missing `x-requested-by` → 403 (CSRF). It is a pure-ish function over injected deps (a narrow octokit issues surface + in-memory/run-state hooks) so the full matrix is unit-tested without GitHub/Postgres.

- **Admission rule — ORDER MATTERS.** The per-issue auto-cap adds `blocked` WITHOUT `stuck`, so `blocked` is checked BEFORE "not stuck": (1) has `blocked` (auto-capped OR manual) → **409** (budget-reset is a follow-up, not v1); (2) awaiting a decision — `decision-request` label OR an active `l2-gate`/`integrate` decision park (from the parked-run lookup) → **409** (answer the decision); (3) not `stuck` → **404**; (4) else proceed. A parked-run lookup FAILURE fails CLOSED (503) — never silently re-admit a decision-owned issue. **The lookup MUST be the STRICT reader** (`StateManager.findParkedRunsStrict()`), which PROPAGATES scan/read/parse failures; the lenient `findParkedRuns()` swallows them into `[]`, which would defeat the 503 fail-closed in production (an unreadable run store would look identical to "no parked run"). `[]` still means "no parked run → proceed"; only an error throws.
- **Work-type → entry-label restoration.** The entry label was consumed at claim, so it is RESTORED by work type, inferred label-first (run-history `workType` as fallback) via `inferRetryRestoration` (co-located with the detection tiers so they cannot drift): standard→`ready`, bug→keep `review-finding`, feature-impl→`ready-to-implement`, l3-generate→`l2-approved`, l2 tiers→`l2-in-progress`/`l1-approved`. An indeterminate work type → **409**, touching nothing (no wrong-tier re-admit).
- **From-scratch reset — durable-first ordering.** (1) In-memory ONLY (no GitHub): clear the `stuckBackoff` entry, the in-memory claim tracking (`activeIssues`), and the persisted parked/partial run state (`deleteRunState`) so detection starts a NEW run, never a resume — `releaseClaim` is deliberately NOT called (it strips GitHub tier labels). Any in-memory failure → **503**, GitHub untouched. (2) GitHub mutations, strand-safe order: (a) ADD the restored entry label FIRST, (b) strip the leftover cockpit decision body-block (`<!-- pm-cockpit:decision-request:v1 -->…<!-- /pm-cockpit:decision-request -->`) via `octokit.issues.update`, fail-closed on ambiguous/partial markers (no truncation), no-op if absent, (c) remove the stale active/claim labels (404 tolerated, real errors abort), (d) remove `stuck` LAST. Any failure before (d) leaves `stuck`+entry (still excluded → safe, retryable). (3) Best-effort audit comment — must NOT fail the already-completed retry. Returns 200 `{ retrying: issue }`; a second retry → 404 (no longer `stuck`).
- **Deferred (v1 rejects, not in scope).** Un-blocking a capped/`blocked` item (budget reset) needs a persisted operator-retry epoch + a count-after-epoch query (`RunHistoryReader` exposes only `countStuckRunsForIssue`) — a DB migration; v1 returns 409 for `blocked`. Autonomous/timer-driven re-admission is forbidden by FUNC-AC-RECOVERABLE-FAILURE-ROUTING's non-configurable fail-safe — net-new L1.

## Examples

```typescript
// FSM transition table — Record<Phase, Record<Event, { next, action }>>
const transitions: TransitionTable = {
  classify: {
    success: { next: 'decompose', action: runDecompose },
    'success:simple': { next: 'implement', action: runImplement },
  },
};
```

```typescript
// Work detection — setInterval + concurrency gate
const poller = setInterval(async () => {
  if (activeRuns >= config.maxConcurrentRuns) return;
  const issues = await octokit.issues.listForRepo({
    owner, repo, labels: 'ready', per_page: 100,
  });
}, config.pollIntervalMs);
```

```typescript
// Instance lock via port binding — localhost only
server.listen(config.controlPort, '127.0.0.1', () => {
  console.log(`daemon running on 127.0.0.1:${config.controlPort}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') process.exit(1); // another instance
});
```

```typescript
// Crash-safe state write
async function saveRunState(run: RunState): Promise<void> {
  await writeJsonSafe(`state/runs/${run.issueNumber}.json`, run);
}
```

## Gotchas

- GitHub API rate limits: 5000 requests/hour for authenticated requests. At 30-second polling interval, that's 120 req/hour for polling alone. Leave headroom for label swaps and comments. Use conditional requests (`If-None-Match`) to avoid wasting quota.
- Octokit pagination: `listForRepo` returns max 30 issues per page by default. Set `per_page: 100` and handle pagination for repos with many open issues.
- Port-based locking: if the daemon crashes without closing the port, the OS may hold the port in TIME_WAIT for 60 seconds. Set `SO_REUSEADDR` on the server socket.
- Default the control API bind address to `127.0.0.1`. The control API has no authentication and must only be accessible locally. On a Hetzner server with a public IP, binding to all interfaces exposes pause/resume/retry to the internet. Exception: in Docker multi-container deployments where the daemon has no host-exposed ports, `0.0.0.0` is acceptable because the Docker bridge network provides the isolation boundary. Use `DAEMON_HOST` env var or `controlHost` config field to override.
- JSON state files: on crash recovery, a partially written file is invalid JSON. The atomic write pattern (temp + rename) prevents this, but the code must still handle the case where the temp file exists but the rename didn't happen. On startup: clean up any `.tmp` files in `state/`.
- Commander.js: the CLI binary should be the same entry point as the daemon (`runforge start` runs the daemon, other subcommands hit the HTTP API). This avoids having two binaries.
- Integration lock is an in-memory boolean. If the daemon crashes while holding it, the lock is automatically released on restart. No stale lock problem.
- Cross-run rebase conflicts: if `git rebase staging` fails, spawn a Conflict Resolver session via Implementation Coordinator with the conflicting diff and spec intent. This is the same resolver used for unit-level conflicts.
