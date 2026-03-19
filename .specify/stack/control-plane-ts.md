---
id: STACK-AC-CONTROL-PLANE
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-CONTROL-PLANE
code_paths:
  - src/control-plane/
test_paths:
  - src/control-plane/**/*.test.ts
---

# STACK-AC-CONTROL-PLANE — Daemon Control Plane (TypeScript)

## Pattern

**Explicit state machine for pipeline FSM.** A plain TypeScript object mapping `(state, event) → { nextState, action }`. No state machine library — the transition table is small enough to be a literal object and easier to test than a framework. States and events are string union types enforced by TypeScript.

**Polling loop for work detection.** `setInterval` with configurable period. Each tick calls the GitHub API, processes results, and schedules work. The loop is the daemon's heartbeat.

**HTTP server for operator control.** A minimal HTTP server (Node.js `http` module, no framework) bound to a configurable port. The port also serves as the instance lock — if the port is in use, a second instance fails to bind. Endpoints: `/status`, `/health`, `/pause`, `/resume`, `/retry/:issue`, `/release`, `/logs`.

## Key Decisions

**FSM: Plain transition table.** Chosen over XState (too heavy — we need ~10 states and ~15 transitions, not a visual state chart editor). The transition table is a `Record<Phase, Record<Event, { next: Phase; action: () => Promise<void> }>>`. Type-safe, testable, zero dependencies.

**Work queue: GitHub Issues via Octokit.** `@octokit/rest` for API calls. Poll for issues with the "ready" label. Swap to "in-progress" on claim. The label state machine (ready → in-progress → complete/stuck/needs-spec-update/needs-human) is the external-visible status. Chosen over `gh` CLI (Octokit gives typed responses and better error handling for a long-running daemon).

**Instance lock: Port binding.** The HTTP server binds to a configured port. If another instance tries to bind, it gets `EADDRINUSE` and exits. Simpler and more reliable than file-based locks (no stale lock problem). The port also serves the control API — two concerns, one mechanism.

**State persistence: JSON files.** `RunState` written to `state/runs/{issue-number}.json` via atomic write (see STACK-AC-CONVENTIONS). `DaemonState` written to `state/daemon.json`. On crash recovery: scan `state/runs/` for incomplete runs, restore FSM position.

**Notifications: Webhook POST with retry.** A configurable array of webhook URLs. Each notification is a POST via `fetch()` with a JSON body containing event type, issue number, phase, and message. On failure: retry once after 5 seconds. On second failure: log a warning and continue — notification failure must not block pipeline execution. Timeout: 10 seconds per request.

**Results ledger: JSONL file.** Append-only `state/results.jsonl`. One JSON object per completed run. Query by reading + filtering. Simple, crash-safe, no database.

**CLI: Commander.js.** `auto-claude start`, `auto-claude status`, `auto-claude pause`, `auto-claude resume`, `auto-claude retry <issue>`, `auto-claude release`, `auto-claude logs [issue]`, `auto-claude proposals`. The CLI commands call the HTTP control API — the daemon is always the server, the CLI is always the client.

**Concurrent runs: Semaphore pattern.** A simple counter tracks active runs. The polling loop checks `activeRuns < config.maxConcurrentRuns` before claiming a new issue. When the limit is reached, new issues stay in "ready" state until a slot opens. No external semaphore library — a plain variable suffices for single-process Node.js.

**Custom pipeline templates: Config-driven matcher.** Pipeline variants are loaded from `config.pipelines` (an array of `{ name, match, phases }`). The `match` field is a label pattern or spec-type filter. On work request claim, iterate matchers in order; first match wins. Built-in variants (feature, feature-simple, bug) are hardcoded as defaults if no custom template matches.

**Integration flow: Lock + rebase + PR.** Acquire an in-memory mutex (single-process, so a boolean flag suffices). Rebase the feature branch onto the latest staging branch via `git rebase staging`. If rebase conflicts: delegate to Implementation Coordinator's conflict resolver. Create an integration PR via `octokit.pulls.create()` from feature branch to staging. Delegate diff review to Validation Service. On review pass: auto-merge via `octokit.pulls.merge()`. On review fail: route findings to fix cycle, release lock, re-acquire when ready.

**Release proposal: Staging-to-production PR.** On `auto-claude release`: create a PR from staging to production branch via Octokit. Aggregate release notes from the results ledger (filter completed runs since last release). The PR body contains the aggregated notes. The system does NOT auto-merge — the Operator reviews and merges manually.

**Circular fix detection: Error hash tracking.** Normalize errors by stripping timestamps, line numbers, and resource-specific identifiers (regex patterns). Hash the normalized error string via `crypto.createHash('sha256')`. Store error hashes with counts in `RunState.errorHashes: Record<string, number>`. If any hash reaches 3, transition to stuck immediately.

**Graceful shutdown: Signal handling + drain.** Register `process.on('SIGTERM')` and `process.on('SIGINT')`. On signal: stop the polling interval, set `paused = true`, start a grace period timer via `AbortController.timeout(config.gracePeriodMs)`. Wait for active runs to complete (or abort on timeout). Flush all RunState files. Close the HTTP server. Release the port.

## Examples

```typescript
// FSM transition table (excerpt)
const transitions: TransitionTable = {
  classify: {
    success: { next: 'decompose', action: runDecompose },
    'success:simple': { next: 'implement', action: runImplement },
    failure: { next: 'stuck', action: handleStuck },
  },
  implement: {
    success: { next: 'review', action: runReview },
    failure: { next: 'implement', action: retryOrEscalate },
  },
  // ...
};
```

```typescript
// Work detection polling with concurrency limit
const poller = setInterval(async () => {
  if (activeRuns >= config.maxConcurrentRuns) return;
  const issues = await octokit.issues.listForRepo({
    owner, repo, labels: 'ready', state: 'open', per_page: 100,
  });
  for (const issue of issues.data) {
    if (activeRuns >= config.maxConcurrentRuns) break;
    claimAndProcess(issue); // fire-and-forget, tracked by activeRuns counter
  }
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
- Always bind the control API to `127.0.0.1`, never `0.0.0.0`. The control API has no authentication and must only be accessible locally. On a Hetzner server with a public IP, binding to all interfaces exposes pause/resume/retry to the internet.
- JSON state files: on crash recovery, a partially written file is invalid JSON. The atomic write pattern (temp + rename) prevents this, but the code must still handle the case where the temp file exists but the rename didn't happen. On startup: clean up any `.tmp` files in `state/`.
- Commander.js: the CLI binary should be the same entry point as the daemon (`auto-claude start` runs the daemon, other subcommands hit the HTTP API). This avoids having two binaries.
- Integration lock is an in-memory boolean. If the daemon crashes while holding it, the lock is automatically released on restart. No stale lock problem.
- Cross-run rebase conflicts: if `git rebase staging` fails, spawn a Conflict Resolver session via Implementation Coordinator with the conflicting diff and spec intent. This is the same resolver used for unit-level conflicts.
