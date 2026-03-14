# Auto-Claude — Autonomous Agent Orchestrator for Spec-Driven Development

**Date:** 2026-03-14
**Status:** Draft
**Author:** the Operator + Claude (brainstorm session)

---

## Problem

You have a complete SDD specification system (L1/L2/L3 layers, traceability, holdout scenarios). You write precise specs. But implementation still requires you to sit at a terminal, run Claude Code, review output, and shepherd each feature through to production.

The goal: write specs, walk away, get notified when the work is done and live on a dev server — then approve production releases at your leisure.

## Solution

A TypeScript daemon ("Auto-Claude") that polls GitHub Issues for implementation requests, spawns Claude Code CLI sessions to implement them autonomously, and manages the full pipeline from spec decomposition through dev deployment, testing, and release preparation.

Two decoupled workflows connected by GitHub Issues:

- **Workflow A (Spec Author):** Interactive Claude Code sessions where you brainstorm and write specs. Outputs GitHub Issues labeled `factory-ready`.
- **Workflow B (Spec Factory):** Autonomous daemon that picks up issues and runs the implementation pipeline. Commits to `dev` branch. Creates release PRs to `main` for your approval.

---

## Architecture

### Approach: TypeScript Daemon + Claude-as-Coordinator (B+C Hybrid)

TypeScript handles the deterministic machinery — GitHub polling, process lifecycle, state tracking, notifications, restart loops. Claude handles the intelligent decisions — spec decomposition, dependency analysis, implementation, review, report generation.

The daemon is the machine. Claude is the brain.

### Components

```
auto-claude/
├── src/
│   ├── index.ts                 # entry: cron loop
│   ├── config.ts                # load factory.config.yaml
│   ├── queue/
│   │   ├── poller.ts            # gh issue list --label factory-ready
│   │   ├── claimer.ts           # label swap: factory-ready → factory-in-progress
│   │   └── parser.ts            # parse issue body → IssuePayload
│   ├── pipeline/
│   │   ├── runner.ts            # orchestrate phases sequentially
│   │   ├── decompose.ts         # coordinator claude → task-graph.json
│   │   ├── implement.ts         # parallel workers in worktrees
│   │   ├── review.ts            # N rounds of /deep-review
│   │   ├── deploy-dev.ts        # trigger dev deploy + health check
│   │   ├── test.ts              # smoke + playwright tests
│   │   ├── pr.ts                # PR to dev + merge
│   │   ├── release.ts           # PR dev→main + GitHub Release
│   │   └── report.ts            # generate + deliver report
│   ├── claude/
│   │   ├── session.ts           # spawn claude CLI, capture output
│   │   ├── worktree.ts          # git worktree lifecycle
│   │   └── prompts.ts           # load + template prompt files
│   ├── notify/
│   │   ├── index.ts             # dispatch to configured channels
│   │   ├── markdown.ts          # write report file
│   │   ├── slack.ts             # slack webhook
│   │   └── email.ts             # SMTP/API
│   └── state/
│       ├── store.ts             # read/write run state
│       └── types.ts             # RunState, Phase, UnitStatus
├── prompts/
│   ├── coordinator.md
│   ├── worker.md
│   ├── reviewer.md
│   ├── tester.md
│   ├── diagnostician.md
│   └── reporter.md
└── state/                       # runtime (gitignored)
    └── runs/issue-{N}/
```

---

## Pipeline Phases

### Phase 1: Detect

Daemon cron polls GitHub Issues: `gh issue list --label "factory-ready"`. When found, swaps label to `factory-in-progress` and parses the issue body. Only one daemon instance per repo is supported — the daemon writes a lock file (`~/.auto-claude/state/{project}/daemon.lock`) with its PID on startup and refuses to start if a live process holds the lock.

### Phase 2: Decompose

Coordinator Claude session (one-shot, `claude --print`) reads the issue body, referenced spec files (in understanding order: L1 → L2 → L3), and `traceability.yml`. Outputs `task-graph.json`:

```json
{
  "issue_number": 42,
  "feature_branch": "factory/issue-42-user-auth",
  "units": [
    {
      "id": "unit-1",
      "title": "User model and migration",
      "specs": ["RAIL-USER-MODEL"],
      "spec_files": [".specify/rails/user-model.md"],
      "expected_code_paths": ["app/models/user.rb"],
      "depends_on": [],
      "batch": 1,
      "context": "..."
    }
  ]
}
```

Units are grouped into batches. Units within a batch have no file-level overlap and run in parallel. Batches run sequentially.

### Phase 3: Implement

Per unit, in an isolated git worktree:

1. Read specs (L3 → L2 → L1)
2. Write implementation plan
3. Execute plan
4. Run `/deep-review`
5. Fix findings
6. Repeat 4-5 (max N cycles, configurable)
7. Run unit tests
8. Commit

Worktrees merge into the feature branch after each batch completes using `git merge --no-ff` for traceability. If merge conflicts occur (coordinator mispredicted file overlap), the daemon spawns a conflict-resolution Claude session. After merge, a post-merge verification step runs (compile/typecheck) before proceeding to the next batch.

### Phase 4: Review

On the merged feature branch, run `/deep-review` N times (default: 7, configurable). Each round is a fresh Claude session. Early rounds focus on correctness, later rounds on edge cases and polish. Fix issues between rounds.

### Phase 4b: Holdout Validation

After review rounds complete, holdout scenarios from `.specify/scenarios/` are executed. **This is NOT a Claude session.** Per AGENTS.md rule 4, no Claude agent may read scenarios — builder isolation is what makes them trustworthy. Instead, the daemon runs scenarios via a shell-based test runner (e.g., `bin/run-scenarios`) that executes the scenario files directly against the implementation without exposing their content to any LLM. The daemon checks exit codes and captures structured output. Scenario failures indicate spec gaps, not code bugs — the daemon labels the issue `needs-spec-update` and reports which scenarios failed (without revealing scenario content to any agent).

### Phase 5: PR to Dev

Create PR from feature branch to `dev`. Final `/deep-review` on the PR diff. Auto-merge.

### Phase 6: Deploy to Dev

Dev server deploys from `dev` branch (CI trigger or daemon runs deploy command). Health check polling until healthy.

### Phase 7: Smoke + UI Tests

Against the running dev server:

- API smoke tests (configured command)
- Playwright UI tests (if `has_ui: true` in issue)
- If tests fail → structured failure report → daemon creates a fix branch off `dev` (named `factory/issue-{N}-fix-{attempt}`, e.g. `factory/issue-42-fix-1`), spawns a worker Claude session with the failure context, fixes are merged back to `dev` via PR, and the deploy/test cycle repeats. The original feature branch is not reused after merging to dev. Fix attempts are tracked in `run.json` under a `fixes` array. Max fix attempts is bounded by `max_retries_per_phase` — after exhaustion the issue is labeled `factory-stuck`.

### Phase 8: Close Issue + Report

Update GitHub Issue with implementation report. Label `factory-complete`. Close the issue. Notify via configured channels.

### Phase 9: Release (Periodic or On-Demand)

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

Spec says X, code does Y. Factory fixes autonomously — writes regression test first, then fixes code. Follows the standard pipeline but scoped to the fix.

### Type B: Spec Gap

Spec doesn't cover the reported case. Daemon labels `needs-spec-update`, posts diagnosis with suggested spec changes. You or an interactive Claude session updates the spec, then relabels `factory-ready`.

### Type C: Expectation Mismatch

Spec and code agree, but the user expected different behavior. Labels `needs-human`. Requires your input to rethink the L1 requirement.

The diagnostician outputs structured JSON with confidence scores. Below 0.7 confidence routes to human rather than guessing.

---

## Claude CLI Session Types

### Coordinator (one-shot)

```bash
# Daemon assembles context into a single prompt string
# Note: all context is concatenated into the -p flag to avoid
# ambiguity with stdin + -p interaction across CLI versions
claude --print --model opus \
  -p "$(cat prompts/coordinator.md)

## Issue
$(cat state/runs/issue-42/issue_body.md)

## Specs
$(cat .specify/functional/user-auth.md .specify/architecture/auth-flow.md .specify/rails/auth.md)

## Traceability
$(cat .specify/traceability.yml)"
```

Output is captured to `state/runs/issue-{N}/task-graph.json`. The daemon validates the JSON schema before proceeding.

### Worker (agentic, in worktree)

```bash
cd .factory/worktrees/unit-1

# Unit context and spec content are injected via the prompt
claude --model opus \
  --dangerously-skip-permissions \
  -p "$(cat prompts/worker.md)

## Your Unit
$(cat state/runs/issue-42/units/unit-1.json)

## Specs
$(cat .specify/rails/user-model.md .specify/architecture/user-model.md)" \
  --max-turns 200
```

### Reviewer (agentic, per round)

```bash
claude --model opus \
  --dangerously-skip-permissions \
  -p "Run /deep-review on all changes since dev branch. \
Round N of M. Fix any issues found." \
  --max-turns 50
```

### Reporter (one-shot, cheaper model)

```bash
claude --print --model sonnet \
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
```

---

## Daemon Lifecycle

### CLI

```
auto-claude init           # scaffold factory.config.yaml
auto-claude start          # foreground
auto-claude start --daemon # background (launchd on macOS, systemd on Linux)
auto-claude stop
auto-claude status         # active runs, costs, next poll
auto-claude logs [--run N]
auto-claude pause          # stop picking up new issues
auto-claude resume
auto-claude retry N        # retry a stuck issue
auto-claude release        # trigger dev→main PR now
```

### Process Management

- macOS: generates `~/Library/LaunchAgents/com.auto-claude.{project}.plist` with `KeepAlive: true`
- Linux: generates `~/.config/systemd/user/auto-claude-{project}.service` with `Restart=always`
- Auto-restarts on crash. Resumes from `run.json` state.

### State & Logging

```
~/.auto-claude/
├── logs/{project}.log       # structured JSON, one object per line
├── state/{project}/
│   ├── daemon.json          # PID, uptime, config path
│   └── runs/issue-{N}/
│       ├── run.json          # phase state, timing, costs
│       ├── task-graph.json
│       ├── workers/unit-{N}.log
│       ├── reviews/round-{N}.log
│       └── report.md
└── config/{project}.yaml → symlink
```

### Safety

- Daily token budget with auto-pause
- Max concurrent runs and sessions
- Worker/review timeouts (kills stuck processes)
- Auto-pause after N consecutive stuck issues
- All safety events notify via configured channels

### Maintenance Mode (Optional)

When `maintenance.enabled: true`:

- Scheduled full codebase deep reviews (cron)
- Periodic test suite runs
- Weekly dependency audits
- Findings create `bug` issues → enter normal triage flow

### Multi-Project

Each project runs its own daemon instance with its own config. `auto-claude status --all` shows all running factories.

---

## Prompt Templates

Six prompt templates in `prompts/`:

1. **coordinator.md** — reads specs + issue, outputs task-graph.json with batched parallel units
2. **worker.md** — strict protocol: read specs → plan → implement → /deep-review loop → test → commit
3. **reviewer.md** — runs /deep-review on merged branch, rounds focus on correctness → edge cases → polish
4. **tester.md** — runs smoke + UI tests against dev server, outputs structured failure reports
5. **diagnostician.md** — triages bugs into Type A/B/C with confidence scores
6. **reporter.md** — generates implementation report from diffs, tests, reviews, traceability

Templates use `{{variable}}` placeholders replaced at runtime. Claude also inherits CLAUDE.md and AGENTS.md from the project's working directory.

---

## Key Design Decisions

1. **GitHub Issues as the queue** — no custom UI, no database. Issues are the universal interface between spec authoring and factory execution.
2. **Git worktrees for isolation** — each worker gets its own worktree. No merge conflicts during parallel work.
3. **Claude CLI, not SDK** — leverages Claude Code's built-in tools, CLAUDE.md loading, and permission system. The factory is a thin orchestrator around claude processes.
4. **Daemon is dumb, Claude is smart** — the TS daemon only manages processes, state, and notifications. All intelligence (decomposition, implementation, review) lives in Claude sessions.
5. **Holdout scenarios for trust** — implementing agents never see `.specify/scenarios/`. A shell-based test runner executes them afterward. Spec gaps surface as scenario failures.
6. **Human gate at production only** — everything up to dev deployment is autonomous. Production release requires merging a PR from dev → main.
7. **Bugs improve specs, not just code** — every bug is diagnosed as spec gap or implementation error. Spec gaps feed back into the specification, making the system more precise over time.
8. **Resumable on crash** — `run.json` tracks phase state. Daemon crash → restart → resume from current phase (nondeterministic idempotence).

---

## Inspiration

- **OpenClaw** — 24/7 daemon model, skills system, self-improving agent, messaging-based interface
- **StrongDM Dark Factory** — spec-as-source, nondeterministic idempotence, holdout testing, Digital Twin Universe
- **Gas Town** — batched parallel agents, Git-backed state, Coordinator/Worker model
- **Example-Project (product)** — role-based team structure, meeting protocol, recipe workflows (simplified here to a fixed pipeline with intelligent decomposition)
