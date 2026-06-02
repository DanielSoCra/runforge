> **🗄 HISTORICAL (2026-06-02).** Completed/superseded record, kept for provenance — superseded by the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. The canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Auto-Claude Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an agent harness daemon that polls GitHub Issues for spec-driven work requests, spawns Claude Code sessions to implement them autonomously, reviews through independent quality gates, and deploys to a dev environment.

**Architecture:** Six services behind a single daemon process. Control Plane drives an FSM pipeline. Session Runtime abstracts CLI/SDK execution. Implementation Coordinator decomposes work into parallel units. Validation Service runs heterogeneous review gates. Bug Diagnosis classifies bugs by root cause. Knowledge Service captures and injects institutional knowledge. JSON files for persistence, git worktrees for isolation, Docker containers on Hetzner for environments.

**Tech Stack:** TypeScript (tsx, no build), Vitest, pnpm, Octokit, Commander.js, Zod, minimatch. No framework, no database, no worker_threads.

**Specs:** `.specify/L0-vision.md` (vision), `.specify/functional/` (6 L1), `.specify/architecture/` (6 L2), `.specify/stack/` (7 L3)

**MVP Scope:** Single issue, single unit (no decomposition), CLI adapter only, gate 1 only (deterministic checks), local git worktrees (no Docker), basic reporting. Post-MVP adds: parallel batches, full review gates, bug diagnosis, knowledge service, holdout, warmup/sampling, Docker, SDK adapter.

---

## Chunk 1: Project Setup + Foundation

### Task 1: Initialize project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.prettierrc`
- Create: `eslint.config.js`

- [ ] **Step 1: Initialize pnpm project**

```bash
pnpm init
```

- [ ] **Step 2: Install dependencies**

```bash
pnpm add zod minimatch @octokit/rest commander zod-to-json-schema
pnpm add -D typescript tsx vitest eslint prettier @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-plugin-complexity
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, root: 'src' },
});
```

- [ ] **Step 5: Create .gitignore, .prettierrc, eslint config**

Add `node_modules/`, `dist/`, `state/`, `*.tmp`, `.env*` to `.gitignore`.
Add `state/` directory creation to startup.

- [ ] **Step 6: Add scripts to package.json**

```json
{
  "scripts": {
    "start": "tsx src/main.ts start",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit",
    "format": "prettier --check src/"
  },
  "bin": { "auto-claude": "./node_modules/.bin/tsx src/main.ts" }
}
```

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .prettierrc eslint.config.js
git commit -m "chore: initialize project with tsx, vitest, pnpm"
```

---

### Task 2: Result type + helpers

**Files:**
- Create: `src/lib/result.ts`
- Create: `src/lib/result.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/lib/result.test.ts
import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, unwrap } from './result';

describe('Result', () => {
  it('ok wraps a value', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(unwrap(r)).toBe(42);
  });

  it('err wraps an error', () => {
    const r = err(new Error('fail'));
    expect(isErr(r)).toBe(true);
    expect(() => unwrap(r)).toThrow('fail');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/result.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/lib/result.ts
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw r.error instanceof Error ? r.error : new Error(String(r.error));
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/result.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/result.ts src/lib/result.test.ts
git commit -m "feat: add Result type and helpers"
```

---

### Task 3: JSON persistence (atomic writes + JSONL)

**Files:**
- Create: `src/lib/json-store.ts`
- Create: `src/lib/json-store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/json-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeJsonSafe, readJsonSafe, appendJsonl, readJsonl, writeTextSafe } from './json-store';

describe('json-store', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'json-store-')); });

  it('writeJsonSafe + readJsonSafe roundtrip', async () => {
    const path = join(dir, 'data.json');
    await writeJsonSafe(path, { a: 1 });
    const result = await readJsonSafe<{ a: number }>(path);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('readJsonSafe returns err for missing file', async () => {
    const result = await readJsonSafe(join(dir, 'nope.json'));
    expect(result.ok).toBe(false);
  });

  it('appendJsonl + readJsonl roundtrip', async () => {
    const path = join(dir, 'log.jsonl');
    await appendJsonl(path, { id: 1 });
    await appendJsonl(path, { id: 2 });
    const entries = await readJsonl<{ id: number }>(path);
    expect(entries).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('readJsonl skips malformed lines', async () => {
    const path = join(dir, 'bad.jsonl');
    await writeTextSafe(path, '{"id":1}\nBAD LINE\n{"id":2}\n');
    const entries = await readJsonl<{ id: number }>(path);
    expect(entries).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/json-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/lib/json-store.ts
import { writeFile, rename, readFile, appendFile } from 'fs/promises';
import { ok, err, Result } from './result';

export async function writeJsonSafe<T>(path: string, data: T): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

export async function writeTextSafe(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

export async function readJsonSafe<T>(path: string): Promise<Result<T>> {
  try {
    const raw = await readFile(path, 'utf-8');
    return ok(JSON.parse(raw) as T);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

export async function appendJsonl<T>(path: string, entry: T): Promise<void> {
  await appendFile(path, JSON.stringify(entry) + '\n');
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, 'utf-8');
    return raw.split('\n')
      .filter(line => line.trim())
      .flatMap(line => {
        try { return [JSON.parse(line) as T]; }
        catch { return []; }
      });
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/json-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/json-store.ts src/lib/json-store.test.ts
git commit -m "feat: add atomic JSON/JSONL persistence"
```

---

### Task 4: Git CLI wrapper

**Files:**
- Create: `src/lib/git.ts`
- Create: `src/lib/git.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/git.test.ts
import { describe, it, expect } from 'vitest';
import { git } from './git';

describe('git', () => {
  it('runs git status successfully', async () => {
    const result = await git(['status', '--short']);
    expect(result.ok).toBe(true);
  });

  it('returns err for invalid git command', async () => {
    const result = await git(['not-a-command']);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/git.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/lib/git.ts
import { spawn } from 'child_process';
import { ok, err, Result } from './result';

export async function git(args: string[], cwd?: string): Promise<Result<string>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const proc = spawn('git', args, { cwd });
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString();
      const stderr = Buffer.concat(errChunks).toString();
      if (code === 0) resolve(ok(stdout.trim()));
      else resolve(err(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`)));
    });
    proc.on('error', (e) => resolve(err(e)));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/git.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/git.ts src/lib/git.test.ts
git commit -m "feat: add git CLI wrapper with Result type"
```

---

### Task 5: Process helpers (spawn with timeout)

**Files:**
- Create: `src/lib/process.ts`
- Create: `src/lib/process.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/process.test.ts
import { describe, it, expect } from 'vitest';
import { runCommand } from './process';

describe('runCommand', () => {
  it('runs a command and captures stdout', async () => {
    const result = await runCommand('echo', ['hello']);
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  it('returns err on non-zero exit', async () => {
    const result = await runCommand('false', []);
    expect(result.ok).toBe(false);
  });

  it('times out long-running commands', async () => {
    const result = await runCommand('sleep', ['10'], { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('timeout');
  });
});
```

- [ ] **Step 2: Run, verify fail, implement, verify pass**

Implementation wraps `child_process.spawn` with an `AbortController.timeout()`, collects stdout/stderr, returns `Result<string>`. Uses explicit `env` parameter (never inherits `process.env` by default).

- [ ] **Step 3: Commit**

```bash
git add src/lib/process.ts src/lib/process.test.ts
git commit -m "feat: add process runner with timeout and safe env"
```

---

### Task 6: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Define core types from L2 data models**

```typescript
// src/types.ts — all shared type definitions
// Derived from ARCH-AC-CONTROL-PLANE, ARCH-AC-SESSION-RUNTIME, etc.

export type Phase = 'detect' | 'classify' | 'decompose' | 'implement' | 'review'
  | 'holdout' | 'integrate' | 'deploy' | 'test' | 'report' | 'stuck' | 'paused';

export type PipelineVariant = 'feature' | 'feature-simple' | 'bug';

export type ExitStatus = 'completed' | 'completed-with-concerns'
  | 'blocked' | 'needs-context' | 'failed' | 'timed-out';

export type BugType = 'A' | 'B' | 'C';

export type SessionType = 'coordinator' | 'classifier' | 'worker' | 'reviewer-spec'
  | 'reviewer-quality' | 'reviewer-security' | 'conflict-resolver'
  | 'bug-worker' | 'tester' | 'diagnostician' | 'reporter' | 'prompt-optimizer';

export interface RunState {
  issueNumber: number;
  phase: Phase;
  variant: PipelineVariant;
  phaseCompletions: Record<string, boolean>;
  checkpoints: { phase: string; position: unknown }[];
  cost: number;
  perRunBudget: number;
  fixAttempts: { phase: string; attempt: number; errorHash: string }[];
  errorHashes: Record<string, number>;
  startedAt: string;
  updatedAt: string;
}

export interface DaemonState {
  pid: number;
  uptimeStart: string;
  dailyCost: number;
  dailyResetAt: string;
  paused: boolean;
  consecutiveStuckCount: number;
  configPath: string;
  maxConcurrentRuns: number;
}

export interface SessionResult {
  output: string;
  structuredData: unknown;
  cost: number;
  pitfallMarkers: PitfallMarker[];
  exitStatus: ExitStatus;
}

export interface PitfallMarker {
  artifactPatterns: string[];
  description: string;
}

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  modelOverride?: string;
  maxTurns: number;
  timeoutMs: number;
  budgetCap: number;
}

export interface WorkRequest {
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  specRefs: string[];
}

// ... additional types added as needed per service
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared type definitions from L2 data models"
```

---

### Task 7: Configuration loading

**Files:**
- Create: `src/config.ts`
- Create: `src/config.test.ts`
- Create: `auto-claude.config.example.json`

- [ ] **Step 1: Write failing test**

Test that `loadConfig()` reads a JSON config file, validates required fields with Zod, and returns a typed config object.

- [ ] **Step 2: Implement with Zod schema validation**

Config schema includes: `repo` (owner/name), `controlPort`, `pollIntervalMs`, `maxConcurrentRuns`, `dailyBudget`, `perRunBudget`, `adapter` ('cli' | 'sdk'), `staging/production branch names`, `webhook URLs`, `validation commands`, `holdout command` (optional).

- [ ] **Step 3: Run test, verify pass, commit**

```bash
git add src/config.ts src/config.test.ts auto-claude.config.example.json
git commit -m "feat: add configuration loading with Zod validation"
```

---

## Chunk 2: Session Runtime (CLI Adapter)

### Task 8: CLI Adapter — spawn session

**Files:**
- Create: `src/session-runtime/adapters/cli.ts`
- Create: `src/session-runtime/adapters/cli.test.ts`
- Create: `src/session-runtime/types.ts`

- [ ] **Step 1: Write failing test**

Test that `CliAdapter.spawn()` constructs the correct `claude` command with safe env, parses JSON stdout, and returns a `SessionResult`. Use a mock by replacing the `claude` binary path with a test script that echoes JSON.

- [ ] **Step 2: Implement CliAdapter**

Key implementation points:
- Construct `safeEnv = { PATH, HOME, TERM: 'dumb' }` — never inherit `process.env`
- Build args: `-p`, `--output-format json`, `--max-turns`, `--allowedTools`, optionally `--json-schema`
- Spawn with `child_process.spawn`, collect stdout/stderr separately
- Parse JSON from stdout, extract cost from metadata
- Handle timeout via `AbortController`
- Return `SessionResult`

- [ ] **Step 3: Run test, verify pass, commit**

```bash
git add src/session-runtime/adapters/cli.ts src/session-runtime/adapters/cli.test.ts src/session-runtime/types.ts
git commit -m "feat: add CLI adapter for session execution"
```

---

### Task 9: Provider Adapter interface + factory

**Files:**
- Create: `src/session-runtime/adapters/index.ts`
- Create: `src/session-runtime/adapters/index.test.ts`

- [ ] **Step 1: Define ProviderAdapter interface, factory that returns CliAdapter based on config**

- [ ] **Step 2: Test factory returns correct adapter type**

- [ ] **Step 3: Commit**

```bash
git add src/session-runtime/adapters/index.ts src/session-runtime/adapters/index.test.ts
git commit -m "feat: add provider adapter interface and factory"
```

---

### Task 10: Cost tracking

**Files:**
- Create: `src/session-runtime/cost.ts`
- Create: `src/session-runtime/cost.test.ts`

- [ ] **Step 1: Write failing tests**

Test `CostTracker`: daily total tracking, budget exceeded detection, per-session cost recording, daily reset when window expires.

- [ ] **Step 2: Implement CostTracker**

Holds daily total, per-run costs, reset timestamp. `checkBudget()` returns `{ available: true }` or `{ available: false, reason }`. `recordCost()` adds to daily and per-run totals.

- [ ] **Step 3: Commit**

```bash
git add src/session-runtime/cost.ts src/session-runtime/cost.test.ts
git commit -m "feat: add cost tracker with daily budget enforcement"
```

---

### Task 11: Session Runtime — spawn orchestration

**Files:**
- Create: `src/session-runtime/runtime.ts`
- Create: `src/session-runtime/runtime.test.ts`

- [ ] **Step 1: Write failing tests**

Test `SessionRuntime.spawnSession()`: checks budget before spawning, applies stagger delay, delegates to adapter, records cost, extracts pitfall markers, returns `SessionResult`. Test budget rejection path.

- [ ] **Step 2: Implement the spawn flow**

Steps 1-10 from ARCH-AC-SESSION-RUNTIME spawn operation, minus workspace allocation (MVP uses local worktrees) and containment hooks (added in later task).

- [ ] **Step 3: Commit**

```bash
git add src/session-runtime/runtime.ts src/session-runtime/runtime.test.ts
git commit -m "feat: add session runtime with spawn orchestration"
```

---

## Chunk 3: Control Plane MVP

### Task 12: FSM engine

**Files:**
- Create: `src/control-plane/fsm.ts`
- Create: `src/control-plane/fsm.test.ts`

- [ ] **Step 1: Write failing tests**

Test transition table: `classify → success → decompose`, `classify → success:simple → implement`, `implement → failure → implement (retry)`, `implement → failure (max retries) → stuck`, `* → budget-exceeded → paused`.

- [ ] **Step 2: Implement FSM**

```typescript
// Plain transition table — no library
export type TransitionTable = Record<Phase, Record<string, { next: Phase; action: string }>>;

export function transition(table: TransitionTable, current: Phase, event: string):
  { next: Phase; action: string } | undefined {
  return table[current]?.[event];
}
```

Define three built-in pipeline variants as transition tables: `feature`, `feature-simple`, `bug`.

- [ ] **Step 3: Commit**

```bash
git add src/control-plane/fsm.ts src/control-plane/fsm.test.ts
git commit -m "feat: add FSM engine with three pipeline variants"
```

---

### Task 13: Work detection + GitHub polling

**Files:**
- Create: `src/control-plane/work-detection.ts`
- Create: `src/control-plane/work-detection.test.ts`

- [ ] **Step 1: Write failing tests**

Test `detectWork()`: finds issues with "ready" label, parses work request body, extracts spec refs. Test `claimWork()`: swaps label to "in-progress". Mock Octokit.

- [ ] **Step 2: Implement with Octokit**

- [ ] **Step 3: Commit**

```bash
git add src/control-plane/work-detection.ts src/control-plane/work-detection.test.ts
git commit -m "feat: add work detection via GitHub Issues polling"
```

---

### Task 14: State persistence + crash recovery

**Files:**
- Create: `src/control-plane/state.ts`
- Create: `src/control-plane/state.test.ts`

- [ ] **Step 1: Write failing tests**

Test: save RunState, load RunState, scan for incomplete runs on startup, clean up `.tmp` files.

- [ ] **Step 2: Implement using writeJsonSafe/readJsonSafe**

- [ ] **Step 3: Commit**

```bash
git add src/control-plane/state.ts src/control-plane/state.test.ts
git commit -m "feat: add state persistence with crash recovery"
```

---

### Task 15: HTTP control server + instance lock

**Files:**
- Create: `src/control-plane/server.ts`
- Create: `src/control-plane/server.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `/health` returns 200, `/status` returns daemon state, `/pause` sets flag, instance lock rejects second bind.

- [ ] **Step 2: Implement with Node.js `http` module, bind to 127.0.0.1**

- [ ] **Step 3: Commit**

```bash
git add src/control-plane/server.ts src/control-plane/server.test.ts
git commit -m "feat: add HTTP control server with instance lock"
```

---

### Task 16: Commander.js CLI

**Files:**
- Create: `src/main.ts`
- Create: `src/control-plane/cli.ts`

- [ ] **Step 1: Implement CLI commands**

`auto-claude start` — launches daemon. `auto-claude status/pause/resume/retry/logs` — HTTP calls to control server.

- [ ] **Step 2: Wire main.ts as entry point**

- [ ] **Step 3: Commit**

```bash
git add src/main.ts src/control-plane/cli.ts
git commit -m "feat: add Commander.js CLI with operator commands"
```

---

### Task 17: Pipeline runner (phase execution loop)

**Files:**
- Create: `src/control-plane/pipeline.ts`
- Create: `src/control-plane/pipeline.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `runPipeline()` drives FSM through phases, calls phase handlers, saves state after each phase, handles stuck transition, handles pause/resume.

- [ ] **Step 2: Implement pipeline runner**

Loop: onEnter (check budget, check rate limit) → execute (delegate to service) → onExit (record cost, save checkpoint) → transition. Phase handlers are stub functions for now — wired to real services in Chunk 6.

- [ ] **Step 3: Commit**

```bash
git add src/control-plane/pipeline.ts src/control-plane/pipeline.test.ts
git commit -m "feat: add pipeline runner with phase execution loop"
```

---

## Chunk 4: Single-Unit Implementation

### Task 18: Git worktree management

**Files:**
- Create: `src/implementation/worktree.ts`
- Create: `src/implementation/worktree.test.ts`

- [ ] **Step 1: Write failing tests**

Test: create worktree from branch, check it exists, list files, remove worktree. Test cleanup on failure.

- [ ] **Step 2: Implement using git() wrapper**

`createWorktree(unitId, baseBranch)` → `git worktree add workspaces/{unitId} -b unit/{unitId} {baseBranch}`
`removeWorktree(unitId)` → `git worktree remove workspaces/{unitId} --force`

- [ ] **Step 3: Commit**

```bash
git add src/implementation/worktree.ts src/implementation/worktree.test.ts
git commit -m "feat: add git worktree management for unit isolation"
```

---

### Task 19: Single-unit implementation coordinator

**Files:**
- Create: `src/implementation/coordinator.ts`
- Create: `src/implementation/coordinator.test.ts`

- [ ] **Step 1: Write failing tests**

Test `implement()`: creates worktree, spawns worker session via Session Runtime, merges result into feature branch, cleans up worktree. Test the simple path (no decomposition — single-unit task graph).

- [ ] **Step 2: Implement**

For MVP: skip decomposition entirely. Create a single-unit task graph. Spawn one worker session. Merge with `git merge --no-ff`. Measure diff size (warn if over threshold but don't block in MVP).

- [ ] **Step 3: Commit**

```bash
git add src/implementation/coordinator.ts src/implementation/coordinator.test.ts
git commit -m "feat: add single-unit implementation coordinator"
```

---

### Task 20: Merge + diff size measurement

**Files:**
- Create: `src/implementation/merge.ts`
- Create: `src/implementation/merge.test.ts`

- [ ] **Step 1: Write failing tests**

Test: merge unit branch into feature branch with `--no-ff`, measure diff size via `git diff --stat`, detect merge conflicts.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Commit**

```bash
git add src/implementation/merge.ts src/implementation/merge.test.ts
git commit -m "feat: add merge operations with diff size measurement"
```

---

## Chunk 5: Validation MVP + Reporting

### Task 21: Gate 1 — deterministic checks

**Files:**
- Create: `src/validation/gates.ts`
- Create: `src/validation/gates.test.ts`

- [ ] **Step 1: Write failing tests**

Test `runGate1()`: runs configured commands sequentially, returns pass/fail with captured output. Test failure on non-zero exit.

- [ ] **Step 2: Implement**

Run each command in `config.validation.gate1Commands` (default: `['vitest run', 'eslint --max-warnings 0 src/', 'tsc --noEmit', 'prettier --check src/']`) via `runCommand()`. First failure stops the chain.

- [ ] **Step 3: Commit**

```bash
git add src/validation/gates.ts src/validation/gates.test.ts
git commit -m "feat: add gate 1 deterministic checks"
```

---

### Task 22: Gate chain + fix cycle skeleton

**Files:**
- Create: `src/validation/review.ts`
- Create: `src/validation/review.test.ts`

- [ ] **Step 1: Write failing tests**

Test `runReview()`: executes gate chain, on failure returns findings. For MVP, only gate 1 is active. Test max fix cycles escalation.

- [ ] **Step 2: Implement gate chain loop**

```typescript
async function runReview(branch: string, config: ReviewConfig): Promise<ReviewResult> {
  for (let cycle = 0; cycle < config.maxFixCycles; cycle++) {
    const result = await runGates(config.gates, branch);
    if (result.passed) return { passed: true, fixCycles: cycle };
    // In MVP: escalate on first failure (no fix cycle yet)
    return { passed: false, findings: result.findings };
  }
  return { passed: false, escalated: true };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/validation/review.ts src/validation/review.test.ts
git commit -m "feat: add gate chain with fix cycle skeleton"
```

---

### Task 23: Reporter — issue comment

**Files:**
- Create: `src/control-plane/reporter.ts`
- Create: `src/control-plane/reporter.test.ts`

- [ ] **Step 1: Write failing tests**

Test `postReport()`: posts a markdown comment on the GitHub issue with: summary, phases completed, cost, fix attempts, outcome. Mock Octokit.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Commit**

```bash
git add src/control-plane/reporter.ts src/control-plane/reporter.test.ts
git commit -m "feat: add reporter for issue comments"
```

---

### Task 24: Notification webhooks

**Files:**
- Create: `src/control-plane/notify.ts`
- Create: `src/control-plane/notify.test.ts`

- [ ] **Step 1: Write failing tests**

Test `notify()`: POSTs JSON to configured URLs, retries once on failure, doesn't throw on second failure.

- [ ] **Step 2: Implement with fetch() + 10s timeout + 1 retry**

- [ ] **Step 3: Commit**

```bash
git add src/control-plane/notify.ts src/control-plane/notify.test.ts
git commit -m "feat: add webhook notification with retry"
```

---

## Chunk 6: End-to-End MVP Wiring

### Task 25: Wire phase handlers to real services

**Files:**
- Modify: `src/control-plane/pipeline.ts`
- Create: `src/control-plane/phases.ts`

- [ ] **Step 1: Implement phase handlers**

Map phase names to service calls:
- `detect` → already handled by polling
- `classify` → for MVP, always return `simple` (skip classification)
- `implement` → call `coordinator.implement()`
- `review` → call `validation.runReview()`
- `integrate` → for MVP, create PR via Octokit (no integration lock yet)
- `deploy` → for MVP, skip (log warning)
- `test` → for MVP, skip (log warning)
- `report` → call `reporter.postReport()` + `notify()`

- [ ] **Step 2: Wire into pipeline runner**

- [ ] **Step 3: Commit**

```bash
git add src/control-plane/phases.ts src/control-plane/pipeline.ts
git commit -m "feat: wire phase handlers for MVP pipeline"
```

---

### Task 26: Daemon startup + shutdown

**Files:**
- Modify: `src/main.ts`
- Create: `src/control-plane/daemon.ts`

- [ ] **Step 1: Implement daemon lifecycle**

Startup: load config → initialize state dir → start cost tracker → create session runtime → start HTTP server → start polling loop.
Shutdown: `SIGTERM`/`SIGINT` → stop polling → wait for active runs → flush state → close server.

- [ ] **Step 2: Integration test: start daemon, verify health endpoint, stop gracefully**

- [ ] **Step 3: Commit**

```bash
git add src/main.ts src/control-plane/daemon.ts
git commit -m "feat: wire daemon startup and graceful shutdown"
```

---

### Task 27: Results ledger

**Files:**
- Create: `src/control-plane/results.ts`
- Create: `src/control-plane/results.test.ts`

- [ ] **Step 1: Implement results ledger**

Append a `ResultsRecord` to `state/results.jsonl` on pipeline completion. Fields: issue number, timestamps, variant, cost, phases, outcome.

- [ ] **Step 2: Test + commit**

```bash
git add src/control-plane/results.ts src/control-plane/results.test.ts
git commit -m "feat: add results ledger (append-only JSONL)"
```

---

### Task 28: End-to-end smoke test

**Files:**
- Create: `src/e2e/mvp.test.ts`

- [ ] **Step 1: Write integration test**

Create a test repo, create an issue with "ready" label, start the daemon, verify it claims the issue, runs the pipeline (with a mock session runtime that returns canned output), posts a report, and closes the issue. This tests the full MVP flow without actually calling Claude.

- [ ] **Step 2: Commit**

```bash
git add src/e2e/mvp.test.ts
git commit -m "test: add end-to-end MVP smoke test"
```

**🎉 MVP MILESTONE: The daemon can pick up an issue, implement it (single unit), run deterministic checks, post a report, and close the issue.**

---

## Chunk 7: Parallel Batches + Decomposition

### Task 29: Task graph data structure
- Create `src/implementation/task-graph.ts` + tests
- Validate: unique unit IDs, sequential batches, valid dependencies, no same-batch dependencies

### Task 30: Decomposition via coordinator session
- Create `src/implementation/decompose.ts` + tests
- Spawn one-shot coordinator session, parse structured TaskGraph output, validate against schema

### Task 31: Batch executor with Promise.allSettled
- Create `src/implementation/batch.ts` + tests
- Execute units concurrently within a batch, stagger delay, collect results
- Route exit statuses: completed → merge, blocked → escalate, needs-context → retry with parent layer

### Task 32: Sequential merge after batch
- Extend `src/implementation/merge.ts`
- Merge units sequentially into feature branch
- Diff size check: reject and re-decompose oversized units

### Task 33: Conflict resolution session
- Create `src/implementation/conflict-resolver.ts` + tests
- Spawn conflict resolver session with both diffs + spec content

### Task 34: Checkpoint persistence per batch
- Extend `src/implementation/coordinator.ts`
- Save batch number + completed units to RunState after each batch
- On crash recovery: skip completed batches, re-run incomplete units

---

## Chunk 8: Full Review Gates

### Task 35: Reviewer session with Zod schema
- Create `src/validation/reviewer-session.ts` + tests
- Define ReviewFindings Zod schema, spawn reviewer session via Session Runtime with `--json-schema`

### Task 36: Gate 2 — spec compliance
- Extend `src/validation/gates.ts`
- Spawn reviewer with spec content + implementation diff + rubric

### Task 37: Gate 3 — quality review
- Extend `src/validation/gates.ts`
- Quality rubric: maintainability, pattern consistency, test quality, convention alignment

### Task 38: Gate 4 — security review
- Extend `src/validation/gates.ts`
- Security rubric: injection, auth, data validation, concurrency

### Task 39: Risk detection (3-signal check)
- Create `src/validation/risk-detection.ts` + tests
- Label check (Octokit), keyword regex on spec content, minimatch on artifact paths

### Task 40: Gate sequence selection
- Extend `src/validation/review.ts`
- simple → gates 1-2, standard → 1-3, complex → 1-4, risk override → include gate 4

### Task 41: Fix cycle (gate failure → fix → re-review)
- Extend `src/validation/review.ts`
- On gate failure: delegate fix to Implementation Coordinator, re-run all gates from gate 1
- Circular fix detection: check error hashes, escalate at 3+

---

## Chunk 9: Bug Diagnosis Service

### Task 42: BugDiagnosis Zod schema
- Create `src/diagnosis/schema.ts` + tests
- Zod schema with `.refine()` for at least one affected spec/artifact

### Task 43: Diagnostician session
- Create `src/diagnosis/diagnostician.ts` + tests
- One-shot session with structured output, retry once on invalid output

### Task 44: Routing logic (Type A/B/C)
- Create `src/diagnosis/router.ts` + tests
- Type A + above threshold → bug pipeline, Type B → needs-spec-update, Type C or low → needs-human

### Task 45: Bug pipeline variant integration
- Extend `src/control-plane/fsm.ts` + `src/control-plane/phases.ts`
- Wire bug detection → diagnosis → routing → bug pipeline FSM

---

## Chunk 10: Knowledge Service

### Task 46: Gotcha store (JSONL)
- Create `src/knowledge/gotcha-store.ts` + tests
- Append, read (last-version-wins), match by glob (minimatch), increment hit count

### Task 47: Gotcha injection into session context
- Extend `src/session-runtime/runtime.ts`
- Before session spawn: query matching gotchas, include in context

### Task 48: Pitfall extraction from session output
- Create `src/knowledge/extractor.ts` + tests
- Parse session output for structured pitfall markers, store via gotcha store

### Task 49: Operator correction capture
- Create `src/knowledge/corrections.ts` + tests
- Store operator corrections as elevated-priority gotchas

### Task 50: Log compaction
- Extend `src/knowledge/gotcha-store.ts`
- Compact when file exceeds threshold: deduplicate, remove archived, atomic rewrite

### Task 51: Promotion flow
- Create `src/knowledge/promotion.ts` + tests
- Detect candidates (hit count >= threshold), surface for operator review

### Task 52: Prompt templates + rendering
- Create `src/knowledge/templates.ts` + tests
- Load markdown templates, `{{variable}}` replacement, list mutable templates

---

## Chunk 11: Holdout + Warmup + Sampling

### Task 53: Holdout runner
- Create `src/validation/holdout.ts` + tests
- Invoke configurable command, parse JSON output, return pass/fail per scenario

### Task 54: Holdout failure → diagnosis routing
- Extend `src/control-plane/phases.ts`
- On holdout failure: delegate to Bug Diagnosis Service for A/B/C classification

### Task 55: Warmup state management
- Create `src/validation/warmup.ts` + tests
- Track completion count, graduated flag, regression threshold, consecutive corrections

### Task 56: Sampling policy
- Create `src/validation/sampling.ts` + tests
- Deterministic sampling (SHA-based), minimum floor (1%), label-based approval hold

### Task 57: Warmup regression
- Extend `src/validation/warmup.ts`
- Consecutive corrections counter, revert to warmup on threshold breach

---

## Chunk 12: Operational Hardening

### Task 58: Containment hooks (PreToolUse shell scripts)
- Create `src/session-runtime/containment-hooks.ts` + tests
- Path blocking, content inspection patterns, read/write classification
- Frozen interface, tested independently

### Task 59: Repetition detection
- Create `src/session-runtime/repetition.ts` + tests
- Sliding window of tool calls, block after consecutive threshold

### Task 60: Large response offloading
- Create `src/session-runtime/offload.ts` + tests
- Check response size, write to file, replace with reference message

### Task 61: Context compaction
- Create `src/session-runtime/compaction.ts` + tests
- Monitor token usage, trigger summarization via low-cost session

### Task 62: Integration flow (lock + rebase + PR)
- Extend `src/control-plane/phases.ts`
- In-memory mutex, rebase onto staging, create PR, delegate diff review

### Task 63: Release proposal
- Create `src/control-plane/release.ts` + tests
- Aggregate release notes from results ledger, create staging→production PR

### Task 64: Graceful shutdown
- Extend `src/control-plane/daemon.ts`
- SIGTERM/SIGINT handling, drain mode, grace period, state flush

### Task 65: Prompt optimization flow
- Create `src/knowledge/optimization.ts` + tests
- Assemble context, spawn optimizer session, parse diffs, store proposals

### Task 66: SDK Adapter
- Create `src/session-runtime/adapters/sdk.ts` + tests
- Programmatic session execution via `@anthropic-ai/claude-agent-sdk`
- Hook callbacks, structured output, cost from headers

### Task 67: Docker workspace pool (Hetzner)
- Create `src/session-runtime/workspace-pool.ts` + tests
- SSH tunnel, Docker Engine API, container lifecycle, security hardening
- Pre-warm pool, single-use containers, cleanup

---

## Dependency Graph

```
Chunk 1 (Foundation)
  └─> Chunk 2 (Session Runtime)
       └─> Chunk 3 (Control Plane MVP)
            └─> Chunk 4 (Single-Unit Implementation)
                 └─> Chunk 5 (Validation MVP + Reporting)
                      └─> Chunk 6 (End-to-End MVP) ← 🎉 MVP
                           ├─> Chunk 7 (Parallel Batches)
                           ├─> Chunk 8 (Full Review Gates)
                           ├─> Chunk 9 (Bug Diagnosis)
                           ├─> Chunk 10 (Knowledge Service)
                           ├─> Chunk 11 (Holdout + Warmup)
                           └─> Chunk 12 (Operational Hardening)
```

Chunks 7-12 can be worked in parallel after MVP. Recommended order: 7 → 8 → 10 → 9 → 11 → 12.
