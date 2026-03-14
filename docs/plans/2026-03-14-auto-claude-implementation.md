# Auto-Claude Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript daemon that polls GitHub Issues for spec implementation requests, spawns Claude Code CLI sessions to implement them autonomously, and manages the full pipeline from decomposition through dev deployment and release preparation.

**Architecture:** Thin TypeScript orchestrator (the machine) wrapping Claude Code CLI sessions (the brain). GitHub Issues serve as the work queue. Git worktrees isolate parallel workers. State is JSON files on disk. Pipeline phases run sequentially per issue, with parallelism within the implement phase.

**Tech Stack:** TypeScript (tsx runtime, no build step), Commander.js (CLI), js-yaml (config), Node built-in child_process (spawning claude), Node built-in fs (state). No framework, no database.

**Design Doc:** `docs/specs/2026-03-14-auto-claude-design.md`

---

## Chunk 1: Project Foundation

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore` (update existing)

- [ ] **Step 1: Initialize package.json**

```bash
cd ~/code/auto-claude
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install commander js-yaml
npm install -D typescript @types/node @types/js-yaml tsx vitest
```

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

Add `node_modules/`, `dist/`, `state/`, `.auto-claude/` to existing `.gitignore.

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
#!/usr/bin/env node
import('../src/index.ts')
```

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore bin/
git commit -m "feat: project scaffolding with tsx, commander, vitest"
```

---

### Task 2: Type definitions

**Files:**
- Create: `src/state/types.ts`

- [ ] **Step 1: Write types**

All core types for the system. These are the data structures that flow through the pipeline:

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
  | "decompose"
  | "implement"
  | "review"
  | "holdout"
  | "pr_to_dev"
  | "deploy_dev"
  | "test"
  | "close_report"
  | "release";

// Notification event
export interface NotifyEvent {
  type: "started" | "phase_complete" | "stuck" | "complete" | "budget_exceeded" | "release_ready";
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

- [ ] **Step 2: Commit**

```bash
git add src/state/types.ts
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

Run: `cd ~/code/auto-claude && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write config.ts**

Implement `loadConfig` and `validateConfig`: read YAML file, resolve `${ENV_VAR}` patterns, validate required fields (`project.repo`, `claude.model`, `safety.daily_budget_usd` etc.), return typed config object. Export the `Config` interface.

- [ ] **Step 4: Create factory.config.example.yaml**

Full example config with comments, matching the design doc's Configuration section.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/code/auto-claude && npx vitest run src/__tests__/config.test.ts`
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

Run: `cd ~/code/auto-claude && npx vitest run src/__tests__/state.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement StateStore**

Class with methods: `createRun(issueNumber)`, `loadRun(issueNumber)`, `updatePhase(issueNumber, phase, update)`, `updateUnit(issueNumber, unitId, update)`, `addFix(issueNumber, fix)`, `saveTaskGraph(issueNumber, graph)`, `loadTaskGraph(issueNumber)`. All read/write JSON files under `{stateDir}/runs/issue-{N}/`.

- [ ] **Step 4: Run tests**

Run: `cd ~/code/auto-claude && npx vitest run src/__tests__/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/store.ts src/__tests__/state.test.ts
git commit -m "feat: state store with JSON file persistence"
```

---

### Task 5: Structured logger

**Files:**
- Create: `src/logger.ts`

- [ ] **Step 1: Write logger**

Simple structured JSON logger that writes to stdout and optionally to a file. One JSON object per line. Fields: `ts`, `level`, `phase`, `issue`, `unit`, `msg`, `pid`. No external dependencies — use `console.log` with `JSON.stringify`.

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
      const fs = require("fs");
      fs.appendFileSync(logFile, line + "\n");
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
git add src/logger.ts
git commit -m "feat: structured JSON logger"
```

---

## Chunk 2: Claude Session Management

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

Run: `cd ~/code/auto-claude && npx vitest run src/__tests__/claude-session.test.ts`

- [ ] **Step 3: Implement session.ts**

Two main functions:
- `runOneShot(opts)` — spawns `claude --print --model X -p "prompt"`, captures stdout, returns string output. Timeout via `AbortController`.
- `runAgentic(opts)` — spawns `claude --model X --dangerously-skip-permissions -p "prompt" --max-turns N` in a given cwd. Returns `ChildProcess` handle for the daemon to monitor. Captures output to a log file.

Helper functions: `buildOneShotArgs`, `buildAgenticArgs` for testability.

Both use `child_process.spawn` directly. Handle process exit codes, timeout kills, stderr capture.

- [ ] **Step 4: Run tests**

Run: `cd ~/code/auto-claude && npx vitest run src/__tests__/claude-session.test.ts`
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
    const wtPath = mgr.create("factory/issue-1", "unit-1");
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

All methods use `execSync` for simplicity (these are fast git operations).

- [ ] **Step 4: Run tests, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/claude/worktree.ts src/__tests__/worktree.test.ts
git commit -m "feat: git worktree manager"
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

### Task 12: Pipeline runner (orchestrator)

**Files:**
- Create: `src/pipeline/runner.ts`

- [ ] **Step 1: Implement runner.ts**

The core orchestration loop. `PipelineRunner` class:

```typescript
export class PipelineRunner {
  constructor(
    private config: Config,
    private store: StateStore,
    private logger: Logger,
  ) {}

  async run(issue: IssuePayload): Promise<void> {
    const run = this.store.loadRun(issue.issueNumber);
    const phases: Array<{ name: PhaseName; execute: () => Promise<void> }> = [
      { name: "detect", execute: () => this.detect(issue) },
      { name: "decompose", execute: () => this.decompose(issue) },
      { name: "implement", execute: () => this.implement(issue) },
      { name: "review", execute: () => this.review(issue) },
      { name: "holdout", execute: () => this.holdout(issue) },
      { name: "pr_to_dev", execute: () => this.prToDev(issue) },
      { name: "deploy_dev", execute: () => this.deployDev(issue) },
      { name: "test", execute: () => this.test(issue) },
      { name: "close_report", execute: () => this.closeReport(issue) },
    ];

    for (const phase of phases) {
      if (run.phases[phase.name].status === "completed") continue;
      this.store.updatePhase(issue.issueNumber, phase.name, {
        status: "in_progress",
        startedAt: new Date().toISOString(),
        attempt: (run.phases[phase.name].attempt || 0) + 1,
      });
      try {
        await phase.execute();
        this.store.updatePhase(issue.issueNumber, phase.name, {
          status: "completed",
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        // handle retry or stuck
      }
    }
  }
}
```

Each phase method is a stub that calls into the phase-specific module. The runner handles:
- Resuming from the current phase (skip completed phases)
- Retry logic with `max_retries_per_phase`
- Marking `factory-stuck` after exhaustion
- Logging phase transitions

- [ ] **Step 2: Commit**

```bash
git add src/pipeline/runner.ts
git commit -m "feat: pipeline runner with phase orchestration and resume"
```

---

### Task 13: Phase 1 — Detect

**Files:**
- Create: `src/pipeline/detect.ts`

- [ ] **Step 1: Implement detect.ts**

`detect(issue, config, store, logger)`:
1. Log: "Detected issue #{N}: {title}"
2. Claim the issue (swap labels via claimer)
3. Create run state
4. Save issue body to `state/runs/issue-{N}/issue_body.md`

Thin — most work was done by poller + claimer already.

- [ ] **Step 2: Commit**

```bash
git add src/pipeline/detect.ts
git commit -m "feat: phase 1 detect"
```

---

### Task 14: Phase 2 — Decompose

**Files:**
- Create: `src/pipeline/decompose.ts`
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
6. Create feature branch: `git checkout -b factory/issue-{N}-{slug} dev`

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/decompose.ts prompts/coordinator.md
git commit -m "feat: phase 2 decompose with coordinator prompt"
```

---

### Task 15: Phase 3 — Implement

**Files:**
- Create: `src/pipeline/implement.ts`
- Create: `prompts/worker.md`

- [ ] **Step 1: Write worker prompt**

Full prompt from the design doc. Strict protocol: read specs (L3→L2→L1) → write plan → execute → /deep-review loop → test → commit. Includes max cycle limit and "needs-help" exit condition.

- [ ] **Step 2: Implement implement.ts**

`implement(issue, config, store, logger)`:
1. Load task graph
2. Group units by batch number
3. For each batch (sequential):
   a. For each unit in batch (parallel):
      - Create worktree via WorktreeManager
      - Assemble worker prompt with unit context + spec contents
      - Spawn agentic Claude session in worktree cwd
      - Monitor process (timeout, exit code)
      - Update unit state
   b. Wait for all parallel workers to finish
   c. Merge worktrees into feature branch (`--no-ff`)
   d. If merge conflict: spawn conflict-resolution session
   e. Post-merge verification (run compile/typecheck command if configured)
   f. Clean up worktrees

Uses `Promise.all` for parallel workers within a batch, bounded by `max_parallel_workers`.

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/implement.ts prompts/worker.md
git commit -m "feat: phase 3 implement with parallel worktrees"
```

---

## Chunk 5: Pipeline Phases 4-5

### Task 16: Phase 4 — Review

**Files:**
- Create: `src/pipeline/review.ts`
- Create: `prompts/reviewer.md`

- [ ] **Step 1: Write reviewer prompt**

From design doc: runs /deep-review, focuses on correctness (early rounds), edge cases (mid), polish (late). Outputs "REVIEW_CLEAN" when no issues found.

- [ ] **Step 2: Implement review.ts**

`review(issue, config, store, logger)`:
1. Determine number of rounds (from issue config override or pipeline default)
2. For each round:
   a. Spawn agentic Claude session on feature branch
   b. Prompt includes round number and focus area
   c. Capture output to `state/runs/issue-{N}/reviews/round-{M}.log`
   d. Check output for "REVIEW_CLEAN" — if found, break early
   e. If session made commits, continue to next round
3. After all rounds, run full test suite

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/review.ts prompts/reviewer.md
git commit -m "feat: phase 4 review with N-round deep-review loop"
```

---

### Task 17: Phase 4b — Holdout validation

**Files:**
- Create: `src/pipeline/holdout.ts`

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
git add src/pipeline/holdout.ts
git commit -m "feat: phase 4b holdout validation via shell runner"
```

---

### Task 18: Phase 5 — PR to Dev

**Files:**
- Create: `src/pipeline/pr.ts`

- [ ] **Step 1: Implement pr.ts**

`prToDev(issue, config, store, logger)`:
1. Push feature branch to remote: `git push origin factory/issue-{N}-{slug}`
2. Create PR: `gh pr create --base dev --head factory/issue-{N}-{slug} --title "..." --body "..."`
3. Run one final /deep-review Claude session on the PR diff
4. If clean: auto-merge via `gh pr merge --auto --merge`
5. Save PR number to run state

- [ ] **Step 2: Commit**

```bash
git add src/pipeline/pr.ts
git commit -m "feat: phase 5 PR to dev with auto-merge"
```

---

## Chunk 6: Pipeline Phases 6-8

### Task 19: Phase 6 — Deploy to Dev

**Files:**
- Create: `src/pipeline/deploy-dev.ts`

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
git add src/pipeline/deploy-dev.ts
git commit -m "feat: phase 6 deploy to dev with health check polling"
```

---

### Task 20: Phase 7 — Smoke + UI Tests

**Files:**
- Create: `src/pipeline/test.ts`
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
   a. Create fix branch: `factory/issue-{N}-fix-{attempt}`
   b. Spawn worker Claude session with failure context
   c. After fix: merge fix to dev, re-deploy, re-test (loop)
   d. Track attempt in `run.fixes[]`
   e. After `max_retries_per_phase`: label `factory-stuck`, throw
5. Save test output to `state/runs/issue-{N}/test_output.txt`

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/test.ts prompts/tester.md
git commit -m "feat: phase 7 smoke and UI tests with fix loop"
```

---

### Task 21: Phase 8 — Close Issue + Report

**Files:**
- Create: `src/pipeline/report.ts`
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
git add src/pipeline/report.ts prompts/reporter.md
git commit -m "feat: phase 8 close issue with report generation"
```

---

## Chunk 7: Notifications + Bug Handling

### Task 22: Notification dispatcher

**Files:**
- Create: `src/notify/index.ts`
- Create: `src/notify/markdown.ts`
- Create: `src/notify/slack.ts`

- [ ] **Step 1: Implement notification modules**

`src/notify/index.ts` — `notify(event, config, logger)`: iterates configured channels, dispatches to each.

`src/notify/markdown.ts` — `notifyMarkdown(event, path)`: writes report to `{path}/{date}-issue-{N}.md`, stages and commits it.

`src/notify/slack.ts` — `notifySlack(event, webhookUrl)`: POST JSON payload to Slack webhook using Node `https` module. Format: message with issue link, phase status, summary.

Email (`src/notify/email.ts`) is deferred — add as a stub that logs "email notification not yet implemented".

- [ ] **Step 2: Commit**

```bash
git add src/notify/
git commit -m "feat: notification system with markdown and slack channels"
```

---

### Task 23: Bug diagnosis flow

**Files:**
- Create: `src/pipeline/diagnose.ts`
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
git add src/pipeline/diagnose.ts prompts/diagnostician.md
git commit -m "feat: bug diagnosis with Type A/B/C triage"
```

---

## Chunk 8: CLI + Daemon Lifecycle

### Task 24: CLI entry point

**Files:**
- Create: `src/index.ts`
- Create: `src/cli/init.ts`
- Create: `src/cli/start.ts`
- Create: `src/cli/status.ts`
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
1. Load config
2. Write PID lock file (`~/.auto-claude/state/{project}/daemon.lock`). Check for existing lock — if PID is alive, refuse to start.
3. Write `daemon.json` with PID, startedAt, configPath.
4. If `--daemon`: generate launchd plist (macOS) or systemd unit (Linux), load it.
5. If foreground: start the cron loop directly.

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

- [ ] **Step 4: Implement status command**

`src/cli/status.ts`: reads `daemon.json` and all `run.json` files. Prints formatted status table.

- [ ] **Step 5: Implement release command**

`src/cli/release.ts`: reads all closed issues since last release tag, assembles release notes, spawns reporter Claude session, creates PR dev→main via `gh pr create`.

- [ ] **Step 6: Commit**

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
- Create: `src/pipeline/release.ts`

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
git add src/pipeline/release.ts
git commit -m "feat: phase 9 release PR creation"
```

---

### Task 27: Integration — wire everything together

**Files:**
- Modify: `src/pipeline/runner.ts`
- Modify: `src/cli/start.ts`

- [ ] **Step 1: Wire pipeline phases into runner**

Import all phase modules into `runner.ts`. Each phase method calls the corresponding module function with the right arguments.

- [ ] **Step 2: Wire cron loop into start command**

Connect `pollForIssues` → `parseIssueBody` → `PipelineRunner.run()` in the cron loop. Add:
- Budget tracking (sum `totalTokenCostUsd` across active runs)
- Concurrent run limiting
- Cooldown between pickups
- Consecutive stuck detection + auto-pause

- [ ] **Step 3: Add bug handling branch**

In the cron loop, handle `bug` labeled issues: run `diagnose()` first, then either route to pipeline (Type A) or label and notify (Type B/C).

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/runner.ts src/cli/start.ts
git commit -m "feat: wire all pipeline phases and cron loop together"
```

---

### Task 28: Prompt templates — write all remaining prompts

**Files:**
- Verify/update: `prompts/coordinator.md`
- Verify/update: `prompts/worker.md`
- Verify/update: `prompts/reviewer.md`
- Verify/update: `prompts/tester.md`
- Verify/update: `prompts/diagnostician.md`
- Verify/update: `prompts/reporter.md`

- [ ] **Step 1: Review and finalize all 6 prompt templates**

Ensure each prompt matches the design doc specifications. Use `{{variable}}` syntax for all dynamic values. Each prompt should be self-contained and follow the exact protocol described in the design.

- [ ] **Step 2: Commit**

```bash
git add prompts/
git commit -m "feat: finalize all 6 prompt templates"
```

---

### Task 29: End-to-end smoke test

**Files:**
- Create: `src/__tests__/e2e.test.ts`

- [ ] **Step 1: Write integration test**

Test the full pipeline with mocked externals:
- Mock `gh` commands (return sample issue JSON)
- Mock `claude` commands (return sample task-graph JSON, exit 0)
- Use real git operations in a temp repo
- Verify: run state transitions correctly, worktrees created/cleaned, labels swapped

This is a "happy path" test — no failures, no retries.

- [ ] **Step 2: Run test**

Run: `cd ~/code/auto-claude && npx vitest run src/__tests__/e2e.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/e2e.test.ts
git commit -m "test: end-to-end smoke test with mocked externals"
```

---

### Task 30: Documentation + final commit

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

Brief README covering: what Auto-Claude is, prerequisites (node, claude CLI, gh CLI), quick start (`auto-claude init` → edit config → `auto-claude start`), link to design doc.

- [ ] **Step 2: Final commit and push**

```bash
git add README.md
git commit -m "docs: add README with quick start guide"
git push origin main
```
