> **🗄 HISTORICAL (2026-06-02).** Completed/superseded record, kept for provenance — superseded by the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. The canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Runforge — Autonomous Agent Orchestrator for Spec-Driven Development

**Date:** 2026-03-14
**Status:** Draft
**Author:** the Operator + Claude (brainstorm session)

---

## Problem

You have a complete SDD specification system (L1/L2/L3 layers, traceability, holdout scenarios). You write precise specs. But implementation still requires you to sit at a terminal, run Claude Code, review output, and shepherd each feature through to production.

The goal: write specs, walk away, get notified when the work is done and live on a dev server — then approve production releases at your leisure.

## Solution

A TypeScript daemon ("Runforge") that polls GitHub Issues for implementation requests, spawns Claude Code CLI sessions to implement them autonomously, and manages the full pipeline from spec decomposition through dev deployment, testing, and release preparation.

Two decoupled workflows connected by GitHub Issues:

- **Workflow A (Spec Author):** Interactive Claude Code sessions where you brainstorm and write specs. Outputs GitHub Issues labeled `factory-ready`.
- **Workflow B (Spec Factory):** Autonomous daemon that picks up issues and runs the implementation pipeline. Commits to `dev` branch. Creates release PRs to `main` for your approval.

---

## Architecture

### Approach: TypeScript Daemon + Claude-as-Coordinator (B+C Hybrid)

TypeScript handles the deterministic machinery — GitHub polling, process lifecycle, state tracking, notifications, restart loops. Claude handles the intelligent decisions — spec decomposition, dependency analysis, implementation, review, report generation.

The daemon is the machine. Claude is the brain.

### Layered Architecture

The codebase is organized into three layers, each depending only downward:

```
┌─────────────────────────────────────────────────┐
│  Intelligence Layer                              │
│  Complexity gating, gotcha injection             │
├─────────────────────────────────────────────────┤
│  Orchestration Layer                             │
│  State machine, agent configs, recovery manager  │
├─────────────────────────────────────────────────┤
│  Infrastructure Layer                            │
│  Worker threads, rate limits, cost, logging       │
└─────────────────────────────────────────────────┘
```

- **Infrastructure** provides raw capabilities: spawning sessions in worker threads, tracking costs, handling rate limits.
- **Orchestration** defines *how* phases execute: the state machine drives transitions, the agent config registry governs per-session behavior, the recovery manager handles checkpointing and circular fix detection.
- **Intelligence** makes *decisions*: complexity gating routes issues to the right pipeline variant, gotcha injection enriches prompts with per-repo learnings.

### Components

```
runforge/
├── src/
│   ├── index.ts                 # entry: cron loop
│   ├── config.ts                # load factory.config.yaml
│   ├── types.ts                 # all shared types
│   ├── queue/
│   │   ├── poller.ts            # gh issue list --label factory-ready
│   │   ├── claimer.ts           # label swap: factory-ready → factory-in-progress
│   │   └── parser.ts            # parse issue body → IssuePayload
│   ├── infra/
│   │   ├── worker-pool.ts       # worker thread pool with concurrency limit
│   │   ├── session-worker.ts    # worker thread entry: spawns claude CLI
│   │   ├── worker-events.ts     # typed postMessage event definitions
│   │   ├── rate-limit.ts        # rate limit detection + cooldown tracking
│   │   ├── cost.ts              # session cost parsing + daily budget
│   │   ├── secrets.ts           # credential snapshot + atomic swap
│   │   ├── control-plane.ts     # HTTP interface + port-based locking
│   │   ├── results-ledger.ts    # append-only CSV run ledger
│   │   └── logger.ts            # structured JSON logger
│   ├── orchestration/
│   │   ├── fsm.ts               # generic finite state machine engine
│   │   ├── pipelines.ts         # feature, feature-simple, bug pipeline definitions
│   │   ├── runner.ts            # wraps FSM, wires phases to state handlers
│   │   ├── agent-configs.ts     # centralized session type registry
│   │   └── recovery.ts          # checkpoint/resume + circular fix detection
│   ├── phases/
│   │   ├── detect.ts            # Phase 1: claim issue
│   │   ├── classify.ts          # Complexity assessment + pipeline routing
│   │   ├── decompose.ts         # Phase 2: coordinator → task-graph.json
│   │   ├── implement.ts         # Phase 3: parallel workers in worktrees
│   │   ├── review.ts            # Phase 4: N rounds of /deep-review
│   │   ├── holdout.ts           # Phase 5: shell-based scenario runner
│   │   ├── pr.ts                # Phase 6: PR to dev + merge
│   │   ├── deploy-dev.ts        # Phase 7: trigger dev deploy + health check
│   │   ├── test.ts              # Phase 8: smoke + playwright tests
│   │   ├── report.ts            # Phase 9: generate report + close issue
│   │   └── release.ts           # Standalone: PR dev→main
│   ├── intelligence/
│   │   ├── complexity.ts        # issue complexity assessment + routing
│   │   └── gotchas.ts           # per-repo gotcha store + injection
│   ├── claude/
│   │   ├── session.ts           # build CLI args, parse output (thin facade over worker pool)
│   │   ├── worktree.ts          # git worktree lifecycle (sparse checkout)
│   │   └── prompts.ts           # load + template prompt files
│   ├── notify/
│   │   ├── index.ts             # dispatch to configured channels
│   │   ├── markdown.ts          # write report file
│   │   ├── slack.ts             # slack webhook
│   │   └── email.ts             # SMTP/API (stub)
├── schemas/
│   ├── task-graph.json          # --json-schema for coordinator
│   ├── complexity-assessment.json # --json-schema for classifier
│   ├── bug-diagnosis.json       # --json-schema for diagnostician
│   └── report.json              # --json-schema for reporter
├── .claude/
│   └── hooks.json               # PreToolUse hook for scenario isolation
├── prompts/
│   ├── coordinator.md
│   ├── classifier.md
│   ├── worker.md
│   ├── reviewer-spec-compliance.md
│   ├── reviewer-code-quality.md
│   ├── reviewer-security.md
│   ├── conflict-resolver.md
│   ├── tester.md
│   ├── diagnostician.md
│   ├── bug-worker.md
│   ├── reporter.md
│   └── prompt-optimizer.md
├── .factory/                    # runtime worktrees (gitignored)
│   └── worktrees/
└── state/                       # local runtime state (gitignored, symlinked from ~/.runforge/state/{project}/)
```

---

## Pipeline Phases

The pipeline is driven by a finite state machine (FSM). Each phase is a state with explicit transitions. Three pipeline variants exist:

- **Feature pipeline:** detect → classify → decompose → implement → review → holdout → pr_to_dev → deploy_dev → test → close_report
- **Feature-simple pipeline:** detect → classify → implement → review → holdout → pr_to_dev → deploy_dev → test → close_report (skips decompose — single unit)
- **Bug pipeline:** detect → implement → review → pr_to_dev → deploy_dev → test → close_report (skips classify, decompose, holdout)

Any state can transition to `stuck` (retries exhausted or circular fix detected) or `paused` (budget exceeded, rate limited, or signal received). `paused` resumes from the current state.

### Phase 1: Detect

Daemon cron polls GitHub Issues: `gh issue list --label "factory-ready"`. When found, swaps label to `factory-in-progress` and parses the issue body. Only one daemon instance per repo is supported — the daemon writes a lock file (`~/.runforge/state/{repo-path-hash}/daemon.lock`) with its PID on startup and refuses to start if a live process holds the lock.

### Phase 1b: Classify (Feature Issues Only)

A lightweight one-shot Claude session (sonnet, ~$0.01) classifies the issue as `simple`, `standard`, or `complex` based on the issue body and spec list. Output is structured JSON with complexity, reasoning, estimated units, and estimated files.

- **simple** (estimated 1 unit, ≤3 files): routes to `feature-simple` pipeline — skips decompose, runs as a single implementation unit with 2 review rounds.
- **standard** (2-5 units): routes to default `feature` pipeline with config defaults.
- **complex** (6+ units or cross-cutting): routes to `feature` pipeline with +2 review rounds.

Bug issues skip classification entirely.

### Phase 2: Decompose

Coordinator Claude session (one-shot, `claude --print`) reads the issue body, referenced spec files (in understanding order: L1 → L2 → L3), and `traceability.yml`. Outputs `task-graph.json`:

```json
{
  "issueNumber": 42,
  "featureBranch": "factory/issue-42-user-auth",
  "units": [
    {
      "id": "unit-1",
      "title": "User model and migration",
      "specs": ["RAIL-USER-MODEL"],
      "specFiles": [".specify/rails/user-model.md"],
      "expectedCodePaths": ["app/models/user.rb"],
      "dependsOn": [],
      "batch": 1,
      "context": "...",
      "verificationCommand": "bundle exec rspec spec/models/user_spec.rb"
    }
  ]
}
```

The coordinator must specify a `verificationCommand` for each unit — this is how the worker verifies its implementation (used in the TDD verify steps). Units are grouped into batches. Units within a batch have no file-level overlap and run in parallel. Batches run sequentially.

### Phase 3: Implement

Per unit, in an isolated git worktree. ALL spec content is pre-loaded into the worker prompt by the daemon — workers never read spec files themselves. The protocol follows TDD (RED-GREEN-REFACTOR):

1. Daemon pre-loads: spec content (L3 → L2 → L1), unit context, known gotchas — all pasted into the prompt
2. Worker writes failing test (RED)
3. Worker verifies test fails (verify RED)
4. Worker implements code (GREEN)
5. Worker verifies test passes (verify GREEN)
6. Worker refactors if needed
7. Worker runs full unit test suite
8. Worker commits

Worktrees merge into the feature branch after each batch completes using `git merge --no-ff` for traceability. If merge conflicts occur (coordinator mispredicted file overlap), the daemon spawns a conflict-resolution Claude session. After merge, a post-merge verification step runs (compile/typecheck) before proceeding to the next batch.

### Phase 4: Review

On the merged feature branch, run **heterogeneous review gates** in sequence:

1. **Gate 1 — Deterministic:** Run tests, typecheck, lint. No Claude session needed. Cheapest and fastest.
2. **Gate 2 — Spec compliance:** Fresh Claude agent verifies acceptance criteria from the spec are met.
3. **Gate 3 — Code quality:** Fresh Claude agent reviews for maintainability, patterns, and test quality.
4. **Gate 4 — Security (complex issues only):** Fresh Claude agent reviews for security and edge cases.

Each gate is a different agent with a different prompt. If any gate finds issues, a worker is spawned to fix them, then gates re-run from gate 1. Max fix cycles configurable (default: 5). Gates can be skipped for `simple` classified issues (gates 1 + 2 only).

### Phase 5: Holdout Validation

After review rounds complete, holdout scenarios from `.specify/scenarios/` are executed. **This is NOT a Claude session.** Per AGENTS.md rule 4, no Claude agent may read scenarios — builder isolation is what makes them trustworthy. Instead, the daemon runs scenarios via a shell-based test runner (e.g., `bin/run-scenarios`) that executes the scenario files directly against the implementation without exposing their content to any LLM. The daemon checks exit codes and captures structured output. Scenario failures indicate spec gaps, not code bugs — the daemon labels the issue `needs-spec-update` and reports which scenarios failed (without revealing scenario content to any agent).

### Phase 6: PR to Dev

Create PR from feature branch to `dev`. Final `/deep-review` on the PR diff. Auto-merge.

### Phase 7: Deploy to Dev

Dev server deploys from `dev` branch (CI trigger or daemon runs deploy command). Health check polling until healthy.

### Phase 8: Smoke + UI Tests

Against the running dev server:

- API smoke tests (configured command)
- Playwright UI tests (if `has_ui: true` in issue)
- If tests fail → structured failure report → daemon creates a fix branch off `dev` (named `factory/issue-{N}-fix-{attempt}`, e.g. `factory/issue-42-fix-1`), spawns a worker Claude session with the failure context, fixes are merged back to `dev` via PR, and the deploy/test cycle repeats. The original feature branch is not reused after merging to dev. Fix attempts are tracked in `run.json` under a `fixes` array. Max fix attempts is bounded by `max_retries_per_phase` — after exhaustion the issue is labeled `factory-stuck`.

When feeding failure context to fix workers, the daemon truncates test output — last 100 lines or grep for `ERROR`/`FAIL` patterns. Full output is saved to file (`state/runs/issue-{N}/test_output.txt`); only the relevant excerpt is injected into the fix prompt. This prevents context window flooding from verbose test runners.

### Phase 9: Close Issue + Report

Update GitHub Issue with implementation report. Label `factory-complete`. Close the issue. Notify via configured channels.

### Release (Periodic or On-Demand — Not a Per-Issue Phase)

Claude session creates a PR from `dev → main` with aggregated release notes covering all completed issues since last release. Includes test summary, spec traceability, and dev server status.

**You merge the PR.** That is the only human gate.

Merging triggers production deployment via **GitHub Actions** (not the daemon). A workflow triggered by `push` to `main` creates the GitHub Release (auto-tag with semver), runs the production deploy command, performs health checks, and sends a final notification. The daemon is not involved in production deployment — it only creates the release PR and waits.

Release trigger is configurable: periodic cron, on-demand CLI command, or per-issue.

---

## Git Flow

```
main (production)
 │  Only receives PRs from dev
 │  Each merge = GitHub Release + production deploy
 │
dev (factory workspace)
 │  Dev server deploys from this branch
 │
 ├── factory/issue-42-user-auth     (feature branch)
 │   ├── worktree/unit-1            (worker worktree)
 │   └── worktree/unit-2            (worker worktree)
 │
 └── factory/issue-43-billing       (feature branch)
```

---

## GitHub Issue Format

Issues serve as the queue and the contract between Workflow A (spec authoring) and Workflow B (factory). Issue body is self-contained with rich context:

```markdown
## Summary
[2-3 sentences: what needs to be built and why]

## Specs
- FUNC-SPEC-ID (L1): .specify/functional/...
- ARCH-SPEC-ID (L2): .specify/architecture/...
- STACK-SPEC-ID (L3): .specify/flavors/...

## Scope
- [Bullet list of expected changes]

## Acceptance Criteria
- [Testable criteria from the specs]

## Config
- has_ui: true/false
- deep_review_rounds: N
- priority: high/medium/low
```

---

## Label State Machine

```
Feature Issues:
  factory-ready → factory-in-progress → factory-complete (closed)

Bug Issues:
  bug → factory-in-progress → factory-complete (closed)    [Type A: auto-fix]
  bug → needs-spec-update                                  [Type B: spec gap]
  bug → needs-human                                        [Type C: expectation mismatch]

Holdout Failures:
  factory-in-progress → needs-spec-update                  [scenario failed]

Spec Updates (after human/author fixes the spec):
  needs-spec-update → factory-ready                        [relabel to re-enter pipeline]

Error Recovery:
  ANY → factory-stuck (retries exhausted, needs human attention)
  factory-stuck → factory-ready (relabel to retry from scratch)
  factory-stuck → closed (abandon)
```

Release is not per-issue. Release = PR from dev → main, batching multiple completed issues.

---

## Bug Handling

Bugs enter as GitHub Issues labeled `bug`. The daemon runs a diagnosis session:

### Type A: Implementation Bug

Spec says X, code does Y. Factory fixes autonomously — writes regression test first, then fixes code. Uses a **bug pipeline variant** (not the standard feature pipeline):

1. **Skip decompose** — bugs are single-unit fixes, no task graph needed.
2. Use `prompts/bug-worker.md` instead of `worker.md` — receives bug report body (not spec-format), writes regression test before fixing.
3. **Skip holdout** — not applicable to targeted bug fixes.
4. All other phases (review, PR, deploy, test, close) run normally.

### Type B: Spec Gap

Spec doesn't cover the reported case. Daemon labels `needs-spec-update`, posts diagnosis with suggested spec changes. You or an interactive Claude session updates the spec, then relabels `factory-ready`.

### Type C: Expectation Mismatch

Spec and code agree, but the user expected different behavior. Labels `needs-human`. Requires your input to rethink the L1 requirement.

The diagnostician outputs structured JSON with confidence scores. Below 0.7 confidence routes to human rather than guessing.

---

## Claude CLI Session Types

All sessions use `--print` mode (headless) with `--max-turns` for agentic workflows. This means output is always captured as a return value — no streaming required. One-shot sessions use `--max-turns 1` implicitly.

**Structured output:** Coordinator, classifier, diagnostician, and reporter use `--output-format json --json-schema <schema>` to get validated JSON output. This eliminates JSON parsing failures — the CLI validates against the schema before returning.

**Per-session budget:** Every session includes `--max-budget-usd` as defense-in-depth. Even if the daemon's cost tracker has a bug, the CLI itself stops a runaway session.

### Coordinator (structured one-shot)

```bash
claude --print --model opus \
  --output-format json \
  --json-schema "$(cat schemas/task-graph.json)" \
  --max-budget-usd 5 \
  -p "$(cat prompts/coordinator.md)

## Issue
$(cat state/runs/issue-42/issue_body.md)

## Specs
$(cat .specify/functional/user-auth.md .specify/architecture/auth-flow.md .specify/rails/auth.md)

## Traceability
$(cat .specify/traceability.yml)"
```

Output is validated JSON conforming to `TaskGraph` schema. Saved to `state/runs/issue-{N}/task-graph.json`.

### Classifier (structured one-shot, cheap)

```bash
claude --print --model sonnet \
  --output-format json \
  --json-schema "$(cat schemas/complexity-assessment.json)" \
  --max-budget-usd 0.50 \
  -p "$(cat prompts/classifier.md)

## Issue Summary
$(cat state/runs/issue-42/issue_body.md)"
```

### Worker (agentic, in worktree)

```bash
cd .factory/worktrees/unit-1

claude --print --model opus \
  --dangerously-skip-permissions \
  --max-turns 200 \
  --max-budget-usd 20 \
  -p "$(cat prompts/worker.md)

## Your Unit
$(cat state/runs/issue-42/units/unit-1.json)

## Specs
$(cat .specify/rails/user-model.md .specify/architecture/user-model.md)

## Known Gotchas
$(cat state/runs/issue-42/units/unit-1-gotchas.md)"
```

Workers exit with a structured status: `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, or `NEEDS_CONTEXT`. The FSM routes accordingly:
- `DONE` → success transition
- `DONE_WITH_CONCERNS` → success, but add +2 review rounds
- `BLOCKED` → escalate to human (label `factory-stuck`) without burning retries
- `NEEDS_CONTEXT` → re-run with additional spec content from the layer above

### Reviewer (agentic, per gate)

Reviews use **heterogeneous gates** rather than N identical rounds:

```bash
# Gate 1: Deterministic — not a Claude session
npm test && npx tsc --noEmit && npx eslint .

# Gate 2: Spec compliance reviewer
claude --print --model opus \
  --dangerously-skip-permissions \
  --max-turns 50 \
  --max-budget-usd 10 \
  -p "$(cat prompts/reviewer-spec-compliance.md) ..."

# Gate 3: Code quality reviewer
claude --print --model opus \
  --dangerously-skip-permissions \
  --max-turns 50 \
  --max-budget-usd 10 \
  -p "$(cat prompts/reviewer-code-quality.md) ..."

# Gate 4: Security/edge-case reviewer (optional, for complex issues)
claude --print --model opus \
  --dangerously-skip-permissions \
  --max-turns 30 \
  --max-budget-usd 5 \
  -p "$(cat prompts/reviewer-security.md) ..."
```

Each gate is a different agent with a different prompt. Deterministic gates (tests, typecheck) run first and are cheapest. LLM gates run only if deterministic gates pass.

### Diagnostician (structured one-shot)

```bash
claude --print --model opus \
  --output-format json \
  --json-schema "$(cat schemas/bug-diagnosis.json)" \
  --max-budget-usd 5 \
  -p "$(cat prompts/diagnostician.md) ..."
```

### Reporter (structured one-shot, cheaper model)

```bash
claude --print --model sonnet \
  --output-format json \
  --json-schema "$(cat schemas/report.json)" \
  --max-budget-usd 2 \
  -p "$(cat prompts/reporter.md)

## Diff
$(git diff dev...factory/issue-42-user-auth --stat)

## Test Results
$(cat state/runs/issue-42/test_output.txt)

## Review Logs
$(cat state/runs/issue-42/reviews/summary.txt)"
```

All sessions inherit CLAUDE.md and AGENTS.md from the working directory automatically.

---

## Configuration

`factory.config.yaml` lives in the project repo root:

```yaml
project:
  name: "my-saas-app"
  repo: "user/my-saas-app"
  spec_dir: ".specify"
  main_branch: "main"
  dev_branch: "dev"

cron:
  interval_minutes: 5

claude:
  model: "opus"
  max_parallel_workers: 4
  skip_permissions: true           # maps to --dangerously-skip-permissions
  pricing:                          # USD per 1M tokens (for cost tracking)
    opus_input: 15.0
    opus_output: 75.0
    sonnet_input: 3.0
    sonnet_output: 15.0

pipeline:
  deep_review_rounds: 7
  max_retries_per_phase: 3
  worker:
    max_review_fix_cycles: 5
    skills: ["/deep-review"]

dev:
  deploy_command: "bin/deploy-staging"
  health_check_url: "https://staging.myapp.com/health"
  health_check_timeout_seconds: 120

testing:
  unit_test_command: "bundle exec rspec"
  api_test_command: "bin/test-api"
  playwright:
    enabled: true
    command: "npx playwright test"
    base_url: "https://staging.myapp.com"

production:
  deploy_command: "bin/deploy-production"
  health_check_url: "https://myapp.com/health"
  health_check_timeout_seconds: 180

release:
  trigger: "on-demand"  # or "daily", "weekly", "per-issue"
  version_strategy: "semver-auto"

notify:
  channels:
    - type: "markdown"
      path: "docs/factory-reports/"
    - type: "slack"
      webhook_url: "${SLACK_WEBHOOK_URL}"

safety:
  daily_budget_usd: 100
  max_concurrent_runs: 2
  max_total_claude_sessions: 6
  worker_timeout_minutes: 60
  review_timeout_minutes: 30
  max_retries_per_issue: 5
  cooldown_between_pickups_seconds: 30
  auto_pause_after_consecutive_stuck: 3
  shutdown_grace_seconds: 300
```

---

## Daemon Lifecycle

### CLI

```
runforge init           # scaffold factory.config.yaml
runforge start          # foreground
runforge start --daemon # background (launchd on macOS, systemd on Linux)
runforge stop
runforge status         # active runs, costs, next poll
runforge logs [--run N]
runforge pause          # stop picking up new issues
runforge resume
runforge retry N        # retry a stuck issue
runforge release        # trigger dev→main PR now
```

### Process Management

- macOS: generates `~/Library/LaunchAgents/com.runforge.{project}.plist` with `KeepAlive: true`
- Linux: generates `~/.config/systemd/user/runforge-{project}.service` with `Restart=always`
- Auto-restarts on crash. Resumes from `run.json` state.

### State & Logging

```
~/.runforge/
├── logs/{project}.log       # structured JSON, one object per line
├── state/{project}/
│   ├── daemon.json          # PID, uptime, config path
│   ├── results.csv          # append-only run ledger (issue, cost, outcome)
│   ├── gotchas.jsonl
│   └── runs/issue-{N}/
│       ├── run.json          # phase state, timing, costs
│       ├── task-graph.json
│       ├── workers/unit-{N}.log
│       ├── reviews/round-{N}.log
│       └── report.md
└── config/{project}.yaml → symlink
```

#### Results Ledger

`results.csv` is an append-only CSV written at the end of each pipeline run. Columns: `issue_number`, `started`, `completed`, `pipeline_variant`, `complexity`, `total_cost_usd`, `phases_run`, `fix_attempts`, `holdout_pass`, `outcome`. Enables cross-issue trend analysis (cost per complexity tier, fix attempt rates, holdout pass rates over time).

### Safety

- Daily token budget with auto-pause (see Cost Tracking below)
- Max concurrent runs and sessions
- Worker/review timeouts (kills stuck processes)
- Auto-pause after N consecutive stuck issues
- All safety events notify via configured channels

### Session Containment

Claude sessions running with `--dangerously-skip-permissions` have full filesystem and network access. For autonomous 24/7 operation, four containment layers apply:

1. **Worktree isolation + sparse checkout:** Workers run in git worktrees under `.factory/worktrees/`. The worktree is created with sparse checkout that **excludes** `.specify/scenarios/` — workers literally cannot see scenario files in their filesystem. (Note: The Claude CLI supports `--worktree`/`-w` for native worktree management. We manage worktrees manually because we need sparse checkout to exclude `.specify/scenarios/` — a capability the native flag does not support.)
2. **PreToolUse hooks:** A deterministic hook blocks `Read` tool calls on `.specify/scenarios/**` at the tool boundary. This enforces scenario blindness in ALL sessions, including reviewers running on the feature branch (not in a worktree). The hook is configured in `.claude/hooks.json` and returns an explicit "holdout scenarios are off-limits" message into the agent's context. Additional hooks block:
   - Writes to `.specify/methodology/**` (AGENTS.md rule 3)
   - Reads/writes to `state/**`, `.factory/**`, `.runforge/**`
   - Writes to daemon source `src/**` (when running in the runforge repo itself)
3. **Prompt-level constraints:** All prompts (`worker.md`, `reviewer-spec-compliance.md`, `reviewer-code-quality.md`, `reviewer-security.md`) include explicit prohibitions: never read `.specify/scenarios/`, never modify files outside the worktree, never modify the daemon's own source code under `src/`.
4. **Post-session audit:** After each Claude session completes, the daemon scans session output logs for references to prohibited paths. Violations are logged and the issue is labeled `factory-stuck` with a containment breach note.
5. **Per-session budget cap:** `--max-budget-usd` on every session prevents runaway cost from a single stuck or looping agent, independent of the daemon's daily budget tracker.

### Cost Tracking

The daemon tracks token costs per session and enforces a daily budget:

1. **Session cost capture:** After each Claude CLI session completes, the daemon reads session metadata from `~/.claude/projects/` (session logs contain token counts and model info). Token counts are converted to USD using a pricing table in config (`claude.pricing`).
2. **Accumulation:** Each `RunState` tracks `totalTokenCostUsd`. The daemon sums across all active runs. The daily total is stored in `daemon.json` with a `dailyCostResetAt` timestamp.
3. **Enforcement:** Before spawning any new Claude session, the daemon checks `dailyCostUsd < safety.daily_budget_usd`. If exceeded, the daemon pauses and notifies via configured channels.
4. **Fallback estimation:** If session metadata is unavailable, the daemon estimates cost based on session duration and model (configurable rates per minute as a safety floor).

### Signal Handling & Graceful Shutdown

The daemon registers handlers for `SIGTERM`, `SIGINT`, and `SIGHUP`:

1. **Drain mode:** Stop accepting new issues from the queue.
2. **Wait for active sessions:** Allow running Claude processes to complete, up to a configurable grace period (`safety.shutdown_grace_seconds`, default: 300).
3. **Kill stragglers:** After grace period, send `SIGTERM` to remaining child processes.
4. **Clean up worktrees:** Remove all active worktrees via `WorktreeManager.listActive()` + `remove()`.
5. **Flush state:** Ensure all `run.json` files are consistent on disk.
6. **Remove lock file:** Delete `daemon.lock`.

**Orphan scanning:** The daemon's cron loop includes periodic orphan scanning — every 5 minutes, it checks tracked child PIDs and kills any that are not associated with an active run. This prevents leaked processes from accumulating after crashes or unexpected state transitions.

### Instance Locking & Control Plane

The daemon uses **port-based locking** (primary) with a PID file (fallback):

1. **Port lock:** On startup, bind an exclusive local HTTP port (default: `17532 + hash(repoPath) % 1000`). If the port is in use, another daemon instance owns it — fail fast. The OS automatically releases the port on crash (no stale locks).
2. **Control plane:** The bound port serves a minimal HTTP interface:
   - `GET /status` — current runs, phase, daily cost, uptime
   - `GET /health` — liveness probe for systemd/launchd
   - `POST /pause` / `POST /resume` — remote control
   - `GET /logs?issue=N` — stream logs for a specific run
3. **PID file (fallback):** Write PID to `~/.runforge/state/{repo-path-hash}/daemon.lock` as a convenience. Signal handlers clean up on shutdown. Stale PID detection via `process.kill(pid, 0)`.
4. **Scope:** Both lock mechanisms are scoped by a hash of the repository's absolute path.

### Secrets Management

The daemon uses credentials (GitHub token, Slack webhooks, API keys) that must be managed safely:

1. **Snapshot resolve:** On startup, resolve all secrets from environment variables and config into an in-memory snapshot. If any required secret fails to resolve, refuse to start.
2. **Atomic swap on reload:** When config is reloaded (SIGHUP), resolve all secrets first. If all succeed, swap the entire snapshot atomically. If any fail, keep the last-known-good snapshot and log a warning. No partial credential updates mid-run.
3. **Never pass secrets to Claude sessions:** Credentials are used by the daemon's deterministic code (gh CLI, deploy commands, webhooks) — never injected into Claude prompts.

### Self-Improving Prompt Templates

Prompt templates evolve over time based on empirical data:

1. **Gotcha accumulation:** The gotcha store captures per-repo learnings from every session (existing mechanism).
2. **Periodic prompt optimization:** On a configurable schedule (default: weekly, or after every 20 completed issues), the daemon spawns a one-shot "prompt optimizer" session. It reads: the current prompt template, accumulated gotchas, recent error patterns from `run.json` files, and review findings. It outputs a revised prompt template.
3. **Human gate:** Revised templates are written to `prompts/{name}.md.proposed` — NOT applied automatically. The daemon notifies the operator that proposed prompt improvements are available for review. The operator diffs and approves.
4. **Version history:** Previous prompt versions are kept in `prompts/history/{name}-{date}.md` for rollback.

This implements the autoresearch concept — the system's instructions improve based on objective outcomes — with a human approval gate for safety.

### Maintenance Mode (Optional)

When `maintenance.enabled: true`:

- Scheduled full codebase deep reviews (cron)
- Periodic test suite runs
- Weekly dependency audits
- Findings create `bug` issues → enter normal triage flow

### Multi-Project

Each project runs its own daemon instance with its own config. `runforge status --all` shows all running factories.

---

## Worker Thread Isolation

Claude CLI sessions are spawned in Node.js `worker_threads`, not directly from the main thread. This protects the daemon's cron loop, signal handlers, and state management from being blocked by slow or stuck sessions.

```
Main Thread                          Worker Thread (1 per session)
┌──────────────────┐                ┌──────────────────────┐
│ FSM / Cron Loop  │ ── spawn ──►   │ claude CLI process   │
│ Signal Handlers  │ ◄── events ──  │ stdout/stderr capture│
│ Cost Tracker     │ ── kill ──►    │ cost parsing         │
│ State Writes     │ ◄── cost ──    │ timeout enforcement  │
└──────────────────┘                └──────────────────────┘
```

A `WorkerPool` enforces `safety.max_total_claude_sessions` as the concurrency limit. The pool uses a configurable stagger delay (default: 3000ms) between worker starts within a batch to avoid API thundering herd. Workers communicate via structured `postMessage()` events: `session:started`, `session:output`, `session:cost`, `session:completed`, `session:error`.

Git operations (worktree create/merge/remove) remain on the main thread — they are fast and must be serialized.

---

## Rate Limit Handling

A `RateLimitHandler` tracks API rate limit state and enforces backoff:

1. **Detection:** When a worker thread reports a session error, check for rate limit signals — exit code + stderr containing "rate limit" or "429". Simple pattern matching only (not Aperant's fragile regex approach).
2. **Cooldown:** On detection, set a `cooldownUntil` timestamp. Duration is either parsed from `Retry-After` (if available) or defaults to exponential backoff (30s → 60s → 120s → 300s).
3. **Enforcement:** Before spawning any new session, check `cooldownUntil`. If active, the FSM transitions to `paused` state rather than burning a retry attempt.
4. **Recovery:** The FSM's `paused` state polls `cooldownUntil` and automatically resumes when the cooldown expires.

Rate limit events are logged and notified via configured channels.

---

## State Machine

The pipeline runner is a finite state machine (FSM). Each phase is a state with explicit transitions. No external library — a lightweight custom FSM (~100 lines) keeps it dependency-free.

```typescript
interface StateConfig {
  onEnter?: (ctx: RunContext) => Promise<void>;   // hook: logging, budget check, gotcha injection
  execute: (ctx: RunContext) => Promise<PhaseResult>;
  onExit?: (ctx: RunContext) => Promise<void>;    // hook: cost recording, state save, checkpoint
  transitions: {
    success: PhaseName | 'complete';
    failure: PhaseName | 'stuck';
    skip?: PhaseName;
  };
  retryable: boolean;
  maxRetries?: number;
}
```

Three pipeline variants are different FSM definitions with different transition maps:

- **feature:** detect → classify → decompose → implement → review → holdout → pr_to_dev → deploy_dev → test → close_report
- **feature-simple:** detect → classify → implement → review → holdout → pr_to_dev → deploy_dev → test → close_report
- **bug:** detect → implement → review → pr_to_dev → deploy_dev → test → close_report

The FSM's `onEnter`/`onExit` hooks are the integration points for cross-cutting concerns: cost tracking, gotcha injection, checkpoint saves, rate limit checks.

On daemon restart, the FSM is initialized at the `currentPhase` from `run.json`. Completed states are not re-executed.

---

## Agent Config Registry

A centralized registry maps session types to their configuration. Phase modules don't construct session args — they call `workerPool.spawn(sessionType, contextVars)` and the pool looks up the config.

```typescript
const AGENT_CONFIGS: Record<SessionType, AgentConfig> = {
  coordinator:         { model: 'opus',   mode: 'one-shot', timeout: 15, budget: 5,   skipPerms: false, jsonSchema: 'task-graph',           thinking: 'high'   },
  classifier:          { model: 'sonnet', mode: 'one-shot', timeout: 5,  budget: 0.5, skipPerms: false, jsonSchema: 'complexity-assessment', thinking: 'medium' },
  worker:              { model: 'opus',   mode: 'agentic',  timeout: 60, budget: 20,  skipPerms: true,  jsonSchema: null,                    thinking: 'high'   },
  'reviewer-spec':     { model: 'opus',   mode: 'agentic',  timeout: 30, budget: 10,  skipPerms: true,  jsonSchema: null,                    thinking: 'high'   },
  'reviewer-quality':  { model: 'opus',   mode: 'agentic',  timeout: 30, budget: 10,  skipPerms: true,  jsonSchema: null,                    thinking: 'high'   },
  'reviewer-security': { model: 'opus',   mode: 'agentic',  timeout: 20, budget: 5,   skipPerms: true,  jsonSchema: null,                    thinking: 'medium' },
  'conflict-resolver': { model: 'opus',   mode: 'agentic',  timeout: 15, budget: 5,   skipPerms: true,  jsonSchema: null,                    thinking: 'medium' },
  'bug-worker':        { model: 'opus',   mode: 'agentic',  timeout: 60, budget: 20,  skipPerms: true,  jsonSchema: null,                    thinking: 'high'   },
  tester:              { model: 'opus',   mode: 'agentic',  timeout: 30, budget: 10,  skipPerms: true,  jsonSchema: null,                    thinking: 'medium' },
  diagnostician:       { model: 'opus',   mode: 'one-shot', timeout: 15, budget: 5,   skipPerms: false, jsonSchema: 'bug-diagnosis',         thinking: 'high'   },
  reporter:            { model: 'sonnet', mode: 'one-shot', timeout: 10, budget: 2,   skipPerms: false, jsonSchema: 'report',                thinking: 'low'    },
  'prompt-optimizer':  { model: 'opus',   mode: 'one-shot', timeout: 15, budget: 5,   skipPerms: false, jsonSchema: null,                    thinking: 'high'   },
};
```

Each config also specifies: `promptTemplate`, `maxTurns`, `prohibitedPaths`. The `budget` field maps to `--max-budget-usd`. The `jsonSchema` field maps to `--output-format json --json-schema`. Config values in `factory.config.yaml` override these defaults.

The `promptTemplate` field defaults to `prompts/{sessionType}.md` by convention (e.g., session type `worker` uses `prompts/worker.md`). Override in `factory.config.yaml` if needed.

All sessions use `--print` mode (headless). Agentic sessions add `--max-turns` for bounded execution.

---

## Recovery Manager

### Sub-Phase Checkpointing

Beyond phase-level state in `run.json`, the recovery manager saves checkpoints within long-running phases:

- **Implement phase:** checkpoint after each unit completes, after each batch merge.
- **Review phase:** checkpoint after each review round.
- **Test phase:** checkpoint after each fix attempt.

On resume, the phase module receives its last checkpoint and skips completed work. Example: implement phase receives `"batch-2-unit-3-complete"` and starts from unit 4 in batch 2.

### Atomic State Writes

All state updates use write-to-temp-then-rename (`fs.writeFileSync` to `run.json.tmp`, then `fs.renameSync` to `run.json`). This prevents corruption if the daemon crashes mid-write.

### Circular Fix Detection

The recovery manager hashes errors (normalized: stripped of timestamps, absolute paths, line numbers) and tracks occurrence counts per phase. When the same logical error appears 3+ times, the FSM transitions to `stuck` immediately rather than burning remaining retry attempts.

Error hashes are persisted in `run.json` so detection survives daemon restarts.

---

## Complexity-Gated Pipeline

A `ComplexityAssessor` runs a lightweight one-shot Claude session (sonnet, ~$0.01) before decomposition to classify issues:

| Classification | Criteria | Pipeline | Review Rounds |
|---------------|----------|----------|---------------|
| `simple` | 1 unit, ≤3 files | feature-simple (skip decompose) | 2 |
| `standard` | 2-5 units | feature (default) | config default |
| `complex` | 6+ units or cross-cutting | feature | config default + 2 |

Bug issues skip classification entirely.

---

## Gotcha Injection

A `GotchaStore` persists per-repo learnings between sessions as a JSONL file (`~/.runforge/state/{project}/gotchas.jsonl`).

### Recording

Worker and reviewer prompts include instructions to emit a structured marker when they discover something future sessions should know:

```
GOTCHA: {"filePaths": ["app/models/*.rb"], "gotcha": "This ORM requires explicit .save()"}
```

After each session, the daemon parses these markers from the session log and appends to the gotcha store.

### Injection

Before each worker or reviewer session, the daemon matches the unit's `expectedCodePaths` against gotcha `filePaths` (glob matching) and appends matching gotchas to the prompt as a `## Known Gotchas` section.

### Pruning

Gotchas with `hitCount > 20` and older than 90 days are archived to prevent unbounded prompt growth.

### Promotion

Gotchas with `hitCount >= 5` and age < 90 days are candidates for promotion to permanent project knowledge. The daemon writes proposed additions to `CLAUDE.md.proposed` (same human-gate pattern as the prompt optimizer). Once approved and merged into CLAUDE.md, the gotcha is marked `promoted: true` and stops being injected — it is now in every session's context automatically.

---

## Prompt Templates

Twelve prompt templates in `prompts/`:

1. **coordinator.md** — reads specs + issue, outputs task-graph.json (validated via `--json-schema`) with batched parallel units
2. **classifier.md** — lightweight: reads issue summary + spec list, outputs `ComplexityAssessment` JSON
3. **worker.md** — TDD protocol: write failing test → verify failure → implement → verify pass → refactor → commit. All spec content is pre-loaded in the prompt. Includes containment prohibitions and gotcha emission (`GOTCHA: {...}`). Must exit with structured status: `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`.
4. **reviewer-spec-compliance.md** — fresh agent verifies every acceptance criterion in the spec is met. Independent file reading — never trusts implementer's report.
5. **reviewer-code-quality.md** — reviews for maintainability, patterns, YAGNI, test quality, architectural consistency.
6. **reviewer-security.md** — reviews for injection, auth gaps, data validation, race conditions. Only runs for `complex` classified issues.
7. **conflict-resolver.md** — receives merge conflict diff, resolves favoring spec intent. Operates on the feature branch.
8. **bug-worker.md** — receives bug report. Writes regression test first, then fixes code. Single-unit fix.
9. **tester.md** — runs smoke + UI tests against dev server, outputs structured failure reports
10. **diagnostician.md** — triages bugs into Type A/B/C with confidence scores (validated via `--json-schema`)
11. **reporter.md** — generates implementation report (validated via `--json-schema`)
12. **prompt-optimizer.md** — reads current prompt template + accumulated gotchas + error patterns, outputs proposed improvements

Templates use `{{variable}}` placeholders replaced at runtime. Worker and reviewer templates include a `{{known_gotchas}}` placeholder. Claude also inherits CLAUDE.md and AGENTS.md from the working directory.

### JSON Schemas

Stored in `schemas/` directory, used with `--json-schema` for validated structured output:
- `schemas/task-graph.json` — TaskGraph schema for coordinator
- `schemas/complexity-assessment.json` — ComplexityAssessment schema for classifier
- `schemas/bug-diagnosis.json` — BugDiagnosis schema for diagnostician
- `schemas/report.json` — Report schema for reporter

---

## Key Design Decisions

1. **GitHub Issues as the queue** — no custom UI, no database. Issues are the universal interface between spec authoring and factory execution.
2. **Git worktrees for isolation** — each worker gets its own worktree with sparse checkout excluding `.specify/scenarios/`. No merge conflicts during parallel work.
3. **Claude CLI, not SDK** — leverages Claude Code's built-in tools, CLAUDE.md loading, and permission system. The factory is a thin orchestrator around claude processes.
4. **Daemon is dumb, Claude is smart** — the TS daemon only manages processes, state, and notifications. All intelligence (decomposition, implementation, review) lives in Claude sessions.
5. **Holdout scenarios for trust** — implementing agents never see `.specify/scenarios/`. Enforced via sparse checkout in worktrees (technical) + prompt prohibitions (behavioral) + post-session audit (detective). A shell-based test runner executes them afterward. Spec gaps surface as scenario failures.
6. **Human gate at production only** — everything up to dev deployment is autonomous. Production release requires merging a PR from dev → main.
7. **Bugs improve specs, not just code** — every bug is diagnosed as spec gap or implementation error. Spec gaps feed back into the specification, making the system more precise over time.
8. **State machine over sequential loop** — the FSM makes phase transitions explicit, recovery predictable, and pipeline variants (feature/bug/simple) clean. Hooks (`onEnter`/`onExit`) provide natural integration points for cross-cutting concerns.
9. **Three-layer architecture** — infrastructure (threads, rates, cost) → orchestration (FSM, configs, recovery) → intelligence (complexity, gotchas). Each layer depends only downward. Clean separation of concerns.
10. **Worker threads for daemon stability** — Claude CLI sessions run in `worker_threads`, protecting the main thread's cron loop, signal handlers, and state management from blocking.
11. **Complexity gating saves money** — a $0.01 classification session prevents $5-50 of wasted coordinator/decomposition work on simple issues.
12. **Gotchas accumulate institutional knowledge** — per-repo learnings persist between sessions via a simple JSONL store, injected into prompts by path matching. The system gets smarter with every issue it processes.
13. **Circular fix detection prevents token burn** — error hashing detects when retries hit the same wall, escalating to human review rather than exhausting all attempts on identical failures.
14. **Resumable at sub-phase granularity** — checkpoints within long-running phases (per-unit, per-review-round, per-fix-attempt) mean crash recovery doesn't restart entire phases. Atomic writes prevent state corruption.
15. **Structured output eliminates parsing failures** — coordinator, classifier, diagnostician, and reporter use `--json-schema` for CLI-validated JSON output. No more "parse stdout and hope it's valid JSON."
16. **Defense-in-depth cost control** — daily budget tracker (daemon) + per-session `--max-budget-usd` (CLI). Two independent circuit breakers.
17. **Heterogeneous review gates** — deterministic gates (tests, typecheck) run first and cheapest. LLM gates (spec compliance, code quality, security) only run if deterministic gates pass. Different agents with different prompts catch different bug classes.
18. **Port-based locking with control plane** — the daemon lock IS a minimal HTTP interface. No stale PID files after crashes. Enables remote status, pause, and log streaming.
19. **Worker exit status protocol** — workers report `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, giving the FSM nuanced routing instead of binary success/failure.
20. **Self-improving prompts with human gate** — accumulated gotchas and error patterns periodically feed a prompt optimizer. Proposed improvements require human approval before activation.
21. **Context isolation for workers** — all spec content, unit context, and gotchas are pre-loaded into the worker prompt by the daemon. Workers never read spec files themselves. This prevents context window pollution, ensures workers only see the specs assigned to their unit, and supports containment (workers cannot read arbitrary files).

---

## Inspiration

- **OpenClaw** — 24/7 daemon model, skills system, self-improving agent, messaging-based interface
- **StrongDM Dark Factory** — spec-as-source, nondeterministic idempotence, holdout testing, Digital Twin Universe
- **Gas Town** — batched parallel agents, Git-backed state, Coordinator/Worker model
- **Example-Project (product)** — role-based team structure, meeting protocol, recipe workflows (simplified here to a fixed pipeline with intelligent decomposition)
- **Aperant** — worker thread isolation, complexity-gated pipeline, memory observer with 2ms budget constraint, between-step gotcha injection, circular fix detection, agent config registry, recovery manager with checkpoint/resume, multi-account profile scoring
- **Karpathy's autoresearch** — immutable harness + mutable target + scalar metric pattern, git-as-ratchet (only improvements survive), results ledger, output redirection to prevent context flooding, "if context doesn't fit one window, decompose further" heuristic
