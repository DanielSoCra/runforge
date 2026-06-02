> **🗄 HISTORICAL (2026-06-02).** Completed/superseded record, kept for provenance — superseded by the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. The canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Auto-Claude Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript daemon that polls GitHub Issues for spec implementation requests, spawns Claude Code CLI sessions to implement them autonomously, and manages the full pipeline from decomposition through dev deployment and release preparation.

**Architecture:** Three-layer design: Infrastructure (worker threads, rate limits, cost tracking) → Orchestration (FSM pipeline runner, agent config registry, recovery manager) → Intelligence (complexity gating, gotcha injection). GitHub Issues serve as the work queue. Git worktrees isolate parallel workers. State is JSON files on disk. A finite state machine drives phase transitions with sub-phase checkpointing.

**Tech Stack:** TypeScript (tsx runtime, no build step), Commander.js (CLI), js-yaml (config), Node built-in worker_threads (session isolation), Node built-in child_process (spawning claude within workers), Node built-in fs (state). No framework, no database.

**Design Doc:** `docs/specs/2026-03-14-auto-claude-design.md`

**Conventions:**
- `$PROJECT_ROOT` refers to the repository root directory. All commands run from there.
- Auto-Claude's own source code is not spec-governed (no entries in `traceability.yml`). Specs may be added later.
- Runtime state lives at `~/.auto-claude/state/{project}/`. The `state/` dir in-repo is a symlink (created by `auto-claude init`).

---

## Plan Additions

These additions close gaps identified in `research/` without rewriting the rest of the implementation plan. Treat them as scope and sequencing constraints on the tasks below.

### Addition 1: Explicit MVP before parallel factory

- [ ] Add an **MVP milestone** section before Chunk 1 with this scope only:
  - One daemon instance
  - One active issue at a time
  - One worker unit at a time
  - Deterministic holdout runner
  - Fast-fail guards for compile crashes, test runner crashes, and silent/stalled workers
  - Dev deploy + health check
  - Final report + notification
- [ ] Mark these as **post-MVP hardening**, not day-one requirements:
  - Parallel unit batches
  - Prompt optimizer automation
  - Maintenance mode
  - Multi-project status aggregation
- [ ] Update the chunk ordering note so MVP stability is proven before parallel worker execution is enabled.

### Addition 2: Worktree hygiene and bootstrap

- [ ] Extend the worktree plan with deterministic setup steps:
  - Verify `.factory/worktrees/` is gitignored before creation
  - Bootstrap repo dependencies inside the worktree
  - Run a clean baseline verification command before assigning work
  - Record any allocated ports or per-worktree env overrides
  - Define cleanup policy for dirty or abandoned worktrees after crashes
- [ ] Add tests covering worktree bootstrap failure and cleanup on shutdown.

### Addition 3: Full run ledger and audit trail

- [ ] Expand `RunState` / persisted state to include:
  - `runId`
  - `repoShaAtStart`
  - `claimedAt`
  - `completedAt`
  - command history with exit codes
  - artifact paths
  - diff summary per phase
- [ ] Add an append-only event log per run under `state/runs/issue-{N}/` so failures are reconstructable even when a phase crashes mid-stream.
- [ ] Store each run's artifacts in a timestamped directory containing task graph, worker logs, review outputs, holdout results, and final report for post-mortem debugging.

### Addition 4: Background process abstraction

- [ ] Add a reusable background process manager for deploy and test phases with:
  - spawn
  - process ID / session ID
  - log capture path
  - polling
  - timeout
  - termination
  - restart recovery
- [ ] Refactor deploy-to-dev and long-running test commands to use this abstraction instead of ad hoc `exec` calls.
- [ ] Add **heartbeat/admission checks** for daemon polling and dev health monitoring so deterministic checks run first and Claude sessions are only spawned when there is actual failure or work to process.

### Addition 5: Sandbox and permissions policy

- [ ] Add a dedicated safety task defining when `--dangerously-skip-permissions` is allowed.
- [ ] Default unattended runs to a constrained environment:
  - sandboxed Claude settings where possible
  - otherwise container or VM isolation
  - explicit filesystem and network boundaries
- [ ] Treat permission bypass as an exception path with a documented rationale, not the default config for all agentic sessions.
- [ ] Make holdout evaluation **structurally immutable** to agent sessions:
  - agents may not read scenario files
  - agents may not write scenario files
  - agents may not modify the holdout runner or success-criteria definitions
  - enforcement must be technical (permissions / file layout), not prompt-only

### Addition 6: AgentSkills-compatible prompt pack

- [ ] Add a task to make `prompts/` and related assets reusable as an AgentSkills-compatible pack for both interactive authoring and daemon execution.
- [ ] Move prompt templates toward `SKILL.md` semantics with YAML frontmatter where:
  - `description` contains triggering conditions only
  - workflow/process instructions live in the body
- [ ] Define precedence and activation rules for bundled prompts, workspace overrides, and user-level overrides.
- [ ] Add a lightweight governance step for hooks / skills / prompt assets:
  - allowed source locations
  - hash or checksum recording
  - human review before activation of new executable assets
- [ ] Add hot-reload support for prompt / skill changes so updates can take effect without daemon restart.

### Addition 7: Claude CLI compatibility cleanup

- [ ] Update the session command plan to avoid specifying both `--print` and `-p` together.
- [ ] Re-evaluate whether native Claude worktree support should replace some custom `.factory/worktrees` lifecycle code.
- [ ] Add a compatibility note documenting the exact CLI behaviors the daemon depends on so upgrades can be tested intentionally.

### Addition 8: Context budget and memory flush

- [ ] Add hard session budget rules beyond cost:
  - maximum turns
  - maximum inactivity window
  - maximum wall-clock runtime per session type
- [ ] Before long-running sessions hit context limits, flush structured progress summaries to disk so recovery and reviewer sessions do not depend on bloated prior logs.

### Addition 9: Post-MVP scale recommendations from research

- [ ] Evaluate whether the custom FSM should remain lightweight or be replaced with XState once the MVP flow is stable and the state surface is real.
- [ ] Treat multi-account / multi-profile rate-limit failover as a **post-MVP scaling task**, not a prerequisite for first implementation.

---

## Chunk 1: Project Foundation

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore` (update existing)

- [ ] **Step 1: Initialize package.json**

```bash
cd $PROJECT_ROOT
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install commander js-yaml tsx minimatch
# Note: worker_threads, http, crypto are Node built-ins — no extra deps needed
npm install -D typescript @types/node @types/js-yaml vitest
```

Note: `tsx` is a production dependency because the CLI entry point requires it at runtime.

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "state"]
}
```

- [ ] **Step 4: Update .gitignore**

Add `node_modules/`, `dist/`, `state/`, `.auto-claude/`, `.factory/` to existing `.gitignore`.

- [ ] **Step 5: Add scripts to package.json**

```json
{
  "bin": { "auto-claude": "./bin/auto-claude.mjs" },
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 6: Create bin entry point**

Create `bin/auto-claude.mjs`:
```javascript
#!/usr/bin/env tsx
import '../src/index.ts';
```

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore bin/
git commit -m "feat: project scaffolding with tsx, commander, vitest"
```

---

### Task 2: Type definitions

**Files:**
- Create: `src/types.ts` (centralized — not in `state/`)

- [ ] **Step 1: Write types**

All core types for the system. These are the data structures that flow through all three layers:

```typescript
// Issue payload parsed from GitHub Issue body
export interface IssuePayload {
  issueNumber: number;
  title: string;
  summary: string;
  specs: Array<{ id: string; layer: string; path: string }>;
  scope: string[];
  acceptanceCriteria: string[];
  config: {
    hasUi: boolean;
    deepReviewRounds?: number;
    priority: "high" | "medium" | "low";
  };
  labels: string[];
  issueBody: string;
}

// Task graph output by coordinator
export interface TaskGraph {
  issueNumber: number;
  featureBranch: string;
  units: Unit[];
}

export interface Unit {
  id: string;
  title: string;
  specs: string[];
  specFiles: string[];
  expectedCodePaths: string[];
  dependsOn: string[];
  batch: number;
  context: string;
  verificationCommand: string;
}

// Run state persisted to disk
export type PhaseStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface PhaseState {
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  attempt: number;
  error?: string;
}

export interface UnitState {
  status: PhaseStatus;
  worktree?: string;
  attempt: number;
  error?: string;
}

export interface FixAttempt {
  branch: string;
  attempt: number;
  status: PhaseStatus;
  failureContext?: string;
}

export interface RunState {
  issueNumber: number;
  startedAt: string;
  currentPhase: PhaseName;
  phases: Record<PhaseName, PhaseState>;
  implement?: {
    units: Record<string, UnitState>;
    currentBatch: number;
  };
  fixes: FixAttempt[];
  featureBranch?: string;
  prNumber?: number;
  totalTokenCostUsd: number;
}

export type PhaseName =
  | "detect"
  | "classify"
  | "decompose"
  | "implement"
  | "review"
  | "holdout"
  | "pr_to_dev"
  | "deploy_dev"
  | "test"
  | "close_report";

// Pipeline variants
export type PipelineVariant = "feature" | "feature-simple" | "bug";

// Complexity classification
export type Complexity = "simple" | "standard" | "complex";
export interface ComplexityAssessment {
  complexity: Complexity;
  reasoning: string;
  estimatedUnits: number;
  estimatedFiles: number;
}

// FSM types
export interface StateConfig {
  onEnter?: (ctx: RunContext) => Promise<void>;
  execute: (ctx: RunContext) => Promise<PhaseResult>;
  onExit?: (ctx: RunContext) => Promise<void>;
  transitions: {
    success: PhaseName | "complete";
    failure: PhaseName | "stuck";
    skip?: PhaseName;
  };
  retryable: boolean;
  maxRetries?: number;
}

export type PhaseResult = { status: "success" } | { status: "failure"; error: string } | { status: "skip" };

export interface RunContext {
  issue: IssuePayload;
  config: Config;
  run: RunState;
  pipelineVariant: PipelineVariant;
  complexity?: ComplexityAssessment;
}

// Agent config registry
export type SessionType =
  | "coordinator" | "classifier" | "worker"
  | "reviewer-spec" | "reviewer-quality" | "reviewer-security"
  | "conflict-resolver" | "bug-worker" | "tester"
  | "diagnostician" | "reporter" | "prompt-optimizer";

export interface AgentConfig {
  model: string;
  mode: "one-shot" | "agentic";
  promptTemplate: string;
  maxTurns?: number;
  timeoutMinutes: number;
  maxBudgetUsd: number;         // maps to --max-budget-usd
  skipPermissions: boolean;
  prohibitedPaths?: string[];
  thinkingLevel: "low" | "medium" | "high";
  jsonSchema?: string;          // schema name for --output-format json --json-schema
}

// Worker exit status protocol
export type WorkerExitStatus = "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";

// Sub-phase checkpointing
export interface PhaseCheckpoint {
  phase: PhaseName;
  checkpoint: string;           // e.g., "batch-2-unit-3-complete"
  data: Record<string, unknown>;
  savedAt: string;
}

// Worker thread events
export type WorkerEvent =
  | { type: "session:started"; sessionType: SessionType }
  | { type: "session:output"; line: string }
  | { type: "session:cost"; inputTokens: number; outputTokens: number; model: string }
  | { type: "session:completed"; exitCode: number }
  | { type: "session:error"; error: string; isRateLimit: boolean };

// Gotcha store
export interface Gotcha {
  id: string;
  filePaths: string[];
  gotcha: string;
  source: "agent" | "human";
  issueNumber: number;
  createdAt: string;
  hitCount: number;
}

// Notification event
export interface NotifyEvent {
  type: "started" | "phase_complete" | "stuck" | "complete" | "budget_exceeded" | "rate_limited" | "release_ready";
  issueNumber: number;
  message: string;
  details?: Record<string, unknown>;
}

// Daemon state
export interface DaemonState {
  pid: number;
  startedAt: string;
  configPath: string;
  project: string;
  paused: boolean;
  dailyCostUsd: number;
  dailyCostResetAt: string;
}
```

// Note: Config interface is defined in src/config.ts (Task 3), not here. It is imported where needed.

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: core type definitions"
```

---

### Task 3: Configuration loading

**Files:**
- Create: `src/config.ts`
- Create: `src/__tests__/config.test.ts`
- Create: `factory.config.example.yaml`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig, validateConfig } from "../config.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("config", () => {
  it("loads and validates a valid config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-test-"));
    const configPath = join(dir, "factory.config.yaml");
    writeFileSync(configPath, `
project:
  name: "test-app"
  repo: "user/test-app"
  spec_dir: ".specify"
  main_branch: "main"
  dev_branch: "dev"
cron:
  interval_minutes: 5
claude:
  model: "opus"
  max_parallel_workers: 2
  skip_permissions: true
  pricing:
    opus_input: 15.0
    opus_output: 75.0
    sonnet_input: 3.0
    sonnet_output: 15.0
pipeline:
  deep_review_rounds: 3
  max_retries_per_phase: 2
  worker:
    max_review_fix_cycles: 3
    skills: ["/deep-review"]
safety:
  daily_budget_usd: 50
  max_concurrent_runs: 1
  max_total_claude_sessions: 4
  worker_timeout_minutes: 30
  review_timeout_minutes: 15
  max_retries_per_issue: 3
  cooldown_between_pickups_seconds: 10
  auto_pause_after_consecutive_stuck: 2
`);
    const config = loadConfig(configPath);
    expect(config.project.name).toBe("test-app");
    expect(config.claude.model).toBe("opus");
    expect(config.safety.daily_budget_usd).toBe(50);
    rmSync(dir, { recursive: true });
  });

  it("throws on missing required fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-test-"));
    const configPath = join(dir, "factory.config.yaml");
    writeFileSync(configPath, `
project:
  name: "test-app"
`);
    expect(() => loadConfig(configPath)).toThrow();
    rmSync(dir, { recursive: true });
  });

  it("resolves env vars in string values", () => {
    process.env.TEST_WEBHOOK = "https://hooks.slack.com/test";
    const dir = mkdtempSync(join(tmpdir(), "ac-test-"));
    const configPath = join(dir, "factory.config.yaml");
    writeFileSync(configPath, `
project:
  name: "test-app"
  repo: "user/test-app"
  spec_dir: ".specify"
  main_branch: "main"
  dev_branch: "dev"
cron:
  interval_minutes: 5
claude:
  model: "opus"
  max_parallel_workers: 2
  skip_permissions: true
pipeline:
  deep_review_rounds: 3
  max_retries_per_phase: 2
  worker:
    max_review_fix_cycles: 3
    skills: ["/deep-review"]
notify:
  channels:
    - type: "slack"
      webhook_url: "\${TEST_WEBHOOK}"
safety:
  daily_budget_usd: 50
  max_concurrent_runs: 1
  max_total_claude_sessions: 4
  worker_timeout_minutes: 30
  review_timeout_minutes: 15
  max_retries_per_issue: 3
  cooldown_between_pickups_seconds: 10
  auto_pause_after_consecutive_stuck: 2
`);
    const config = loadConfig(configPath);
    expect(config.notify?.channels?.[0]?.webhook_url).toBe("https://hooks.slack.com/test");
    delete process.env.TEST_WEBHOOK;
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd $PROJECT_ROOT && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write config.ts**

Implement `loadConfig` and `validateConfig`: read YAML file, resolve `${ENV_VAR}` patterns, validate all required fields with explicit checks:

Required sections and fields:
- `project`: `name`, `repo`, `spec_dir`, `main_branch`, `dev_branch`
- `cron`: `interval_minutes`
- `claude`: `model`, `max_parallel_workers`, `skip_permissions`, `pricing` (with `opus_input`, `opus_output`, `sonnet_input`, `sonnet_output`)
- `pipeline`: `deep_review_rounds`, `max_retries_per_phase`, `worker.max_review_fix_cycles`
- `safety`: `daily_budget_usd`, `max_concurrent_runs`, `max_total_claude_sessions`, `worker_timeout_minutes`, `review_timeout_minutes`, `max_retries_per_issue`, `cooldown_between_pickups_seconds`, `auto_pause_after_consecutive_stuck`, `shutdown_grace_seconds`

Optional sections (with defaults):
- `dev`: `deploy_command`, `health_check_url`, `health_check_timeout_seconds` (default: 120)
- `testing`: `unit_test_command`, `api_test_command`, `playwright` (default: disabled)
- `notify`: `channels` (default: empty)
- `release`: `trigger` (default: "on-demand"), `version_strategy` (default: "semver-auto")

Return typed `Config` interface. Export it.

- [ ] **Step 4: Create factory.config.example.yaml**

Full example config with comments, matching the design doc's Configuration section.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd $PROJECT_ROOT && npx vitest run src/__tests__/config.test.ts`
Expected: 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts factory.config.example.yaml
git commit -m "feat: config loading with YAML parsing and env var resolution"
```

---

### Task 4: State store

**Files:**
- Create: `src/state/store.ts`
- Create: `src/__tests__/state.test.ts`

- [ ] **Step 1: Write the failing test**

Test `createRun`, `loadRun`, `updatePhase`, `updateUnit` functions. Each reads/writes JSON files under a temp directory.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "../state/store.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("StateStore", () => {
  let store: StateStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-state-"));
    store = new StateStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true }));

  it("creates and loads a run", () => {
    store.createRun(42);
    const run = store.loadRun(42);
    expect(run.issueNumber).toBe(42);
    expect(run.currentPhase).toBe("detect");
    expect(run.phases.detect.status).toBe("pending");
  });

  it("updates phase status", () => {
    store.createRun(42);
    store.updatePhase(42, "detect", { status: "completed" });
    const run = store.loadRun(42);
    expect(run.phases.detect.status).toBe("completed");
  });

  it("resumes from existing run state", () => {
    store.createRun(42);
    store.updatePhase(42, "detect", { status: "completed" });
    store.updatePhase(42, "decompose", { status: "in_progress" });
    const run = store.loadRun(42);
    expect(run.phases.detect.status).toBe("completed");
    expect(run.phases.decompose.status).toBe("in_progress");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd $PROJECT_ROOT && npx vitest run src/__tests__/state.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement StateStore**

Class with methods: `createRun(issueNumber)`, `loadRun(issueNumber)`, `loadOrCreateRun(issueNumber)` (idempotent — loads if exists, creates if not), `updatePhase(issueNumber, phase, update)`, `updateUnit(issueNumber, unitId, update)`, `addFix(issueNumber, fix)`, `saveTaskGraph(issueNumber, graph)`, `loadTaskGraph(issueNumber)`. All read/write JSON files under `{stateDir}/runs/issue-{N}/`.

- [ ] **Step 4: Run tests**

Run: `cd $PROJECT_ROOT && npx vitest run src/__tests__/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/store.ts src/__tests__/state.test.ts
git commit -m "feat: state store with JSON file persistence"
```

---

### Task 5: Structured logger

**Files:**
- Create: `src/infra/logger.ts`

- [ ] **Step 1: Write logger**

Simple structured JSON logger that writes to stdout and optionally to a file. One JSON object per line. Fields: `ts`, `level`, `phase`, `issue`, `unit`, `msg`, `pid`. No external dependencies — use `console.log` with `JSON.stringify`. Import `appendFileSync` from `"fs"` at the top of the file (ESM import, not `require`).

```typescript
export interface LogContext {
  phase?: string;
  issue?: number;
  unit?: string;
  [key: string]: unknown;
}

export function createLogger(logFile?: string) {
  const write = (level: string, msg: string, ctx: LogContext = {}) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      pid: process.pid,
      ...ctx,
    };
    const line = JSON.stringify(entry);
    console.log(line);
    if (logFile) {
      appendFileSync(logFile, line + "\n");
    }
  };

  return {
    info: (msg: string, ctx?: LogContext) => write("info", msg, ctx),
    warn: (msg: string, ctx?: LogContext) => write("warn", msg, ctx),
    error: (msg: string, ctx?: LogContext) => write("error", msg, ctx),
  };
}

export type Logger = ReturnType<typeof createLogger>;
```

- [ ] **Step 2: Commit**

```bash
git add src/infra/logger.ts
git commit -m "feat: structured JSON logger"
```

### Task 5b: Cost tracker

**Files:**
- Create: `src/infra/cost.ts`
- Create: `src/__tests__/cost.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { CostTracker, estimateCostFromTokens } from "../infra/cost.js";

describe("CostTracker", () => {
  it("estimates cost from token counts", () => {
    const cost = estimateCostFromTokens({
      model: "opus",
      inputTokens: 10000,
      outputTokens: 5000,
      pricing: { opus_input: 15.0, opus_output: 75.0, sonnet_input: 3.0, sonnet_output: 15.0 },
    });
    // 10000/1M * 15 + 5000/1M * 75 = 0.15 + 0.375 = 0.525
    expect(cost).toBeCloseTo(0.525);
  });

  it("tracks daily cost with reset", () => {
    const tracker = new CostTracker(100); // $100 daily budget
    tracker.addCost(50);
    expect(tracker.withinBudget()).toBe(true);
    tracker.addCost(60);
    expect(tracker.withinBudget()).toBe(false);
    tracker.resetDaily();
    expect(tracker.withinBudget()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement cost.ts**

`CostTracker` class:
- `addCost(usd)` — accumulates daily cost.
- `withinBudget()` — returns `dailyCostUsd < budgetUsd`.
- `resetDaily()` — resets accumulator (called when `dailyCostResetAt` crosses midnight).
- `getDailyCost()` — returns current daily total.

`estimateCostFromTokens(opts)` — pure function: converts token counts + pricing config to USD.

`parseSessionCost(sessionLogDir)` — reads Claude session metadata from `~/.claude/projects/` to extract token counts. Falls back to duration-based estimation if metadata is unavailable.

- [ ] **Step 4: Run tests, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/infra/cost.ts src/__tests__/cost.test.ts
git commit -m "feat: cost tracker with token-based estimation and daily budget"
```

---

## Chunk 2: Infrastructure Layer — Session Management

### Task 6: Claude CLI session spawner

**Files:**
- Create: `src/claude/session.ts`
- Create: `src/__tests__/claude-session.test.ts`

- [ ] **Step 1: Write the failing test**

Test that `spawnOneShot` builds the correct command array and captures output. Use a mock command (`echo`) instead of actual `claude` CLI for testing.

```typescript
import { describe, it, expect } from "vitest";
import { buildOneShotArgs, buildAgenticArgs, parseSessionOutput } from "../claude/session.js";

describe("claude session", () => {
  it("builds one-shot args correctly", () => {
    const args = buildOneShotArgs({
      model: "opus",
      prompt: "do something",
    });
    expect(args).toContain("--print");
    expect(args).toContain("--model");
    expect(args).toContain("opus");
    expect(args).toContain("-p");
  });

  it("builds agentic args with skip-permissions", () => {
    const args = buildAgenticArgs({
      model: "opus",
      prompt: "do something",
      maxTurns: 200,
      skipPermissions: true,
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--max-turns");
    expect(args).toContain("200");
    expect(args).not.toContain("--print");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd $PROJECT_ROOT && npx vitest run src/__tests__/claude-session.test.ts`

- [ ] **Step 3: Implement session.ts**

Two main functions:
- `runOneShot(opts)` — spawns `claude --print --model X -p "prompt"`, captures stdout, returns string output. Timeout via `AbortController`.
- `runAgentic(opts)` — spawns `claude --model X --dangerously-skip-permissions -p "prompt" --max-turns N` in a given cwd. Returns `ChildProcess` handle for the daemon to monitor. Captures output to a log file.

Helper functions: `buildOneShotArgs`, `buildAgenticArgs` for testability.

Both use `child_process.spawn` directly. Handle process exit codes, timeout kills, stderr capture.

- [ ] **Step 4: Run tests**

Run: `cd $PROJECT_ROOT && npx vitest run src/__tests__/claude-session.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/claude/session.ts src/__tests__/claude-session.test.ts
git commit -m "feat: claude CLI session spawner"
```

---

### Task 7: Prompt template loader

**Files:**
- Create: `src/claude/prompts.ts`
- Create: `src/__tests__/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { renderTemplate } from "../claude/prompts.js";

describe("prompts", () => {
  it("replaces template variables", () => {
    const template = "Review round {{round}} of {{total_rounds}} for issue #{{issue_number}}.";
    const result = renderTemplate(template, {
      round: "3",
      total_rounds: "7",
      issue_number: "42",
    });
    expect(result).toBe("Review round 3 of 7 for issue #42.");
  });

  it("leaves unknown variables as-is", () => {
    const result = renderTemplate("Hello {{name}}, your {{unknown}} is ready.", {
      name: "the Operator",
    });
    expect(result).toBe("Hello the Operator, your {{unknown}} is ready.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement prompts.ts**

`loadPrompt(templateName, promptsDir)` — reads `{promptsDir}/{templateName}.md`, returns string.
`renderTemplate(template, vars)` — replaces `{{key}}` with values from vars object.
`assemblePrompt(templateName, promptsDir, vars, contextSections)` — loads template, renders vars, appends context sections (issue body, spec content, etc.).

- [ ] **Step 4: Run tests, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/claude/prompts.ts src/__tests__/prompts.test.ts
git commit -m "feat: prompt template loader with variable rendering"
```

---

### Task 8: Git worktree manager

**Files:**
- Create: `src/claude/worktree.ts`
- Create: `src/__tests__/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

Test `createWorktree`, `removeWorktree`, `mergeWorktree` against a real temp git repo.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorktreeManager } from "../claude/worktree.js";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("WorktreeManager", () => {
  let repoDir: string;
  let mgr: WorktreeManager;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "ac-wt-"));
    execSync("git init && git checkout -b main", { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "init");
    execSync("git add . && git commit -m 'init'", { cwd: repoDir });
    execSync("git checkout -b dev", { cwd: repoDir });
    mgr = new WorktreeManager(repoDir);
  });

  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("creates and removes a worktree", () => {
    // Uses "dev" (created in setup) as the base branch
    const wtPath = mgr.create("dev", "unit-1");
    expect(wtPath).toContain("unit-1");
    const branches = execSync("git worktree list", { cwd: repoDir }).toString();
    expect(branches).toContain("unit-1");
    mgr.remove("unit-1");
    const after = execSync("git worktree list", { cwd: repoDir }).toString();
    expect(after).not.toContain("unit-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement worktree.ts**

`WorktreeManager` class:
- `create(baseBranch, unitId)` — runs `git worktree add .factory/worktrees/{unitId} -b factory/{unitId} {baseBranch}`, returns worktree path.
- `remove(unitId)` — runs `git worktree remove .factory/worktrees/{unitId}`, prunes.
- `merge(unitId, targetBranch)` — checks out targetBranch, runs `git merge --no-ff factory/{unitId}`, returns success/conflict status.
- `listActive()` — parses `git worktree list` output.

All methods use `execFile` (promisified via `util.promisify`) with argument arrays to avoid shell injection and to avoid blocking the event loop during concurrent operations.

- [ ] **Step 4: Run tests, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/claude/worktree.ts src/__tests__/worktree.test.ts
git commit -m "feat: git worktree manager"
```

### Task 8b: Worker thread pool

**Files:**
- Create: `src/infra/worker-pool.ts`
- Create: `src/infra/session-worker.ts`
- Create: `src/infra/worker-events.ts`
- Create: `src/__tests__/worker-pool.test.ts`

- [ ] **Step 1: Write worker-events.ts**

Typed event definitions for `postMessage()` communication between main thread and workers. Uses the `WorkerEvent` type from `types.ts`.

- [ ] **Step 2: Write session-worker.ts**

Worker thread entry point. Receives session config via `workerData`. Spawns `claude` child process, captures stdout/stderr to log file, enforces timeout, parses cost on completion, emits structured events via `parentPort.postMessage()`.

- [ ] **Step 3: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { WorkerPool } from "../infra/worker-pool.js";

describe("WorkerPool", () => {
  it("enforces concurrency limit", async () => {
    const pool = new WorkerPool({ maxConcurrent: 2 });
    let running = 0;
    let maxRunning = 0;

    const task = () => new Promise<void>((resolve) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      setTimeout(() => { running--; resolve(); }, 50);
    });

    await Promise.all([pool.run(task), pool.run(task), pool.run(task)]);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 4: Implement worker-pool.ts**

`WorkerPool` class:
- `spawn(sessionType, contextVars, cwd?)` — looks up `AgentConfig` from registry, creates a `Worker` from `session-worker.ts`, passes config via `workerData`, returns a `SessionHandle` with events and a `kill()` method.
- Enforces `maxConcurrent` (from `safety.max_total_claude_sessions`) via a semaphore — queues excess requests.
- `staggerDelayMs` config (default: 3000) — when launching multiple workers in a batch, stagger starts by this delay to avoid API thundering herd.
- Tracks active workers for signal handler cleanup.
- Relays worker events to caller via typed event emitter.

Add a test for stagger behavior: spawn 3 workers with staggerDelayMs=100, verify that start times are at least 100ms apart.

- [ ] **Step 5: Run tests, verify PASS**

- [ ] **Step 6: Commit**

```bash
git add src/infra/worker-pool.ts src/infra/session-worker.ts src/infra/worker-events.ts src/__tests__/worker-pool.test.ts
git commit -m "feat: worker thread pool for session isolation"
```

---

### Task 8c: Rate limit handler

**Files:**
- Create: `src/infra/rate-limit.ts`
- Create: `src/__tests__/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { RateLimitHandler } from "../infra/rate-limit.js";

describe("RateLimitHandler", () => {
  it("sets cooldown on rate limit detection", () => {
    const handler = new RateLimitHandler();
    handler.recordRateLimit();
    expect(handler.isCoolingDown()).toBe(true);
  });

  it("clears cooldown after expiry", () => {
    const handler = new RateLimitHandler();
    handler.recordRateLimit();
    // Fast-forward past cooldown
    handler.setCooldownUntil(new Date(Date.now() - 1000));
    expect(handler.isCoolingDown()).toBe(false);
  });

  it("uses exponential backoff", () => {
    const handler = new RateLimitHandler();
    handler.recordRateLimit(); // 30s
    const first = handler.getCooldownDuration();
    handler.recordRateLimit(); // 60s
    const second = handler.getCooldownDuration();
    expect(second).toBeGreaterThan(first);
  });
});
```

- [ ] **Step 2: Implement rate-limit.ts**

`RateLimitHandler`:
- `recordRateLimit(retryAfter?)` — sets `cooldownUntil` using `Retry-After` value or exponential backoff (30s → 60s → 120s → 300s cap).
- `isCoolingDown()` — returns `true` if `now < cooldownUntil`.
- `getCooldownRemaining()` — returns milliseconds until cooldown expires.
- `reset()` — clears cooldown after a successful session (resets backoff level).

Detection: the worker thread checks for "rate limit", "429", or "too many requests" in stderr on session error and sets `isRateLimit: true` in the `session:error` event. The pool relays this to the handler.

- [ ] **Step 3: Run tests, verify PASS**

- [ ] **Step 4: Commit**

```bash
git add src/infra/rate-limit.ts src/__tests__/rate-limit.test.ts
git commit -m "feat: rate limit handler with exponential backoff"
```

---

### Task 8d: Worktree sparse checkout for scenario isolation

**Files:**
- Modify: `src/claude/worktree.ts`
- Modify: `src/__tests__/worktree.test.ts`

- [ ] **Step 1: Update WorktreeManager.create() to use sparse checkout**

After creating the worktree, configure sparse checkout to exclude `.specify/scenarios/`:

```bash
git -C {worktreePath} sparse-checkout init
git -C {worktreePath} sparse-checkout set '/*' '!/.specify/scenarios/'
```

This is the technical enforcement of AGENTS.md rule 4 — workers literally cannot see scenario files.

- [ ] **Step 2: Add test for sparse checkout**

Verify that after creating a worktree, `.specify/scenarios/` is not present in the worktree directory.

- [ ] **Step 3: Run tests, verify PASS**

- [ ] **Step 4: Commit**

```bash
git add src/claude/worktree.ts src/__tests__/worktree.test.ts
git commit -m "feat: sparse checkout in worktrees excludes holdout scenarios"
```

---

## Chunk 2b: Orchestration Layer

### Task 8e: Finite state machine engine

**Files:**
- Create: `src/orchestration/fsm.ts`
- Create: `src/__tests__/fsm.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { FSM } from "../orchestration/fsm.js";

describe("FSM", () => {
  it("transitions through states on success", async () => {
    const visited: string[] = [];
    const fsm = new FSM({
      initial: "a",
      states: {
        a: {
          execute: async () => { visited.push("a"); return { status: "success" }; },
          transitions: { success: "b", failure: "stuck" },
          retryable: false,
        },
        b: {
          execute: async () => { visited.push("b"); return { status: "success" }; },
          transitions: { success: "complete", failure: "stuck" },
          retryable: false,
        },
      },
    });
    await fsm.run();
    expect(visited).toEqual(["a", "b"]);
    expect(fsm.currentState).toBe("complete");
  });

  it("retries on failure up to maxRetries", async () => {
    let attempts = 0;
    const fsm = new FSM({
      initial: "a",
      states: {
        a: {
          execute: async () => {
            attempts++;
            if (attempts < 3) return { status: "failure", error: "fail" };
            return { status: "success" };
          },
          transitions: { success: "complete", failure: "stuck" },
          retryable: true,
          maxRetries: 3,
        },
      },
    });
    await fsm.run();
    expect(attempts).toBe(3);
    expect(fsm.currentState).toBe("complete");
  });

  it("transitions to stuck after max retries", async () => {
    const fsm = new FSM({
      initial: "a",
      states: {
        a: {
          execute: async () => ({ status: "failure", error: "always fails" }),
          transitions: { success: "complete", failure: "stuck" },
          retryable: true,
          maxRetries: 2,
        },
      },
    });
    await fsm.run();
    expect(fsm.currentState).toBe("stuck");
  });

  it("skips states when skip transition used", async () => {
    const visited: string[] = [];
    const fsm = new FSM({
      initial: "a",
      states: {
        a: {
          execute: async () => { visited.push("a"); return { status: "skip" }; },
          transitions: { success: "b", failure: "stuck", skip: "c" },
          retryable: false,
        },
        b: {
          execute: async () => { visited.push("b"); return { status: "success" }; },
          transitions: { success: "c", failure: "stuck" },
          retryable: false,
        },
        c: {
          execute: async () => { visited.push("c"); return { status: "success" }; },
          transitions: { success: "complete", failure: "stuck" },
          retryable: false,
        },
      },
    });
    await fsm.run();
    expect(visited).toEqual(["a", "c"]);
  });

  it("resumes from a given state", async () => {
    const visited: string[] = [];
    const fsm = new FSM({
      initial: "b", // resume from b, skip a
      states: {
        a: {
          execute: async () => { visited.push("a"); return { status: "success" }; },
          transitions: { success: "b", failure: "stuck" },
          retryable: false,
        },
        b: {
          execute: async () => { visited.push("b"); return { status: "success" }; },
          transitions: { success: "complete", failure: "stuck" },
          retryable: false,
        },
      },
    });
    await fsm.run();
    expect(visited).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Implement fsm.ts**

Generic FSM engine (~100 lines):
- Constructor takes `FSMDefinition` (states, initial state, context).
- `run()` — executes the FSM: for current state, call `onEnter`, `execute`, `onExit`. On success/failure/skip, follow the transition. Retry on failure if `retryable`. Stop at `complete` or `stuck`.
- `currentState` — readable property.
- Emits events: `phase:enter`, `phase:exit`, `phase:retry`, `phase:stuck` for observability.
- Supports `paused` state: any handler can throw a `PauseError` to pause the FSM. The FSM saves its state and stops. `resume()` continues from the paused state.

- [ ] **Step 3: Run tests, verify PASS**

- [ ] **Step 4: Commit**

```bash
git add src/orchestration/fsm.ts src/__tests__/fsm.test.ts
git commit -m "feat: finite state machine engine for pipeline orchestration"
```

---

### Task 8f: Agent config registry

**Files:**
- Create: `src/orchestration/agent-configs.ts`
- Create: `src/__tests__/agent-configs.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { getAgentConfig, AGENT_CONFIGS } from "../orchestration/agent-configs.js";

describe("agent-configs", () => {
  it("returns config for known session types", () => {
    const config = getAgentConfig("worker");
    expect(config.model).toBe("opus");
    expect(config.mode).toBe("agentic");
    expect(config.skipPermissions).toBe(true);
    expect(config.prohibitedPaths).toContain(".specify/scenarios/");
  });

  it("all session types have configs", () => {
    const types = ["coordinator", "classifier", "worker", "reviewer-spec",
      "reviewer-quality", "reviewer-security", "conflict-resolver", "bug-worker",
      "tester", "diagnostician", "reporter", "prompt-optimizer"];
    for (const t of types) {
      expect(AGENT_CONFIGS[t]).toBeDefined();
    }
  });

  it("applies config overrides", () => {
    const config = getAgentConfig("worker", { timeoutMinutes: 120 });
    expect(config.timeoutMinutes).toBe(120);
  });
});
```

- [ ] **Step 2: Implement agent-configs.ts**

The `AGENT_CONFIGS` registry as described in the design doc. `getAgentConfig(sessionType, overrides?)` merges overrides from `factory.config.yaml` on top of defaults.

- [ ] **Step 3: Run tests, verify PASS**

- [ ] **Step 4: Commit**

```bash
git add src/orchestration/agent-configs.ts src/__tests__/agent-configs.test.ts
git commit -m "feat: centralized agent config registry"
```

---

### Task 8g: Recovery manager with circular fix detection

**Files:**
- Create: `src/orchestration/recovery.ts`
- Create: `src/__tests__/recovery.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { RecoveryManager, CircularFixDetector } from "../orchestration/recovery.js";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("CircularFixDetector", () => {
  it("returns retry for first occurrence", () => {
    const detector = new CircularFixDetector();
    expect(detector.recordError("implement", "TypeError: x is not a function")).toBe("retry");
  });

  it("returns escalate after 3 identical errors", () => {
    const detector = new CircularFixDetector();
    detector.recordError("implement", "TypeError: x is not a function");
    detector.recordError("implement", "TypeError: x is not a function");
    expect(detector.recordError("implement", "TypeError: x is not a function")).toBe("escalate");
  });

  it("normalizes errors (strips paths and timestamps)", () => {
    const detector = new CircularFixDetector();
    detector.recordError("implement", "Error at /Users/foo/bar.ts:42 at 2026-03-14T10:00:00Z");
    detector.recordError("implement", "Error at /Users/baz/bar.ts:99 at 2026-03-14T11:00:00Z");
    expect(detector.recordError("implement", "Error at /Users/qux/bar.ts:1 at 2026-03-14T12:00:00Z")).toBe("escalate");
  });
});

describe("RecoveryManager", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ac-recovery-")); });
  afterEach(() => rmSync(dir, { recursive: true }));

  it("saves and loads checkpoints atomically", () => {
    const mgr = new RecoveryManager(dir);
    mgr.saveCheckpoint(42, { phase: "implement", checkpoint: "batch-1-unit-2-complete", data: { batch: 1 }, savedAt: new Date().toISOString() });
    const cp = mgr.loadCheckpoint(42);
    expect(cp?.checkpoint).toBe("batch-1-unit-2-complete");
  });
});
```

- [ ] **Step 2: Implement recovery.ts**

`CircularFixDetector`:
- `recordError(phase, error)` — normalizes error (strip timestamps, absolute paths, line numbers via regex), hashes with SHA-256, tracks count. Returns `"retry"` or `"escalate"` (at threshold 3).
- `getErrorHashes()` / `loadErrorHashes(hashes)` — for persistence in `run.json`.

`RecoveryManager`:
- `saveCheckpoint(issueNumber, checkpoint)` — atomic write (temp → rename) to `{stateDir}/runs/issue-{N}/checkpoint.json`.
- `loadCheckpoint(issueNumber)` — returns last checkpoint or `null`.
- `clearCheckpoint(issueNumber)` — removes checkpoint file (on phase completion).

- [ ] **Step 3: Run tests, verify PASS**

- [ ] **Step 4: Commit**

```bash
git add src/orchestration/recovery.ts src/__tests__/recovery.test.ts
git commit -m "feat: recovery manager with checkpointing and circular fix detection"
```

---

### Task 8h: Pipeline definitions (feature, feature-simple, bug)

**Files:**
- Create: `src/orchestration/pipelines.ts`
- Create: `src/__tests__/pipelines.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { getFeaturePipeline, getFeatureSimplePipeline, getBugPipeline } from "../orchestration/pipelines.js";

describe("pipelines", () => {
  it("feature pipeline includes all phases in order", () => {
    const phases = Object.keys(getFeaturePipeline().states);
    expect(phases).toEqual(["detect", "classify", "decompose", "implement", "review", "holdout", "pr_to_dev", "deploy_dev", "test", "close_report"]);
  });

  it("feature-simple pipeline skips decompose", () => {
    const pipeline = getFeatureSimplePipeline();
    expect(pipeline.states.classify.transitions.success).toBe("implement");
    expect(pipeline.states["decompose"]).toBeUndefined();
  });

  it("bug pipeline skips classify, decompose, holdout", () => {
    const pipeline = getBugPipeline();
    expect(pipeline.states["classify"]).toBeUndefined();
    expect(pipeline.states["decompose"]).toBeUndefined();
    expect(pipeline.states["holdout"]).toBeUndefined();
    expect(pipeline.states.detect.transitions.success).toBe("implement");
  });
});
```

- [ ] **Step 2: Implement pipelines.ts**

Three functions that return FSM definitions with the correct state configs and transition maps. Phase `execute` functions are stubs that will be wired in the integration task. Each state config includes appropriate `onEnter`/`onExit` hooks for cost tracking, checkpoint saves, and gotcha injection.

- [ ] **Step 3: Run tests, verify PASS**

- [ ] **Step 4: Commit**

```bash
git add src/orchestration/pipelines.ts src/__tests__/pipelines.test.ts
git commit -m "feat: pipeline definitions for feature, feature-simple, and bug variants"
```

---

## Chunk 2c: Intelligence Layer

### Task 8i: Complexity assessor

**Files:**
- Create: `src/intelligence/complexity.ts`
- Create: `src/__tests__/complexity.test.ts`
- Create: `prompts/classifier.md`

- [ ] **Step 1: Write classifier prompt**

Lightweight prompt: receives issue summary + spec list, outputs JSON `{complexity, reasoning, estimatedUnits, estimatedFiles}`. Uses sonnet for cost efficiency (~$0.01 per call).

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { routePipeline, parseClassification } from "../intelligence/complexity.js";

describe("complexity", () => {
  it("routes simple classification to feature-simple", () => {
    const variant = routePipeline({ complexity: "simple", reasoning: "one file change", estimatedUnits: 1, estimatedFiles: 2 });
    expect(variant).toBe("feature-simple");
  });

  it("routes standard classification to feature", () => {
    const variant = routePipeline({ complexity: "standard", reasoning: "multi-unit", estimatedUnits: 3, estimatedFiles: 8 });
    expect(variant).toBe("feature");
  });

  it("parses valid classification JSON", () => {
    const result = parseClassification('{"complexity":"complex","reasoning":"cross-cutting","estimatedUnits":7,"estimatedFiles":15}');
    expect(result.complexity).toBe("complex");
  });

  it("throws on invalid classification", () => {
    expect(() => parseClassification("not json")).toThrow();
  });
});
```

- [ ] **Step 3: Implement complexity.ts**

`classify(issue, config, workerPool)` — assembles classifier prompt, runs one-shot session via worker pool, parses JSON output, returns `ComplexityAssessment`.

`routePipeline(assessment)` — maps complexity to `PipelineVariant`. Returns extra review rounds for complex issues.

`parseClassification(output)` — validates JSON against `ComplexityAssessment` schema.

- [ ] **Step 4: Run tests, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/complexity.ts src/__tests__/complexity.test.ts prompts/classifier.md
git commit -m "feat: complexity assessor with pipeline routing"
```

---

### Task 8j: Gotcha store

**Files:**
- Create: `src/intelligence/gotchas.ts`
- Create: `src/__tests__/gotchas.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GotchaStore } from "../intelligence/gotchas.js";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("GotchaStore", () => {
  let dir: string;
  let store: GotchaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-gotchas-"));
    store = new GotchaStore(join(dir, "gotchas.jsonl"));
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  it("records and retrieves gotchas", () => {
    store.record({ filePaths: ["app/models/*.rb"], gotcha: "needs explicit save", issueNumber: 42 });
    const matches = store.match(["app/models/user.rb"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].gotcha).toBe("needs explicit save");
  });

  it("does not match unrelated paths", () => {
    store.record({ filePaths: ["app/models/*.rb"], gotcha: "needs explicit save", issueNumber: 42 });
    const matches = store.match(["app/controllers/auth.rb"]);
    expect(matches).toHaveLength(0);
  });

  it("parses GOTCHA markers from session output", () => {
    const output = 'some text\nGOTCHA: {"filePaths": ["lib/*.ts"], "gotcha": "watch out"}\nmore text';
    const gotchas = GotchaStore.parseFromOutput(output);
    expect(gotchas).toHaveLength(1);
    expect(gotchas[0].gotcha).toBe("watch out");
  });

  it("increments hitCount on match", () => {
    store.record({ filePaths: ["app/*.rb"], gotcha: "test", issueNumber: 1 });
    store.match(["app/foo.rb"]);
    store.match(["app/bar.rb"]);
    const all = store.all();
    expect(all[0].hitCount).toBe(2);
  });
});
```

- [ ] **Step 2: Implement gotchas.ts**

`GotchaStore`:
- `record(gotcha)` — appends to JSONL file with unique ID and timestamp.
- `match(codePaths)` — loads JSONL, matches `filePaths` globs against `codePaths` using `minimatch`. Increments `hitCount`. Returns matching gotchas.
- `formatForPrompt(gotchas)` — renders matched gotchas as a markdown section for prompt injection.
- `parseFromOutput(output)` — extracts `GOTCHA: {...}` markers from session output via regex.
- `prune(maxAge, maxHits)` — moves old/overused gotchas to archive file.
- `all()` — returns all active gotchas.
- `promote(threshold, maxAge)` — finds gotchas with `hitCount >= threshold` and age < `maxAge` days. Writes proposed CLAUDE.md additions to `CLAUDE.md.proposed` for human review. Marks promoted gotchas as `promoted: true`.

Uses `minimatch` for glob matching (add to dependencies: `npm install minimatch`).

Add a test for the promotion logic: record multiple gotchas with varying hit counts, call `promote(threshold=3, maxAge=30)`, verify that only gotchas meeting the threshold are written to `CLAUDE.md.proposed` and marked as `promoted: true`.

- [ ] **Step 3: Run tests, verify PASS**

- [ ] **Step 4: Commit**

```bash
git add src/intelligence/gotchas.ts src/__tests__/gotchas.test.ts
git commit -m "feat: gotcha store with JSONL persistence and glob matching"
```

---

## Chunk 3: Queue System

### Task 9: GitHub Issue poller

**Files:**
- Create: `src/queue/poller.ts`
- Create: `src/__tests__/poller.test.ts`

- [ ] **Step 1: Write the failing test**

Test that `pollForIssues` builds the correct `gh` command and parses JSON output. Mock `execSync` to return sample `gh` output.

```typescript
import { describe, it, expect } from "vitest";
import { parseGhIssueList } from "../queue/poller.js";

describe("poller", () => {
  it("parses gh issue list JSON output", () => {
    const ghOutput = JSON.stringify([
      { number: 42, title: "Implement user auth", labels: [{ name: "factory-ready" }], body: "## Summary\nAdd auth" },
      { number: 43, title: "Add billing", labels: [{ name: "factory-ready" }], body: "## Summary\nBilling" },
    ]);
    const issues = parseGhIssueList(ghOutput);
    expect(issues).toHaveLength(2);
    expect(issues[0].number).toBe(42);
  });

  it("returns empty array on no issues", () => {
    const issues = parseGhIssueList("[]");
    expect(issues).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement poller.ts**

`pollForIssues(repo, label)` — runs `gh issue list --repo {repo} --label {label} --json number,title,labels,body --limit 10`, parses output.
`parseGhIssueList(json)` — pure function for testability.
`pollForBugs(repo)` — same but filters for `bug` label.

- [ ] **Step 4: Run tests, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/queue/poller.ts src/__tests__/poller.test.ts
git commit -m "feat: github issue poller"
```

---

### Task 10: Issue claimer

**Files:**
- Create: `src/queue/claimer.ts`

- [ ] **Step 1: Implement claimer.ts**

`claimIssue(repo, issueNumber)` — runs `gh issue edit {issueNumber} --repo {repo} --remove-label factory-ready --add-label factory-in-progress`.
`releaseIssue(repo, issueNumber, label)` — sets a given label (for `factory-stuck`, `needs-spec-update`, etc.).
`closeIssue(repo, issueNumber, label)` — adds label + closes issue.
`commentOnIssue(repo, issueNumber, body)` — runs `gh issue comment`.

All thin wrappers around `gh` CLI via `execSync`.

- [ ] **Step 2: Commit**

```bash
git add src/queue/claimer.ts
git commit -m "feat: github issue claimer"
```

---

### Task 11: Issue body parser

**Files:**
- Create: `src/queue/parser.ts`
- Create: `src/__tests__/parser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { parseIssueBody } from "../queue/parser.js";

describe("parser", () => {
  it("extracts structured data from issue body", () => {
    const body = `## Summary
Add email/password auth with JWT tokens.

## Specs
- FUNC-USER-AUTH (L1): .specify/functional/user-auth.md
- ARCH-AUTH-FLOW (L2): .specify/architecture/auth-flow.md
- RAIL-AUTH (L3): .specify/flavors/rails/auth.md

## Scope
- User model + migration
- Sessions controller

## Acceptance Criteria
- User can register, login, logout
- Passwords bcrypt-hashed

## Config
- has_ui: true
- deep_review_rounds: 7
- priority: high`;

    const payload = parseIssueBody(42, "Implement user auth", body, ["factory-ready"]);
    expect(payload.summary).toContain("email/password auth");
    expect(payload.specs).toHaveLength(3);
    expect(payload.specs[0].id).toBe("FUNC-USER-AUTH");
    expect(payload.specs[0].layer).toBe("L1");
    expect(payload.scope).toHaveLength(2);
    expect(payload.config.hasUi).toBe(true);
    expect(payload.config.priority).toBe("high");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement parser.ts**

Parse markdown sections using regex. Extract specs with pattern `- {ID} ({layer}): {path}`. Parse config key-value pairs. Return `IssuePayload`.

- [ ] **Step 4: Run tests, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/queue/parser.ts src/__tests__/parser.test.ts
git commit -m "feat: github issue body parser"
```

---

## Chunk 4: Pipeline Phases 1-3

### Task 12: Pipeline runner (FSM-based orchestrator)

**Files:**
- Create: `src/orchestration/runner.ts`

- [ ] **Step 1: Implement runner.ts**

The core orchestration wrapper around the FSM. `PipelineRunner` class:

```typescript
export class PipelineRunner {
  constructor(
    private config: Config,
    private store: StateStore,
    private workerPool: WorkerPool,
    private recovery: RecoveryManager,
    private circularDetector: CircularFixDetector,
    private rateLimiter: RateLimitHandler,
    private gotchaStore: GotchaStore,
    private logger: Logger,
  ) {}

  async run(issue: IssuePayload, variant: PipelineVariant): Promise<void> {
    const run = this.store.loadOrCreateRun(issue.issueNumber);
    const ctx: RunContext = { issue, config: this.config, run, pipelineVariant: variant };

    // Select pipeline definition based on variant
    const pipelineDef = variant === "bug" ? getBugPipeline()
      : variant === "feature-simple" ? getFeatureSimplePipeline()
      : getFeaturePipeline();

    // Wire phase execute functions to phase modules
    this.wirePhaseHandlers(pipelineDef, ctx);

    // Wire FSM hooks for cross-cutting concerns
    this.wireHooks(pipelineDef, ctx);

    // Resume from current phase if recovering from crash
    const initialState = run.currentPhase;
    const fsm = new FSM({ ...pipelineDef, initial: initialState, context: ctx });

    // Run to completion, stuck, or paused
    await fsm.run();

    if (fsm.currentState === "stuck") {
      await this.handleStuck(issue);
    }
  }
}
```

The runner:
- Selects the FSM definition based on pipeline variant (feature/feature-simple/bug)
- Wires phase modules as `execute` handlers on each FSM state
- Wires `onEnter` hooks: log phase start, check budget via `CostTracker`, check rate limit via `RateLimitHandler`, inject gotchas via `GotchaStore`
- Wires `onExit` hooks: record cost, save checkpoint via `RecoveryManager`, persist state
- Integrates `CircularFixDetector` into the FSM's retry logic — if `recordError()` returns `"escalate"`, the FSM transitions to `stuck`
- Resumes from `run.currentPhase` after crash

- [ ] **Step 2: Commit**

```bash
git add src/orchestration/runner.ts
git commit -m "feat: FSM-based pipeline runner with cross-cutting hooks"
```

---

### Task 13: Phase 1 — Detect

**Files:**
- Create: `src/phases/detect.ts`

- [ ] **Step 1: Implement detect.ts**

`detect(issue, config, store, logger)`:
1. Log: "Detected issue #{N}: {title}"
2. Claim the issue (swap labels via claimer)
3. Create run state
4. Save issue body to `state/runs/issue-{N}/issue_body.md`

Thin — most work was done by poller + claimer already.

- [ ] **Step 2: Commit**

```bash
git add src/phases/detect.ts
git commit -m "feat: phase 1 detect"
```

---

### Task 13b: Phase 1b — Classify

**Files:**
- Create: `src/phases/classify.ts`

- [ ] **Step 1: Implement classify.ts**

`classify(ctx: RunContext)`:
1. Skip if bug pipeline (return `{ status: "skip" }`)
2. Call `complexity.classify(ctx.issue, ctx.config, workerPool)` from intelligence layer
3. Save classification to `run.json`
4. Set `ctx.pipelineVariant` based on result:
   - `simple` → `"feature-simple"`
   - `standard`/`complex` → `"feature"`
5. If variant changed from default, log and notify
6. Return `{ status: "success" }`. The pipeline variant (feature vs feature-simple) is determined by the FSM definition itself — feature-simple's FSM has no decompose state and routes classify.success directly to implement. The classify phase does not need to return 'skip'.

- [ ] **Step 2: Commit**

```bash
git add src/phases/classify.ts
git commit -m "feat: phase 1b classify with complexity-gated routing"
```

---

### Task 14: Phase 2 — Decompose

**Files:**
- Create: `src/phases/decompose.ts`
- Create: `prompts/coordinator.md`

- [ ] **Step 1: Write coordinator prompt**

Full prompt from the design doc's coordinator section. Instructs Claude to:
- Read specs in understanding order (L1 → L2 → L3)
- Analyze code_paths for file-level dependencies
- Output task-graph.json with units grouped into batches
- JSON output format with schema

- [ ] **Step 2: Implement decompose.ts**

`decompose(issue, config, store, logger)`:
1. Assemble coordinator prompt with issue body, spec file contents, traceability.yml
2. Run one-shot Claude session via `runOneShot`
3. Parse output as JSON
4. Validate against TaskGraph schema
5. Save to `state/runs/issue-{N}/task-graph.json`
6. Create feature branch: `git checkout -b factory/issue-{N}-{slug} ${config.project.dev_branch}` (idempotent — if branch already exists from a previous attempt, check it out instead of creating)

- [ ] **Step 3: Commit**

```bash
git add src/phases/decompose.ts prompts/coordinator.md
git commit -m "feat: phase 2 decompose with coordinator prompt"
```

---

### Task 15: Phase 3 — Implement

**Files:**
- Create: `src/phases/implement.ts`
- Create: `prompts/worker.md`

- [ ] **Step 1: Write worker prompt**

Full prompt from the design doc. All spec content is pre-loaded in the prompt — the worker MUST NOT read spec files via Read tool (context isolation: the daemon pre-loads spec content, unit context, and gotchas into the prompt so workers never read spec files themselves). TDD protocol:
1. Write failing test (RED)
2. Verify test fails
3. Implement code (GREEN)
4. Verify test passes
5. Refactor if needed
6. Run full unit test suite
7. Commit with exit status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT

Includes max cycle limit and "needs-help" exit condition.

- [ ] **Step 2: Implement implement.ts**

`implement(issue, config, store, logger)`:
1. Load task graph
2. Group units by batch number
3. For each batch (sequential):
   a. For each unit in batch (parallel):
      - Create worktree via WorktreeManager
      - Pre-load spec content, unit context, and gotchas (context isolation — worker never reads spec files itself)
      - Assemble worker prompt with all pre-loaded content injected
      - Spawn agentic Claude session in worktree cwd following TDD protocol (RED → GREEN → refactor → commit)
      - Monitor process (timeout, exit code)
      - Parse worker exit status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
      - Update unit state
   b. Wait for all parallel workers to finish
   c. Merge worktrees into feature branch (`--no-ff`)
   d. If merge conflict: spawn conflict-resolution session
   e. Post-merge verification (run compile/typecheck command if configured)
   f. Clean up worktrees

Uses a concurrency-limited worker pool (implement a simple semaphore — do NOT use `Promise.all` directly as it launches all at once). The pool enforces `config.claude.max_parallel_workers` as the max concurrency.

- [ ] **Step 3: Commit**

```bash
git add src/phases/implement.ts prompts/worker.md
git commit -m "feat: phase 3 implement with parallel worktrees"
```

---

## Chunk 5: Pipeline Phases 4-5

### Task 16: Phase 4 — Heterogeneous Review Gates

**Files:**
- Create: `src/phases/review.ts`
- Create: `prompts/reviewer-spec-compliance.md`
- Create: `prompts/reviewer-code-quality.md`
- Create: `prompts/reviewer-security.md`

- [ ] **Step 1: Write three reviewer prompts**

Each reviewer is a fresh agent with a different focus:
- `reviewer-spec-compliance.md` — verifies every acceptance criterion from the spec is met. Independent file reading, never trusts implementer. Outputs findings.
- `reviewer-code-quality.md` — reviews for maintainability, patterns, YAGNI, test quality.
- `reviewer-security.md` — reviews for injection, auth gaps, data validation, race conditions. Only used for `complex` classified issues.

- [ ] **Step 2: Implement review.ts**

`review(ctx: RunContext)`:
1. **Gate 1 — Deterministic:** Run configured test/typecheck/lint commands. If fails, spawn worker to fix, then re-run gate 1. Checkpoint after gate 1 passes.
2. **Gate 2 — Spec compliance:** Spawn `reviewer-spec` session via worker pool. Parse findings. If issues found, spawn worker to fix, checkpoint, restart from gate 1.
3. **Gate 3 — Code quality:** Spawn `reviewer-quality` session. Same fix loop.
4. **Gate 4 — Security (complex only):** If `ctx.complexity === "complex"`, spawn `reviewer-security` session. Same fix loop.
5. Max fix cycles bounded by `config.pipeline.worker.max_review_fix_cycles`.
6. For `simple` issues: only gates 1 + 2.
7. Save all review outputs to `state/runs/issue-{N}/reviews/`.

- [ ] **Step 3: Commit**

```bash
git add src/phases/review.ts prompts/reviewer-spec-compliance.md prompts/reviewer-code-quality.md prompts/reviewer-security.md
git commit -m "feat: phase 4 heterogeneous review gates"
```

---

### Task 17: Phase 5 — Holdout validation

**Files:**
- Create: `src/phases/holdout.ts`

- [ ] **Step 1: Implement holdout.ts**

`holdout(issue, config, store, logger)`:
1. Check if holdout scenario runner exists (config.testing.scenario_command or `bin/run-scenarios`)
2. If not configured, skip phase (log warning)
3. Run scenario command via `execSync`
4. Parse exit code: 0 = pass, non-zero = failures
5. Capture stdout for structured output (which scenarios failed)
6. If failures: label issue `needs-spec-update`, comment with failure summary (WITHOUT scenario content), throw to halt pipeline
7. If pass: continue

**Critical:** No Claude session touches scenarios. This is pure shell execution.

- [ ] **Step 2: Commit**

```bash
git add src/phases/holdout.ts
git commit -m "feat: phase 5 holdout validation via shell runner"
```

---

### Task 18: Phase 6 — PR to Dev

**Files:**
- Create: `src/phases/pr.ts`

- [ ] **Step 1: Implement pr.ts**

`prToDev(issue, config, store, logger)`:
1. Push feature branch to remote: `git push origin factory/issue-{N}-{slug}`
2. Create PR: `gh pr create --base dev --head factory/issue-{N}-{slug} --title "..." --body "..."`
3. Run one final /deep-review Claude session on the PR diff
4. If clean: auto-merge via `gh pr merge --auto --merge`
5. Save PR number to run state

- [ ] **Step 2: Commit**

```bash
git add src/phases/pr.ts
git commit -m "feat: phase 6 PR to dev with auto-merge"
```

---

## Chunk 6: Pipeline Phases 6-8

### Task 19: Phase 7 — Deploy to Dev

**Files:**
- Create: `src/phases/deploy-dev.ts`

- [ ] **Step 1: Implement deploy-dev.ts**

`deployDev(issue, config, store, logger)`:
1. Run `config.dev.deploy_command` via `exec`
2. Poll `config.dev.health_check_url` with timeout:
   - HTTP GET every 5 seconds
   - Check for 200 status
   - Timeout after `config.dev.health_check_timeout_seconds`
3. If healthy: continue
4. If timeout: throw with deploy failure context

Uses Node built-in `http`/`https` for health checks (no external deps).

- [ ] **Step 2: Commit**

```bash
git add src/phases/deploy-dev.ts
git commit -m "feat: phase 7 deploy to dev with health check polling"
```

---

### Task 20: Phase 8 — Smoke + UI Tests

**Files:**
- Create: `src/phases/test.ts`
- Create: `prompts/tester.md`

- [ ] **Step 1: Write tester prompt**

From design doc: runs API smoke tests and Playwright UI tests against dev server. Outputs structured JSON failure report or "TESTS_PASSED".

- [ ] **Step 2: Implement test.ts**

`test(issue, config, store, logger)`:
1. Run `config.testing.unit_test_command` — capture output
2. Run `config.testing.api_test_command` — capture output
3. If `issue.config.hasUi && config.testing.playwright.enabled`:
   Run `config.testing.playwright.command` — capture output
4. If any test fails:
   a. Redirect test output to file: `> state/runs/issue-{N}/test_output.txt 2>&1`
   b. Truncate before injecting into fix prompt: last 100 lines, or grep for ERROR/FAIL/FAILED patterns. Full output saved to file; only relevant excerpt injected into fix session prompt.
   c. Create fix branch: `factory/issue-{N}-fix-{attempt}`
   d. Spawn worker Claude session with truncated failure context
   e. After fix: merge fix to dev, re-deploy, re-test (loop)
   f. Track attempt in `run.fixes[]`
   g. After `max_retries_per_phase`: label `factory-stuck`, throw
5. Save test output to `state/runs/issue-{N}/test_output.txt`

- [ ] **Step 3: Commit**

```bash
git add src/phases/test.ts prompts/tester.md
git commit -m "feat: phase 8 smoke and UI tests with fix loop"
```

---

### Task 21: Phase 9 — Close Issue + Report

**Files:**
- Create: `src/phases/report.ts`
- Create: `prompts/reporter.md`

- [ ] **Step 1: Write reporter prompt**

From design doc: generates report from diff, test results, review logs, traceability. Output format with sections for summary, specs implemented, changes, test results, review summary, run metrics.

- [ ] **Step 2: Implement report.ts**

`closeReport(issue, config, store, logger)`:
1. Assemble reporter context: git diff, test output, review logs, run metrics
2. Run one-shot Claude session (sonnet) with reporter prompt
3. Save report to `state/runs/issue-{N}/report.md`
4. Comment report on GitHub Issue via `gh issue comment`
5. Label issue `factory-complete`
6. Close issue via `gh issue close`
7. Dispatch notifications (via notify module)

- [ ] **Step 3: Commit**

```bash
git add src/phases/report.ts prompts/reporter.md
git commit -m "feat: phase 9 close issue with report generation"
```

---

## Chunk 7: Notifications + Bug Handling

### Task 22: Notification dispatcher

**Files:**
- Create: `src/notify/index.ts`
- Create: `src/notify/markdown.ts`
- Create: `src/notify/slack.ts`
- Create: `src/notify/email.ts` (stub — logs "email notification not yet implemented")

- [ ] **Step 1: Implement notification modules**

`src/notify/index.ts` — `notify(event, config, logger)`: iterates configured channels, dispatches to each.

`src/notify/markdown.ts` — `notifyMarkdown(event, path)`: writes report to `{path}/{date}-issue-{N}.md`. Does NOT stage or commit — notifications must be side-effect free with respect to git state.

`src/notify/slack.ts` — `notifySlack(event, webhookUrl)`: POST JSON payload to Slack webhook using Node `https` module. Format: message with issue link, phase status, summary.

Email (`src/notify/email.ts`) is deferred — add as a stub that logs "email notification not yet implemented".

- [ ] **Step 2: Commit**

```bash
git add src/notify/
git commit -m "feat: notification system with markdown and slack channels"
```

---

### Task 23: Bug diagnosis flow

Note: `diagnose.ts` runs in the cron loop before pipeline dispatch — it is NOT an FSM phase. It lives in `src/phases/` for organizational convenience but could alternatively live in `src/intelligence/`.

**Files:**
- Create: `src/phases/diagnose.ts`
- Create: `prompts/diagnostician.md`

- [ ] **Step 1: Write diagnostician prompt**

From design doc: triages bugs into Type A (implementation bug), Type B (spec gap), Type C (expectation mismatch). Outputs structured JSON with diagnosis, confidence, affected specs/files, suggested action.

- [ ] **Step 2: Implement diagnose.ts**

`diagnose(issue, config, store, logger)`:
1. Identify affected specs via traceability.yml (search for files mentioned in bug report)
2. Assemble diagnostician prompt with bug report, relevant specs, current code
3. Run one-shot Claude session
4. Parse JSON output
5. Based on diagnosis:
   - Type A (confidence >= 0.7): relabel `factory-ready` with `bug-type:impl`, let pipeline handle it
   - Type B: label `needs-spec-update`, comment with diagnosis and suggested spec change
   - Type C: label `needs-human`, comment with diagnosis
   - Low confidence (< 0.7): label `needs-human`, comment with both interpretations

- [ ] **Step 3: Commit**

```bash
git add src/phases/diagnose.ts prompts/diagnostician.md
git commit -m "feat: bug diagnosis with Type A/B/C triage"
```

---

## Chunk 8: CLI + Daemon Lifecycle

### Task 24: CLI entry point

**Files:**
- Create: `src/index.ts`
- Create: `src/cli/init.ts`
- Create: `src/cli/start.ts`
- Create: `src/cli/stop.ts`
- Create: `src/cli/status.ts`
- Create: `src/cli/logs.ts`
- Create: `src/cli/pause-resume.ts`
- Create: `src/cli/retry.ts`
- Create: `src/cli/release.ts`

- [ ] **Step 1: Implement CLI with Commander**

```typescript
// src/index.ts
import { Command } from "commander";

const program = new Command();
program
  .name("auto-claude")
  .description("Autonomous agent orchestrator for spec-driven development")
  .version("0.1.0");

program.command("init")
  .description("Scaffold factory.config.yaml")
  .action(async () => { /* copy example config */ });

program.command("start")
  .description("Start the daemon")
  .option("--daemon", "Run in background")
  .option("--config <path>", "Config file path", "factory.config.yaml")
  .action(async (opts) => { /* start cron loop */ });

program.command("stop")
  .description("Stop the daemon")
  .action(async () => { /* read PID, send SIGTERM */ });

program.command("status")
  .description("Show daemon status")
  .option("--all", "Show all projects")
  .action(async () => { /* read daemon.json, show status */ });

program.command("logs")
  .description("Tail daemon logs")
  .option("--run <n>", "Show logs for specific issue run")
  .action(async () => { /* tail log file */ });

program.command("pause")
  .description("Stop picking up new issues")
  .action(async () => { /* set paused=true in daemon.json */ });

program.command("resume")
  .description("Resume picking up issues")
  .action(async () => { /* set paused=false */ });

program.command("retry <issue>")
  .description("Retry a stuck issue")
  .action(async (issue) => { /* relabel factory-ready */ });

program.command("release")
  .description("Trigger dev→main release PR")
  .action(async () => { /* invoke release phase */ });

program.parse();
```

- [ ] **Step 2: Implement init command**

`src/cli/init.ts`: copies `factory.config.example.yaml` to `factory.config.yaml` in cwd. Prompts for repo name if interactive.

- [ ] **Step 3: Implement start command**

`src/cli/start.ts`:
1. **Preflight checks:**
   - Run `claude --version` — verify Claude CLI is installed (minimum version TBD).
   - Run `gh auth status` — verify GitHub CLI is authenticated.
   - Verify configured repo exists: `gh repo view {config.project.repo}`.
   - Verify dev branch exists: `git rev-parse --verify {config.project.dev_branch}`.
   - Verify clean working tree (warn if dirty, but don't block).
2. **Lock file** (`~/.auto-claude/state/{repo-path-hash}/daemon.lock`):
   - Attempt exclusive create with `fs.writeFileSync(path, pid, { flag: 'wx' })`.
   - If exists: read PID, check liveness via `process.kill(pid, 0)`. If alive, refuse to start. If dead, remove stale lock and proceed.
3. Write `daemon.json` with PID, startedAt, configPath.
4. **Register signal handlers** (SIGTERM, SIGINT, SIGHUP):
   - Set drain mode (stop accepting new issues).
   - Wait for active Claude child processes to complete (up to `safety.shutdown_grace_seconds`).
   - Kill remaining child processes after grace period.
   - Clean up active worktrees via `WorktreeManager`.
   - Flush all `run.json` state files.
   - Remove lock file.
   - Exit cleanly.
5. If `--daemon`: generate launchd plist (macOS) or systemd unit (Linux), load it.
6. If foreground: start the cron loop directly.

Cron loop:
```typescript
async function cronLoop(config: Config) {
  while (true) {
    if (!paused && withinBudget()) {
      const issues = await pollForIssues(config.project.repo, "factory-ready");
      const bugs = await pollForBugs(config.project.repo);
      for (const issue of [...issues, ...bugs]) {
        if (activeRuns < config.safety.max_concurrent_runs) {
          // spawn pipeline in background
        }
      }
    }
    await sleep(config.cron.interval_minutes * 60 * 1000);
  }
}
```

- [ ] **Step 4: Implement stop command**

`src/cli/stop.ts`: reads `daemon.lock` for PID, sends `SIGTERM`. Waits up to 10s for process to exit, then `SIGKILL` if still alive.

- [ ] **Step 5: Implement status command**

`src/cli/status.ts`: reads `daemon.json` and all `run.json` files. Prints formatted status table with daily cost, active runs, and next poll time.

- [ ] **Step 6: Implement logs command**

`src/cli/logs.ts`: tails the structured JSON log file. With `--run N`, filters to entries matching `issue: N`. Formats log entries for human readability.

- [ ] **Step 7: Implement pause/resume commands**

`src/cli/pause-resume.ts`: reads `daemon.json`, sets `paused: true/false`, writes back. The cron loop checks `paused` before polling.

- [ ] **Step 8: Implement retry command**

`src/cli/retry.ts`: takes issue number, verifies it's labeled `factory-stuck`, swaps label to `factory-ready` via `gh issue edit`, resets run state for that issue.

- [ ] **Step 9: Implement release command**

`src/cli/release.ts`: reads all closed issues since last release tag, assembles release notes, spawns reporter Claude session, creates PR dev→main via `gh pr create`.

- [ ] **Step 10: Commit**

```bash
git add src/index.ts src/cli/ bin/
git commit -m "feat: CLI with all commands (init, start, stop, status, logs, pause, resume, retry, release)"
```

---

### Task 25: Process management (launchd/systemd)

**Files:**
- Create: `src/cli/daemon.ts`

- [ ] **Step 1: Implement daemon.ts**

`generateLaunchdPlist(config, binPath)` — returns XML string for `~/Library/LaunchAgents/com.auto-claude.{project}.plist` with KeepAlive, log paths.

`generateSystemdUnit(config, binPath)` — returns INI string for `~/.config/systemd/user/auto-claude-{project}.service` with Restart=always.

`installDaemon(config)` — detects platform (`process.platform`), writes appropriate file, loads it (`launchctl load` or `systemctl --user enable --now`).

`uninstallDaemon(config)` — unloads and removes.

- [ ] **Step 2: Commit**

```bash
git add src/cli/daemon.ts
git commit -m "feat: launchd and systemd daemon management"
```

---

## Chunk 9: Release Phase + Integration

### Task 26: Phase 9 — Release

**Files:**
- Create: `src/phases/release.ts`

- [ ] **Step 1: Implement release.ts**

`release(config, store, logger)`:
1. Find all issues completed since last release tag: `git log main..dev --oneline`
2. If no changes: log "nothing to release", return
3. Determine version bump (read last tag, analyze commit messages for feat/fix)
4. Assemble release notes from completed issue reports
5. Spawn reporter Claude session to format release PR body
6. Create PR: `gh pr create --base main --head dev --title "Release v{X.Y.Z}" --body "..."`
7. Log: "Release PR created. Awaiting human merge."
8. Notify via configured channels

- [ ] **Step 2: Commit**

```bash
git add src/phases/release.ts
git commit -m "feat: phase 9 release PR creation"
```

---

### Task 27: Integration — wire all three layers together

**Files:**
- Modify: `src/orchestration/runner.ts`
- Modify: `src/cli/start.ts`

- [ ] **Step 1: Wire phase modules into FSM pipeline definitions**

Import all phase modules into `pipelines.ts`. Each FSM state's `execute` function calls the corresponding phase module. Wire `onEnter`/`onExit` hooks:
- `onEnter`: log phase start, check `CostTracker.withinBudget()`, check `RateLimitHandler.isCoolingDown()`, inject gotchas via `GotchaStore.match()` + `formatForPrompt()`
- `onExit`: parse session cost via `parseSessionCost()`, call `CostTracker.addCost()`, save checkpoint via `RecoveryManager.saveCheckpoint()`, persist state atomically

- [ ] **Step 2: Wire cron loop into start command**

Connect `pollForIssues` → `parseIssueBody` → classify (for features) → `PipelineRunner.run(issue, variant)` in the cron loop. Add:
- Initialize all infrastructure: `WorkerPool`, `CostTracker`, `RateLimitHandler`, `GotchaStore`
- Initialize orchestration: `RecoveryManager`, `CircularFixDetector`
- Budget tracking: `CostTracker.withinBudget()` before polling, daily reset check each iteration
- Concurrent run limiting via worker pool
- Cooldown between pickups
- Consecutive stuck detection + auto-pause
- Rate limit detection: worker pool relays `session:error` with `isRateLimit: true` to `RateLimitHandler`

- [ ] **Step 3: Add bug handling branch**

In the cron loop, handle `bug` labeled issues: run `diagnose()` first, then either route to `PipelineRunner.run(issue, "bug")` (Type A) or label and notify (Type B/C).

- [ ] **Step 4: Wire gotcha parsing into session completion**

After each Claude session completes, scan output for `GOTCHA: {...}` markers via `GotchaStore.parseFromOutput()`, record any found gotchas.

- [ ] **Step 5: Wire circular fix detection into retry logic**

In the FSM's retry path (inside `runner.ts`), call `CircularFixDetector.recordError()` before retrying. If `"escalate"` is returned, transition to `stuck` immediately.

- [ ] **Step 6: Wire orphan scanning into the cron loop**

Every 5 minutes, check all tracked child PIDs in the worker pool and kill any that aren't associated with an active run. This prevents leaked processes from crashed or abandoned sessions from accumulating.

- [ ] **Step 7: Commit**

```bash
git add src/orchestration/runner.ts src/orchestration/pipelines.ts src/cli/start.ts
git commit -m "feat: wire all three layers — infra, orchestration, intelligence"
```

---

### Task 27b: JSON schemas for structured output

**Files:**
- Create: `schemas/task-graph.json`
- Create: `schemas/complexity-assessment.json`
- Create: `schemas/bug-diagnosis.json`
- Create: `schemas/report.json`

- [ ] **Step 1: Write JSON schemas**

JSON Schema definitions matching the TypeScript types. These are passed to `--json-schema` for CLI-validated output:
- `task-graph.json` — validates `TaskGraph` (issueNumber, featureBranch, units array with id/title/specs/batch/dependsOn/verificationCommand). `verificationCommand` is a required field per unit.
- `complexity-assessment.json` — validates `ComplexityAssessment` (complexity enum, reasoning, estimatedUnits, estimatedFiles)
- `bug-diagnosis.json` — validates diagnosis output (type A/B/C, confidence, affectedSpecs, suggestedAction)
- `report.json` — validates report output (summary, specsImplemented, changes, testResults, metrics)

- [ ] **Step 2: Commit**

```bash
git add schemas/
git commit -m "feat: JSON schemas for structured CLI output"
```

---

### Task 27c: PreToolUse hooks for scenario isolation

**Files:**
- Create: `.claude/hooks.json`
- Create: `scripts/hook-deny-paths.py`

- [ ] **Step 1: Write hooks configuration**

Configure `PreToolUse` hooks that block access to protected paths. Each hook is a shell command that receives tool input as JSON on stdin and returns exit code 2 to block:

```json
{
  "hooks": [
    {
      "type": "preToolUse",
      "event": "Read",
      "command": "python3 scripts/hook-deny-paths.py"
    },
    {
      "type": "preToolUse",
      "event": "Write",
      "command": "python3 scripts/hook-deny-paths.py"
    }
  ]
}
```

The `scripts/hook-deny-paths.py` script reads the tool input from stdin (JSON with `file_path` field), checks against a deny list (`.specify/scenarios/`, `.specify/methodology/`, `state/`, `.factory/`, `.auto-claude/`, `src/` for writes), and exits with code 2 + a reason message to block. Create `scripts/hook-deny-paths.py` as part of this task.

This provides deterministic enforcement at the tool boundary — works in ALL sessions, not just worktrees. Blocked paths:
- Read on `.specify/scenarios/**` — holdout isolation
- Write on `.specify/methodology/**` — methodology is immutable
- Read/Write on `state/**`, `.factory/**`, `.auto-claude/**` — internal state isolation
- Write on `src/**` — daemon source is read-only for workers

- [ ] **Step 2: Commit**

```bash
git add .claude/hooks.json scripts/hook-deny-paths.py
git commit -m "feat: PreToolUse hook blocks scenario file access"
```

---

### Task 27d: Secrets management

**Files:**
- Create: `src/infra/secrets.ts`

- [ ] **Step 1: Implement secrets.ts**

`SecretsManager`:
- `resolve(config)` — on startup, resolve all secrets from env vars and config. Returns in-memory snapshot. Throws if any required secret is missing.
- `reload(config)` — resolve all secrets fresh. If all succeed, atomically swap snapshot. If any fail, keep last-known-good and log warning.
- Required secrets: `GITHUB_TOKEN` (for `gh` CLI), optional: `SLACK_WEBHOOK_URL`, any deploy credentials.
- Never passes secrets to Claude prompts — only used by daemon's deterministic code.

- [ ] **Step 2: Commit**

```bash
git add src/infra/secrets.ts
git commit -m "feat: secrets management with atomic swap"
```

---

### Task 27e: Control plane HTTP interface

**Files:**
- Create: `src/infra/control-plane.ts`

- [ ] **Step 1: Implement control-plane.ts**

Minimal HTTP server (Node built-in `http` module) bound to a local port for instance locking + status:

- Port: `17532 + hash(repoPath) % 1000`
- `GET /status` — returns JSON: active runs, current phases, daily cost, uptime
- `GET /health` — returns 200 (liveness probe for systemd/launchd)
- `POST /pause` — sets paused state
- `POST /resume` — clears paused state
- `GET /logs?issue=N` — streams log entries for a specific run

Port binding IS the instance lock — if port is in use, another daemon owns it, fail fast. OS releases on crash (no stale locks).

- [ ] **Step 2: Commit**

```bash
git add src/infra/control-plane.ts
git commit -m "feat: control plane HTTP interface with port-based locking"
```

### Task 27f: Results ledger

**Files:**
- Create: `src/infra/results-ledger.ts`
- Create: `src/__tests__/results-ledger.test.ts`

- [ ] **Step 1: Write the failing test**

Test that `ResultsLedger.record(result)` appends a line to `~/.auto-claude/state/{project}/results.csv` and that the line matches the expected CSV format. Test: append a result, read back, verify CSV format.

- [ ] **Step 2: Implement results-ledger.ts**

`ResultsLedger` class:
- `record(result)` — appends a CSV line to `~/.auto-claude/state/{project}/results.csv`.
- Columns: `issue_number`, `started_at`, `completed_at`, `pipeline_variant`, `complexity`, `total_cost_usd`, `phases_run`, `fix_attempts`, `holdout_pass`, `outcome`.
- Creates the CSV file with a header row if it does not exist.
- Called by the runner after each issue completes (or gets stuck).

- [ ] **Step 3: Run tests, verify PASS**

- [ ] **Step 4: Commit**

```bash
git add src/infra/results-ledger.ts src/__tests__/results-ledger.test.ts
git commit -m "feat: results ledger with CSV append for run tracking"
```

---

### Task 28: Prompt templates — write all prompts

**Files:**
- Verify/update: `prompts/coordinator.md`
- Verify/update: `prompts/classifier.md` (created in Task 8i)
- Verify/update: `prompts/worker.md`
- Create: `prompts/reviewer-spec-compliance.md`
- Create: `prompts/reviewer-code-quality.md`
- Create: `prompts/reviewer-security.md`
- Create: `prompts/conflict-resolver.md`
- Create: `prompts/bug-worker.md`
- Verify/update: `prompts/tester.md`
- Verify/update: `prompts/diagnostician.md`
- Verify/update: `prompts/reporter.md`
- Create: `prompts/prompt-optimizer.md`

- [ ] **Step 1: Review and finalize all 12 prompt templates**

Ensure each prompt matches the design doc specifications. Use `{{variable}}` syntax for all dynamic values.

**Worker protocol** — `worker.md` MUST describe the TDD protocol: write failing test → verify failure → implement → verify pass → refactor → commit. All spec content is pre-loaded in the prompt — the worker MUST NOT read spec files via Read tool. Must exit with structured status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT.

**Worker exit status** — `worker.md` and `bug-worker.md` MUST exit with one of: `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`. Include instructions for when to use each status.

**Containment rules** — all worker and reviewer prompts MUST include:
- "Never read or access files under `.specify/scenarios/`."
- "Never modify files outside your worktree directory."
- "Never modify files under `src/` of the auto-claude daemon itself."

**Gotcha emission** — `worker.md` and all reviewer prompts MUST include:
- "When you discover a non-obvious pitfall, emit: `GOTCHA: {\"filePaths\": [\"<glob>\"], \"gotcha\": \"<description>\"}`"
- Include `{{known_gotchas}}` placeholder.

**prompt-optimizer.md** — reads current prompt template + accumulated gotchas + error patterns. Outputs proposed revisions with reasoning for each change. Written to `prompts/{name}.md.proposed`.

- [ ] **Step 2: Commit**

```bash
git add prompts/
git commit -m "feat: finalize all 12 prompt templates with exit status protocol"
```

---

### Task 29: Pipeline phase unit tests

**Files:**
- Create: `src/__tests__/runner.test.ts`
- Create: `src/__tests__/decompose.test.ts`
- Create: `src/__tests__/implement.test.ts`
- Create: `src/__tests__/holdout.test.ts`
- Create: `src/__tests__/test-phase.test.ts`

- [ ] **Step 1: Write runner tests**

Test `PipelineRunner`:
- Skips completed phases on resume (create run with detect=completed, verify detect is not re-executed)
- Retries failed phases up to `max_retries_per_phase`
- Labels issue `factory-stuck` after retries exhausted
- Bug pipeline variant skips decompose and holdout phases

- [ ] **Step 2: Write decompose tests**

Test decompose phase:
- Validates task-graph JSON output (mock Claude returning valid JSON)
- Rejects invalid JSON (mock Claude returning garbage)
- Uses `config.project.dev_branch` for feature branch creation (not hardcoded)

- [ ] **Step 3: Write implement tests**

Test implement phase:
- Respects `max_parallel_workers` concurrency limit
- Handles worker timeout (mock a slow process)
- Spawns conflict-resolution on merge conflict
- Runs post-merge verification

- [ ] **Step 4: Write holdout tests**

Test holdout phase:
- Passes on exit code 0
- Labels `needs-spec-update` on non-zero exit code
- Skips gracefully when no scenario runner is configured

- [ ] **Step 5: Write test-phase tests**

Test the test phase (test.ts):
- Creates fix branch on test failure
- Tracks fix attempts in `run.fixes[]`
- Stops after `max_retries_per_phase` fix attempts

- [ ] **Step 6: Run all tests**

Run: `cd $PROJECT_ROOT && npx vitest run src/__tests__/runner.test.ts src/__tests__/decompose.test.ts src/__tests__/implement.test.ts src/__tests__/holdout.test.ts src/__tests__/test-phase.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/__tests__/runner.test.ts src/__tests__/decompose.test.ts src/__tests__/implement.test.ts src/__tests__/holdout.test.ts src/__tests__/test-phase.test.ts
git commit -m "test: pipeline phase unit tests for runner, decompose, implement, holdout, test"
```

---

### Task 30: End-to-end smoke test

**Files:**
- Create: `src/__tests__/e2e.test.ts`

- [ ] **Step 1: Write integration tests**

Test the full pipeline with mocked externals:
- Mock `gh` commands (return sample issue JSON)
- Mock `claude` commands (return sample task-graph JSON, exit 0)
- Use real git operations in a temp repo
- Verify: run state transitions correctly, worktrees created/cleaned, labels swapped

Include BOTH happy path AND failure paths:
- **Happy path:** issue detected → decomposed → implemented → reviewed → PR → complete
- **Retry path:** implement phase fails once, retries successfully
- **Stuck path:** implement phase fails `max_retries_per_phase` times, issue labeled `factory-stuck`
- **Resume path:** create a run with some phases completed, verify runner resumes from correct phase
- **Budget exceeded:** verify cron loop pauses when daily cost exceeds budget

- [ ] **Step 2: Run test**

Run: `cd $PROJECT_ROOT && npx vitest run src/__tests__/e2e.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/e2e.test.ts
git commit -m "test: end-to-end smoke test with mocked externals"
```

---

### Task 31: Documentation + final commit

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

Brief README covering: what Auto-Claude is, prerequisites (node, claude CLI, gh CLI), quick start (`auto-claude init` → edit config → `auto-claude start`), link to design doc.

- [ ] **Step 2: Final commit**

```bash
git add README.md
git commit -m "docs: add README with quick start guide"
```

Note: Do NOT push automatically. The user will push when ready.
