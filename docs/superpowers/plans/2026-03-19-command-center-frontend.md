# Command Center Frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Command Center frontend: a persistent Claude panel in every dashboard page, a Command Center hub page, a 5-step New Project wizard, and the daemon RemoteControlManager that spawns `claude remote-control` and exposes its URL through `/api/daemon/status`.

**Architecture:** The daemon spawns `claude remote-control` as a child process, captures the session URL from stdout, and exposes it via the `/status` HTTP endpoint. The dashboard polls that endpoint and renders a collapsible right-side Claude panel (client component) on every page. The Command Center page and New Project wizard are standard Next.js App Router pages with Server Actions for the GitHub API calls.

**Tech Stack:** Next.js 16 App Router, Tailwind v4, shadcn/ui, Vitest + jsdom + @testing-library/react (dashboard), Vitest Node (daemon), child_process.spawn (Node.js built-in), GitHub REST API via fetch, Supabase SSR client, pnpm monorepo (`pnpm --filter @auto-claude/dashboard test`, `pnpm --filter @auto-claude/daemon test`).

**Spec:** `docs/superpowers/specs/2026-03-19-command-center-design.md`

---

## File Map

**New files — daemon:**
- `packages/daemon/src/control-plane/remote-control.ts` — `RemoteControlManager` class: spawns `claude remote-control`, parses URL from stdout, restarts with backoff, exposes `getState()`.
- `packages/daemon/src/control-plane/remote-control.test.ts` — unit tests for RemoteControlManager

**Modified files — daemon:**
- `packages/daemon/src/control-plane/server.ts` — add `remote_control_url` and `remote_control_state` to `ControlHandlers` interface and `/status` response
- `packages/daemon/src/control-plane/server.test.ts` — extend status test
- `packages/daemon/src/control-plane/daemon.ts` — instantiate RemoteControlManager, pass state into getStatus

**New files — dashboard:**
- `packages/dashboard/components/claude-panel/claude-panel.tsx` — collapsible right-side panel client component
- `packages/dashboard/components/claude-panel/claude-panel.test.tsx` — render tests
- `packages/dashboard/components/claude-panel/use-claude-panel.ts` — polling hook + local-storage collapse state
- `packages/dashboard/components/claude-panel/use-claude-panel.test.ts` — hook tests
- `packages/dashboard/components/claude-panel/context-actions.ts` — page-aware clipboard messages
- `packages/dashboard/components/claude-panel/context-actions.test.ts` — context action tests
- `packages/dashboard/app/(dashboard)/command-center/page.tsx` — Command Center hub page
- `packages/dashboard/app/(dashboard)/command-center/new-project/page.tsx` — New Project wizard page (client component)
- `packages/dashboard/actions/new-project.ts` — Server Action: `createProject(data)` — GitHub API + Supabase insert
- `packages/dashboard/actions/new-project.test.ts` — unit tests for createProject
- `packages/dashboard/lib/github-api.ts` — thin fetch wrappers for GitHub repo creation and file commits
- `packages/dashboard/lib/github-api.test.ts` — unit tests with mocked fetch
- `packages/dashboard/lib/scaffold-templates.ts` — generates AGENTS.md, CLAUDE.md, L0-vision.md, traceability.yml content
- `packages/dashboard/lib/scaffold-templates.test.ts` — snapshot/string tests

**Modified files — dashboard:**
- `packages/dashboard/app/(dashboard)/layout.tsx` — 3-zone layout: Sidebar + main + ClaudePanel
- `packages/dashboard/components/sidebar.tsx` — add Command Center nav item
- `packages/dashboard/app/api/daemon/status/route.ts` — already passes through daemon JSON; no change needed (daemon response now includes the new fields automatically)

**Supabase:**
- `supabase/migrations/002_command_center.sql` — add `webhook-secret` to `key_type` enum; add `matrix_status` column to `repos`

---

## Task 0: Wire up dashboard test and typecheck scripts

**Files:**
- Modify: `packages/dashboard/package.json`

The dashboard has `vitest` installed and a `vitest.config.ts` but no `test` or `typecheck` script. Without this, every `pnpm --filter @auto-claude/dashboard test` call in subsequent tasks silently exits 0 — tests never run. Fix this first.

- [ ] **Step 1: Add scripts to dashboard package.json**

In `packages/dashboard/package.json`, add to the `"scripts"` object:

```json
"test": "vitest run",
"typecheck": "tsc --noEmit"
```

The full scripts block becomes:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "test": "vitest run",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 2: Verify existing tests pass**

```bash
pnpm --filter @auto-claude/dashboard test
```
Expected: vitest output with passing tests (actions, components, lib/types, proxy tests)

- [ ] **Step 3: Verify typecheck passes**

```bash
pnpm --filter @auto-claude/dashboard typecheck
```
Expected: no TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/package.json
git commit -m "chore(dashboard): add test and typecheck scripts"
```

---

## Task 1: Supabase migration — extend schema

**Files:**
- Create: `supabase/migrations/002_command_center.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 002_command_center.sql

-- Add webhook-secret to key_type enum
ALTER TYPE key_type ADD VALUE IF NOT EXISTS 'webhook-secret';

-- Add matrix_status to repos table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'matrix_status'
      AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) THEN
    CREATE TYPE matrix_status AS ENUM ('ok', 'degraded', 'failed');
  END IF;
END $$;

ALTER TABLE repos
  ADD COLUMN IF NOT EXISTS matrix_status matrix_status NOT NULL DEFAULT 'ok';
```

- [ ] **Step 2: Update `lib/types.ts` to match**

In `packages/dashboard/lib/types.ts`:

1. In `Enums.key_type`: change `"source-control" | "model-provider"` → `"source-control" | "model-provider" | "webhook-secret"`
2. In `repos` Row/Insert/Update: add `matrix_status: "ok" | "degraded" | "failed"` (Insert/Update: optional with default `"ok"`)
3. In `Constants.public.Enums.key_type`: add `"webhook-secret"` to the array

- [ ] **Step 3: Run dashboard tests to confirm types compile**

```bash
pnpm --filter @auto-claude/dashboard test
```
Expected: all existing tests pass

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/002_command_center.sql packages/dashboard/lib/types.ts
git commit -m "feat(schema): add webhook-secret key type and matrix_status to repos"
```

---

## Task 2: RemoteControlManager — daemon child process

**Files:**
- Create: `packages/daemon/src/control-plane/remote-control.ts`
- Create: `packages/daemon/src/control-plane/remote-control.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/control-plane/remote-control.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// We test the manager's state machine without a real claude binary.
// Mock child_process.spawn to return controllable fake processes.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { RemoteControlManager } from './remote-control.js';

function makeFakeProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe('RemoteControlManager', () => {
  let manager: RemoteControlManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new RemoteControlManager();
  });

  afterEach(async () => {
    await manager.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts in offline state', () => {
    const state = manager.getState();
    expect(state.remote_control_state).toBe('offline');
    expect(state.remote_control_url).toBeNull();
  });

  it('becomes active after URL parsed from stdout', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    manager.start();
    // Simulate claude printing the session URL
    // claude remote-control prints the URL somewhere in its startup output
    proc.stdout.emit('data', Buffer.from('Remote control session: https://claude.ai/remote/abc123\n'));

    const state = manager.getState();
    expect(state.remote_control_state).toBe('active');
    expect(state.remote_control_url).toBe('https://claude.ai/remote/abc123');
  });

  it('becomes offline and schedules restart when process exits', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    manager.start();
    proc.stdout.emit('data', Buffer.from('Session URL: https://claude.ai/remote/abc123\n'));
    expect(manager.getState().remote_control_state).toBe('active');

    proc.emit('exit', 1);
    expect(manager.getState().remote_control_state).toBe('offline');
  });

  it('transitions to failed after 3 consecutive restart failures', async () => {
    // The spec says "after three consecutive failed restart attempts" — failureCount reaches
    // MAX_FAILURES (3) on the third restart exit, triggering the failed state.
    vi.mocked(spawn).mockImplementation(() => {
      const proc = makeFakeProcess();
      // Immediately exit without emitting URL — simulates launch failure
      setTimeout(() => proc.emit('exit', 1), 0);
      return proc;
    });

    manager.start();

    // Each exit schedules a backoff timer. Advance through 3 exit cycles.
    for (let i = 0; i < 3; i++) {
      await Promise.resolve(); // let setTimeout(exit) fire
      vi.runAllTimers();       // fire the backoff timer → triggers next spawn
      await Promise.resolve();
    }
    await Promise.resolve();

    expect(manager.getState().remote_control_state).toBe('failed');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @auto-claude/daemon test src/control-plane/remote-control
```
Expected: FAIL — `remote-control.ts` does not exist yet

- [ ] **Step 3: Implement RemoteControlManager**

Create `packages/daemon/src/control-plane/remote-control.ts`:

```typescript
import { spawn, type ChildProcess } from 'child_process';

export type RemoteControlState = 'offline' | 'active' | 'failed';

export interface RemoteControlStatus {
  remote_control_state: RemoteControlState;
  remote_control_url: string | null;
}

const MAX_FAILURES = 3;
const BACKOFF_MS = [5_000, 15_000, 30_000]; // indexed by attempt (0-based)

export class RemoteControlManager {
  private state: RemoteControlState = 'offline';
  private url: string | null = null;
  private proc: ChildProcess | null = null;
  private failureCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  start(): void {
    this.stopped = false;
    this.spawn();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.state = 'offline';
    this.url = null;
  }

  getState(): RemoteControlStatus {
    return {
      remote_control_state: this.state,
      remote_control_url: this.url,
    };
  }

  private spawn(): void {
    if (this.stopped) return;

    const proc = spawn('claude', ['remote-control'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // Match https:// URLs, stopping at whitespace or common trailing punctuation.
      // claude remote-control prints the session URL in its startup output.
      const match = text.match(/https:\/\/[^\s,;)'"]+/);
      if (match && this.state !== 'active') {
        // Strip any trailing punctuation that leaked past the character class
        this.url = match[0].replace(/[.,;)'"]+$/, '');
        this.state = 'active';
        this.failureCount = 0;
      }
    });

    proc.on('exit', () => {
      if (this.stopped) return;
      this.state = 'offline';
      this.url = null;
      this.proc = null;
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    this.failureCount++;

    if (this.failureCount >= MAX_FAILURES) {
      this.state = 'failed';
      console.error('[remote-control] Too many restart failures — manual intervention required');
      return;
    }

    const delay = BACKOFF_MS[Math.min(this.failureCount - 1, BACKOFF_MS.length - 1)];
    console.warn(`[remote-control] Process exited (attempt ${this.failureCount}/${MAX_FAILURES}), restarting in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @auto-claude/daemon test src/control-plane/remote-control
```
Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/remote-control.ts packages/daemon/src/control-plane/remote-control.test.ts
git commit -m "feat(daemon): add RemoteControlManager for claude remote-control process"
```

---

## Task 3: Extend daemon status endpoint with remote control fields

**Files:**
- Modify: `packages/daemon/src/control-plane/server.ts`
- Modify: `packages/daemon/src/control-plane/server.test.ts`
- Modify: `packages/daemon/src/control-plane/daemon.ts`

- [ ] **Step 1: Write the failing test for the status endpoint**

In `packages/daemon/src/control-plane/server.test.ts`, add after the existing status test:

```typescript
it('GET /status includes remote_control fields', async () => {
  // Override handlers for this test
  const { server: s2, start: start2 } = createControlServer(PORT + 1, {
    getStatus: () => ({
      activeRuns: 0,
      dailyCost: 0,
      paused: false,
      remote_control_url: 'https://claude.ai/remote/test',
      remote_control_state: 'active',
    }),
    pause: () => {},
    resume: () => {},
    retry: () => ok(undefined),
  });
  serverRef = s2;
  await start2();

  const res = await fetch(`http://127.0.0.1:${PORT + 1}/status`);
  const body = await res.json();
  expect(body.remote_control_url).toBe('https://claude.ai/remote/test');
  expect(body.remote_control_state).toBe('active');
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @auto-claude/daemon test src/control-plane/server
```
Expected: the new test fails because `remote_control_url` is not in the ControlHandlers type

- [ ] **Step 3: Update ControlHandlers interface in server.ts**

In `packages/daemon/src/control-plane/server.ts`, change the `ControlHandlers` interface to:

```typescript
export interface ControlHandlers {
  getStatus: () => unknown;
  pause: () => void;
  resume: () => void;
  retry: (issueNumber: number) => Result<void>;
  stateDir?: string;
}
```

No change needed — `getStatus` returns `unknown`, so the handler in `daemon.ts` just needs to include the new fields. The test passes once `daemon.ts` is wired up. Proceed to Step 4.

- [ ] **Step 4: Wire RemoteControlManager into daemon.ts**

In `packages/daemon/src/control-plane/daemon.ts`:

1. Add import at top:
```typescript
import { RemoteControlManager } from './remote-control.js';
```

2. After `// 3. Initialize services`, add:
```typescript
// 3b. Start Remote Control
const remoteControl = new RemoteControlManager();
remoteControl.start();
```

3. Update the `getStatus` lambda in the `createControlServer` call to include remote control state:
```typescript
getStatus: () => ({
  activeRuns,
  dailyCost: costTracker.getDailyCost(),
  paused,
  uptime: process.uptime(),
  ...remoteControl.getState(),
}),
```

4. In the `shutdown` function, before `server.close()`, add:
```typescript
await remoteControl.stop();
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @auto-claude/daemon test src/control-plane/server
pnpm --filter @auto-claude/daemon test src/control-plane/remote-control
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/control-plane/server.ts packages/daemon/src/control-plane/server.test.ts packages/daemon/src/control-plane/daemon.ts
git commit -m "feat(daemon): expose remote_control_url and remote_control_state in /status"
```

---

## Task 4: Claude panel polling hook

**Files:**
- Create: `packages/dashboard/components/claude-panel/use-claude-panel.ts`
- Create: `packages/dashboard/components/claude-panel/use-claude-panel.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/components/claude-panel/use-claude-panel.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useClaudePanel } from './use-claude-panel';

// Mock fetch
global.fetch = vi.fn();

describe('useClaudePanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        remote_control_state: 'active',
        remote_control_url: 'https://claude.ai/remote/test',
      }),
    } as Response);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts collapsed by default', () => {
    const { result } = renderHook(() => useClaudePanel());
    expect(result.current.isOpen).toBe(false);
  });

  it('toggle opens the panel', () => {
    const { result } = renderHook(() => useClaudePanel());
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);
  });

  it('persists open state to localStorage', () => {
    const { result } = renderHook(() => useClaudePanel());
    act(() => result.current.toggle());
    expect(localStorage.getItem('claude-panel-open')).toBe('true');
  });

  it('polls /api/daemon/status and exposes url and state', async () => {
    const { result } = renderHook(() => useClaudePanel());
    await act(async () => {
      vi.advanceTimersByTime(100); // trigger initial fetch
      await Promise.resolve();
    });
    expect(result.current.sessionUrl).toBe('https://claude.ai/remote/test');
    expect(result.current.sessionState).toBe('active');
  });

  it('re-polls every 5 seconds', async () => {
    renderHook(() => useClaudePanel());
    await act(async () => {
      vi.advanceTimersByTime(5100);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(2); // initial + one poll
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @auto-claude/dashboard test components/claude-panel/use-claude-panel
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement the hook**

Create `packages/dashboard/components/claude-panel/use-claude-panel.ts`:

```typescript
'use client';
import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'claude-panel-open';
const POLL_INTERVAL = 5_000;

export type RemoteControlState = 'offline' | 'active' | 'failed';

export function useClaudePanel() {
  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<RemoteControlState>('offline');

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const res = await fetch('/api/daemon/status');
        if (!res.ok || !active) return;
        const data = await res.json();
        setSessionUrl(data.remote_control_url ?? null);
        setSessionState(data.remote_control_state ?? 'offline');
      } catch {
        // ignore — panel stays in last known state
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return { isOpen, toggle, sessionUrl, sessionState };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @auto-claude/dashboard test components/claude-panel/use-claude-panel
```
Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/claude-panel/use-claude-panel.ts packages/dashboard/components/claude-panel/use-claude-panel.test.ts
git commit -m "feat(dashboard): add useClaudePanel hook with polling and persist state"
```

---

## Task 5: Context actions helper

**Files:**
- Create: `packages/dashboard/components/claude-panel/context-actions.ts`
- Create: `packages/dashboard/components/claude-panel/context-actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/components/claude-panel/context-actions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getContextActions, buildRunContext } from './context-actions';

describe('getContextActions', () => {
  it('returns run actions for /runs/[id]', () => {
    const actions = getContextActions('/runs/abc-123');
    expect(actions).toHaveLength(2);
    expect(actions[0].label).toBe('Share this run with Claude');
    expect(actions[1].label).toBe('Create follow-up issue from this run');
  });

  it('returns repo actions for /repos/[id]', () => {
    const actions = getContextActions('/repos/abc-123');
    expect(actions[0].label).toBe('Create issue for this repo');
  });

  it('returns cost actions for /cost', () => {
    const actions = getContextActions('/cost');
    expect(actions[0].label).toBe('Analyze cost trends with Claude');
  });

  it('always includes Open in new tab action', () => {
    const actions = getContextActions('/');
    expect(actions.some((a) => a.label === 'Open in new tab')).toBe(true);
  });
});

describe('buildRunContext', () => {
  it('builds a structured run summary', () => {
    const text = buildRunContext({
      id: 'run-1',
      repo_owner: 'acme',
      repo_name: 'web',
      issue_number: 42,
      issue_title: 'Fix login bug',
      outcome: 'complete',
      total_cost: 0.12,
      current_phase: 'done',
    });
    expect(text).toContain('acme/web');
    expect(text).toContain('#42');
    expect(text).toContain('Fix login bug');
    expect(text).toContain('$0.12');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm --filter @auto-claude/dashboard test components/claude-panel/context-actions
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement context actions**

Create `packages/dashboard/components/claude-panel/context-actions.ts`:

```typescript
export interface ContextAction {
  label: string;
  /** Returns clipboard text, or null to just open the URL */
  buildClipboardText: ((sessionUrl: string) => string) | null;
}

/** Returns page-aware quick actions for the Claude panel */
export function getContextActions(pathname: string): ContextAction[] {
  const actions: ContextAction[] = [];

  if (/^\/runs\/[^/]+/.test(pathname)) {
    actions.push({
      label: 'Share this run with Claude',
      buildClipboardText: null, // caller fills in run context via buildRunContext
    });
    actions.push({
      label: 'Create follow-up issue from this run',
      buildClipboardText: null,
    });
  } else if (/^\/repos\/[^/]+/.test(pathname)) {
    actions.push({ label: 'Create issue for this repo', buildClipboardText: null });
    actions.push({ label: 'Review workflow matrix with Claude', buildClipboardText: null });
  } else if (pathname === '/cost') {
    actions.push({ label: 'Analyze cost trends with Claude', buildClipboardText: null });
  }

  // Always available
  actions.push({ label: 'Open in new tab', buildClipboardText: null });
  actions.push({ label: 'Show QR code', buildClipboardText: null });

  return actions;
}

export interface RunSummary {
  id: string;
  repo_owner: string;
  repo_name: string;
  issue_number: number;
  issue_title: string;
  outcome: string;
  total_cost: number;
  current_phase: string | null;
}

export function buildRunContext(run: RunSummary): string {
  return [
    `## Run Context`,
    `**Repo:** ${run.repo_owner}/${run.repo_name}`,
    `**Issue:** #${run.issue_number} — ${run.issue_title}`,
    `**Phase:** ${run.current_phase ?? 'unknown'}`,
    `**Outcome:** ${run.outcome}`,
    `**Cost:** $${run.total_cost.toFixed(2)}`,
    `**Run ID:** ${run.id}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @auto-claude/dashboard test components/claude-panel/context-actions
```
Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/claude-panel/context-actions.ts packages/dashboard/components/claude-panel/context-actions.test.ts
git commit -m "feat(dashboard): add context actions helper for Claude panel"
```

---

## Task 6: Claude panel component

**Files:**
- Create: `packages/dashboard/components/claude-panel/claude-panel.tsx`
- Create: `packages/dashboard/components/claude-panel/claude-panel.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/components/claude-panel/claude-panel.test.tsx`:

```typescript
vi.mock('./use-claude-panel', () => ({
  useClaudePanel: vi.fn(),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudePanel } from './claude-panel';
import { useClaudePanel } from './use-claude-panel';

const mockHook = vi.mocked(useClaudePanel);

describe('ClaudePanel', () => {
  beforeEach(() => {
    mockHook.mockReturnValue({
      isOpen: false,
      toggle: vi.fn(),
      sessionUrl: null,
      sessionState: 'offline',
    });
  });

  it('renders collapsed tab with status dot', () => {
    render(<ClaudePanel />);
    expect(screen.getByRole('button', { name: /claude/i })).toBeInTheDocument();
    // Status dot is present (grey for offline)
    expect(document.querySelector('[data-state="offline"]')).toBeInTheDocument();
  });

  it('calls toggle when tab is clicked', () => {
    const toggle = vi.fn();
    mockHook.mockReturnValue({ isOpen: false, toggle, sessionUrl: null, sessionState: 'offline' });
    render(<ClaudePanel />);
    fireEvent.click(screen.getByRole('button', { name: /claude/i }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('shows session URL when open and active', () => {
    mockHook.mockReturnValue({
      isOpen: true,
      toggle: vi.fn(),
      sessionUrl: 'https://claude.ai/remote/test',
      sessionState: 'active',
    });
    render(<ClaudePanel />);
    expect(screen.getByText('https://claude.ai/remote/test')).toBeInTheDocument();
  });

  it('shows failed alert when state is failed', () => {
    mockHook.mockReturnValue({
      isOpen: true,
      toggle: vi.fn(),
      sessionUrl: null,
      sessionState: 'failed',
    });
    render(<ClaudePanel />);
    expect(screen.getByText(/remote control failed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm --filter @auto-claude/dashboard test components/claude-panel/claude-panel
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement ClaudePanel**

Create `packages/dashboard/components/claude-panel/claude-panel.tsx`:

```tsx
'use client';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useClaudePanel } from './use-claude-panel';
import { getContextActions } from './context-actions';

export function ClaudePanel() {
  const { isOpen, toggle, sessionUrl, sessionState } = useClaudePanel();
  const pathname = usePathname();
  const actions = getContextActions(pathname);

  return (
    <div
      className={cn(
        'relative flex flex-col border-l border-border bg-card transition-all duration-200',
        isOpen ? 'w-80' : 'w-8'
      )}
    >
      {/* Collapsed tab */}
      <button
        aria-label="Claude"
        onClick={toggle}
        className="absolute top-4 left-0 flex flex-col items-center w-8 gap-1 py-2 cursor-pointer"
      >
        <span
          data-state={sessionState}
          className={cn(
            'h-2 w-2 rounded-full',
            sessionState === 'active' ? 'bg-green-500' : 'bg-muted-foreground'
          )}
        />
        <span className="text-[10px] font-semibold tracking-widest text-muted-foreground [writing-mode:vertical-lr]">
          CLAUDE
        </span>
      </button>

      {/* Expanded content */}
      {isOpen && (
        <div className="flex flex-col gap-4 p-4 pt-10 overflow-y-auto flex-1">
          {sessionState === 'failed' && (
            <div
              role="alert"
              className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
            >
              Remote Control failed to start. Please restart the daemon.
            </div>
          )}

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Session
            </p>
            {sessionUrl ? (
              <div className="space-y-2">
                <p className="text-xs break-all font-mono">{sessionUrl}</p>
                <div className="flex gap-2">
                  <a
                    href={sessionUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline"
                  >
                    Open ↗
                  </a>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                {sessionState === 'offline' ? 'Waiting for session…' : 'No session URL'}
              </p>
            )}
          </div>

          {actions.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Quick actions
              </p>
              <ul className="space-y-1">
                {actions.map((action) => (
                  <li key={action.label}>
                    <button
                      className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent transition-colors"
                      onClick={() => {
                        if (sessionUrl) window.open(sessionUrl, '_blank');
                      }}
                    >
                      {action.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @auto-claude/dashboard test components/claude-panel/claude-panel
```
Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/claude-panel/
git commit -m "feat(dashboard): add ClaudePanel component with collapsed/expanded states"
```

---

## Task 7: Wire Claude panel into the dashboard layout

**Files:**
- Modify: `packages/dashboard/app/(dashboard)/layout.tsx`
- Modify: `packages/dashboard/components/sidebar.tsx`

- [ ] **Step 1: Update the layout to 3-zone**

Replace `packages/dashboard/app/(dashboard)/layout.tsx` with:

```tsx
import { Sidebar } from '@/components/sidebar';
import { RealtimeProvider } from '@/components/realtime-provider';
import { ClaudePanel } from '@/components/claude-panel/claude-panel';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-8 overflow-auto">
        <RealtimeProvider />
        {children}
      </main>
      <ClaudePanel />
    </div>
  );
}
```

- [ ] **Step 2: Add Command Center to the sidebar nav**

In `packages/dashboard/components/sidebar.tsx`, change the imports line to add `Zap`:

```typescript
import { LayoutDashboard, GitFork, Activity, DollarSign, Users, Settings, Terminal, Zap } from 'lucide-react';
```

Add to the `nav` array (after Runs, before Costs):

```typescript
{ href: '/command-center', label: 'Command Center', icon: Zap },
```

- [ ] **Step 3: Run all dashboard tests**

```bash
pnpm --filter @auto-claude/dashboard test
```
Expected: all existing tests still pass

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/app/(dashboard)/layout.tsx packages/dashboard/components/sidebar.tsx
git commit -m "feat(dashboard): integrate ClaudePanel into 3-zone layout and add nav item"
```

---

## Task 8: GitHub API helpers

**Files:**
- Create: `packages/dashboard/lib/github-api.ts`
- Create: `packages/dashboard/lib/github-api.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/lib/github-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

global.fetch = vi.fn();

import { createGitHubRepo, commitFile } from './github-api';

const mockFetch = vi.mocked(fetch);

describe('createGitHubRepo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs to GitHub API with correct body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: 'test-repo', html_url: 'https://github.com/acme/test-repo' }),
    } as Response);

    const result = await createGitHubRepo('ghp_token', {
      org: 'acme',
      name: 'test-repo',
      description: 'A test repo',
      private: true,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/orgs/acme/repos',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer ghp_token' }),
      })
    );
    expect(result.html_url).toBe('https://github.com/acme/test-repo');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ message: 'Repository creation failed' }),
    } as Response);

    await expect(
      createGitHubRepo('token', { org: 'acme', name: 'bad', description: '', private: false })
    ).rejects.toThrow('GitHub API error 422');
  });
});

describe('commitFile', () => {
  it('PUTs file content to GitHub contents API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: { sha: 'abc' } }),
    } as Response);

    await commitFile('ghp_token', {
      owner: 'acme',
      repo: 'web',
      path: '.specify/L0-vision.md',
      content: '# Vision',
      message: 'chore: scaffold L0 vision',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/web/contents/.specify/L0-vision.md',
      expect.objectContaining({ method: 'PUT' })
    );
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm --filter @auto-claude/dashboard test lib/github-api
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement github-api.ts**

Create `packages/dashboard/lib/github-api.ts`:

```typescript
const GH_API = 'https://api.github.com';

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghFetch(token: string, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: headers(token) });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${(body as any)?.message ?? 'unknown'}`);
  }
  return body;
}

export interface CreateRepoOptions {
  org: string;
  name: string;
  description: string;
  private: boolean;
}

export interface GitHubRepo {
  id: number;
  name: string;
  html_url: string;
  full_name: string;
}

export async function createGitHubRepo(token: string, opts: CreateRepoOptions): Promise<GitHubRepo> {
  return ghFetch(token, `${GH_API}/orgs/${opts.org}/repos`, {
    method: 'POST',
    body: JSON.stringify({
      name: opts.name,
      description: opts.description,
      private: opts.private,
      auto_init: false,
    }),
  }) as Promise<GitHubRepo>;
}

export interface CommitFileOptions {
  owner: string;
  repo: string;
  path: string;
  content: string;
  message: string;
  sha?: string; // for updates
}

export async function commitFile(token: string, opts: CommitFileOptions): Promise<void> {
  const encoded = Buffer.from(opts.content, 'utf8').toString('base64');
  await ghFetch(token, `${GH_API}/repos/${opts.owner}/${opts.repo}/contents/${opts.path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: opts.message,
      content: encoded,
      ...(opts.sha ? { sha: opts.sha } : {}),
    }),
  });
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @auto-claude/dashboard test lib/github-api
```
Expected: all 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/lib/github-api.ts packages/dashboard/lib/github-api.test.ts
git commit -m "feat(dashboard): add GitHub API helpers for repo creation and file commits"
```

---

## Task 9: Scaffold templates

**Files:**
- Create: `packages/dashboard/lib/scaffold-templates.ts`
- Create: `packages/dashboard/lib/scaffold-templates.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/lib/scaffold-templates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildL0Vision,
  buildAgentsMd,
  buildClaudeMd,
  buildTraceabilityYml,
  buildWorkflowYml,
} from './scaffold-templates';

describe('scaffold templates', () => {
  it('buildL0Vision includes project name and vision', () => {
    const out = buildL0Vision('My Project', 'Build something great');
    expect(out).toContain('My Project');
    expect(out).toContain('Build something great');
  });

  it('buildAgentsMd returns non-empty markdown', () => {
    const out = buildAgentsMd();
    expect(out).toContain('AGENTS.md');
  });

  it('buildClaudeMd references AGENTS.md', () => {
    const out = buildClaudeMd();
    expect(out).toContain('@AGENTS.md');
  });

  it('buildTraceabilityYml includes project name', () => {
    const out = buildTraceabilityYml('My Project');
    expect(out).toContain('My Project');
    expect(out).toContain('traceability');
  });

  it('buildWorkflowYml sets extends to default', () => {
    const out = buildWorkflowYml();
    expect(out).toContain('extends: default');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm --filter @auto-claude/dashboard test lib/scaffold-templates
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement scaffold-templates.ts**

Create `packages/dashboard/lib/scaffold-templates.ts`:

```typescript
export function buildL0Vision(projectName: string, visionStatement: string): string {
  return `# L0 Vision — ${projectName}

## Purpose

${visionStatement}

## Created

${new Date().toISOString().split('T')[0]}
`;
}

export function buildAgentsMd(): string {
  return `# AGENTS.md

This file contains rules and guidelines for AI agents working in this repository.

## Getting Started

Read CLAUDE.md for Claude Code-specific instructions.
`;
}

export function buildClaudeMd(): string {
  return `@AGENTS.md
`;
}

export function buildTraceabilityYml(projectName: string): string {
  return `# .specify/traceability.yml
# Auto-generated by auto-claude command center
# Project: ${projectName}

specs: []
`;
}

export function buildWorkflowYml(): string {
  return `# .auto-claude/workflow.yml
# Workflow gate configuration — managed by auto-claude dashboard

extends: default
`;
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @auto-claude/dashboard test lib/scaffold-templates
```
Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/lib/scaffold-templates.ts packages/dashboard/lib/scaffold-templates.test.ts
git commit -m "feat(dashboard): add scaffold templates for new project wizard"
```

---

## Task 10: New Project Server Action

**Files:**
- Create: `packages/dashboard/actions/new-project.ts`
- Create: `packages/dashboard/actions/new-project.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/actions/new-project.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ error: null, data: { id: 'new-repo-id' } }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/github-api', () => ({
  createGitHubRepo: vi.fn().mockResolvedValue({ id: 1, name: 'test', html_url: 'https://github.com/acme/test', full_name: 'acme/test' }),
  commitFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createProject } from './new-project';
import { createGitHubRepo, commitFile } from '@/lib/github-api';

describe('createProject', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseInput = {
    org: 'acme',
    name: 'test',
    description: 'A test project',
    private: true,
    l0Vision: 'Build something great',
    baseProfile: 'default' as const,
  };

  beforeEach(() => {
    // Server Action reads GITHUB_TOKEN from process.env, never from client input
    process.env.GITHUB_TOKEN = 'ghp_test';
  });

  it('creates GitHub repo using server-side GITHUB_TOKEN', async () => {
    await createProject(baseInput);
    expect(createGitHubRepo).toHaveBeenCalledWith('ghp_test', expect.objectContaining({ org: 'acme', name: 'test' }));
  });

  it('commits scaffold files', async () => {
    await createProject(baseInput);
    // Should commit at minimum: L0 vision, traceability, workflow, AGENTS.md, CLAUDE.md
    expect(vi.mocked(commitFile).mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('inserts Supabase repo record with enabled=false', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    await createProject(baseInput);
    const client = await (createClient as any)();
    expect(client.from().insert).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', name: 'test', enabled: false })
    );
  });

  it('returns repoId on success', async () => {
    const result = await createProject(baseInput);
    expect(result.repoId).toBe('new-repo-id');
  });

  it('returns error object when GitHub API fails', async () => {
    vi.mocked(createGitHubRepo).mockRejectedValueOnce(new Error('GitHub API error 422: name exists'));
    const result = await createProject(baseInput);
    expect(result.error).toContain('GitHub API error');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm --filter @auto-claude/dashboard test actions/new-project
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement createProject action**

Create `packages/dashboard/actions/new-project.ts`:

```typescript
'use server';
import { createClient } from '@/lib/supabase/server';
import { createGitHubRepo, commitFile } from '@/lib/github-api';
import {
  buildL0Vision,
  buildAgentsMd,
  buildClaudeMd,
  buildTraceabilityYml,
  buildWorkflowYml,
} from '@/lib/scaffold-templates';
import { revalidatePath } from 'next/cache';

export interface CreateProjectInput {
  // githubToken is intentionally NOT in this interface — the Server Action reads
  // GITHUB_TOKEN from process.env on the server. Never pass tokens from the client.
  org: string;
  name: string;
  description: string;
  private: boolean;
  l0Vision: string;
  baseProfile: 'default' | string; // 'default' or a raw GitHub URL
}

export interface CreateProjectResult {
  repoId?: string;
  error?: string;
}

export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  // Read the GitHub token server-side only — never from client input.
  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) return { error: 'GITHUB_TOKEN is not configured on the server' };

  try {
    // Step 1: Create GitHub repository
    const repo = await createGitHubRepo(token, {
      org: input.org,
      name: input.name,
      description: input.description,
      private: input.private,
    });

    const owner = input.org;
    const repoName = input.name;

    // Steps 2–5: Commit scaffold files
    await commitFile(token, {
      owner, repo: repoName,
      path: '.specify/L0-vision.md',
      content: buildL0Vision(input.name, input.l0Vision),
      message: 'chore: scaffold L0 vision',
    });

    await commitFile(token, {
      owner, repo: repoName,
      path: '.specify/traceability.yml',
      content: buildTraceabilityYml(input.name),
      message: 'chore: scaffold traceability',
    });

    await commitFile(token, {
      owner, repo: repoName,
      path: '.auto-claude/workflow.yml',
      content: buildWorkflowYml(),
      message: 'chore: scaffold workflow gates',
    });

    await commitFile(token, {
      owner, repo: repoName,
      path: 'AGENTS.md',
      content: buildAgentsMd(),
      message: 'chore: scaffold AGENTS.md',
    });

    await commitFile(token, {
      owner, repo: repoName,
      path: 'CLAUDE.md',
      content: buildClaudeMd(),
      message: 'chore: scaffold CLAUDE.md',
    });

    // Step 6: Create Supabase repo record
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('repos')
      .insert({
        owner,
        name: repoName,
        enabled: false,
        staging_branch: 'staging',
        production_branch: 'main',
      })
      .select('id')
      .single();

    if (error) throw new Error(`Supabase error: ${error.message}`);

    revalidatePath('/repos');
    return { repoId: data.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @auto-claude/dashboard test actions/new-project
```
Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/actions/new-project.ts packages/dashboard/actions/new-project.test.ts
git commit -m "feat(dashboard): add createProject server action for new project wizard"
```

---

## Task 11: New Project Wizard UI

**Files:**
- Create: `packages/dashboard/app/(dashboard)/command-center/new-project/page.tsx`

_No test file — this is a thin UI shell that calls the already-tested server action. The integration is verified manually._

- [ ] **Step 1: Create the wizard page**

Create `packages/dashboard/app/(dashboard)/command-center/new-project/page.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createProject } from '@/actions/new-project';

interface WizardState {
  org: string;
  name: string;
  description: string;
  visibility: 'private' | 'public';
  baseProfile: 'default';
  l0Vision: string;
}

// Spec defines 5 steps: Basics, Inherit, Matrix, Vision, Create.
// The full inline matrix editor (Step 3) ships in Plan 2 (Workflow Gate Engine).
// Here it shows a read-only preview of the inherited defaults so the wizard
// is structurally complete with all 5 steps.
const STEPS = ['Basics', 'Inherit', 'Matrix', 'Vision', 'Create'] as const;

export default function NewProjectPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>({
    org: '', name: '', description: '', visibility: 'private',
    baseProfile: 'default', l0Vision: '',
  });
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  const canAdvance = (): boolean => {
    if (step === 0) return !!(state.org && state.name);
    if (step === 3) return !!state.l0Vision.trim(); // Step 3 is Vision (0-indexed)
    return true;
  };

  async function handleCreate() {
    setCreating(true);
    setError(null);
    setProgress(['Creating GitHub repository…']);

    // The GitHub token is read server-side inside the Server Action from
    // process.env.GITHUB_TOKEN. It is never passed from the browser.
    const result = await createProject({
      org: state.org,
      name: state.name,
      description: state.description,
      private: state.visibility === 'private',
      l0Vision: state.l0Vision,
      baseProfile: state.baseProfile,
    });

    if (result.error) {
      setError(result.error);
      setCreating(false);
      return;
    }

    setProgress((p) => [...p, 'Done!']);
    router.push(`/repos/${result.repoId}/settings`);
  }

  return (
    <div className="max-w-2xl mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">New Project</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Step {step + 1} of {STEPS.length} — {STEPS[step]}
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex gap-2">
        {STEPS.map((label, i) => (
          <div
            key={label}
            className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-muted'}`}
          />
        ))}
      </div>

      {/* Step 0: Basics */}
      {step === 0 && (
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">GitHub org / username</label>
            <input
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              value={state.org}
              onChange={(e) => update('org', e.target.value)}
              placeholder="my-org"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Repository name</label>
            <input
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              value={state.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="my-project"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Description (optional)</label>
            <input
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              value={state.description}
              onChange={(e) => update('description', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Visibility</label>
            <div className="flex gap-4">
              {(['private', 'public'] as const).map((v) => (
                <label key={v} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    value={v}
                    checked={state.visibility === v}
                    onChange={() => update('visibility', v)}
                  />
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Step 1: Inherit */}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            New repos inherit from system defaults. Org-level profiles and per-repo overrides are
            configured in the Workflow Gate Engine (coming soon).
          </p>
          <div className="rounded-md border p-4 bg-muted/40 text-sm space-y-1">
            <p className="font-medium">Inheriting: System defaults</p>
            <p className="text-muted-foreground">Tier 1–2 categories: all gates require human review</p>
            <p className="text-muted-foreground">Tier 3–4 categories: auto-proceed</p>
          </div>
        </div>
      )}

      {/* Step 2: Matrix — read-only preview; full editor ships in Plan 2 */}
      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The inline matrix editor is coming in the Workflow Gate Engine. For now, all repos
            start with system defaults shown below. You can adjust gate values in{' '}
            <span className="font-medium">Repo Settings → Workflow</span> after creation.
          </p>
          <div className="rounded-md border p-4 bg-muted/40 text-sm space-y-1">
            <p className="font-medium">Inherited defaults</p>
            <p className="text-muted-foreground">Tier 1 (auth, secrets, infra, billing): all gates 🛡 floor</p>
            <p className="text-muted-foreground">Tier 2 (schema, api-contract, spec, dependency): gates 🔒 require</p>
            <p className="text-muted-foreground">Tier 3–4 (logic, UI, docs): gates ⚡ auto</p>
          </div>
        </div>
      )}

      {/* Step 3: Vision */}
      {step === 3 && (
        <div className="space-y-2">
          <label className="text-sm font-medium">L0 Vision Statement</label>
          <textarea
            className="w-full border rounded-md px-3 py-2 text-sm bg-background min-h-[160px] resize-y"
            value={state.l0Vision}
            onChange={(e) => update('l0Vision', e.target.value)}
            placeholder="Describe what this project builds and who it's for…"
          />
          <p className="text-xs text-muted-foreground">
            Tip: Use the Claude panel to the right — ask Claude to help write this.
          </p>
        </div>
      )}

      {/* Step 4: Create */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="rounded-md border p-4 text-sm space-y-2">
            <p><span className="font-medium">Repo:</span> {state.org}/{state.name}</p>
            <p><span className="font-medium">Visibility:</span> {state.visibility}</p>
            <p><span className="font-medium">Base profile:</span> system defaults</p>
          </div>

          {progress.length > 0 && (
            <ul className="space-y-1 text-sm">
              {progress.map((msg, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="text-green-500">✓</span> {msg}
                </li>
              ))}
            </ul>
          )}

          {error && (
            <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        {step > 0 ? (
          <button
            onClick={() => setStep((s) => s - 1)}
            className="px-4 py-2 text-sm border rounded-md hover:bg-accent"
            disabled={creating}
          >
            Back
          </button>
        ) : (
          <div />
        )}

        {step < STEPS.length - 1 ? (
          <button
            onClick={() => setStep((s) => s + 1)}
            disabled={!canAdvance()}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            Next
          </button>
        ) : (
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create Project'}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run all dashboard tests to confirm nothing broke**

```bash
pnpm --filter @auto-claude/dashboard test
```
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/app/(dashboard)/command-center/new-project/page.tsx
git commit -m "feat(dashboard): add New Project wizard UI (5-step)"
```

---

## Task 12: Command Center hub page

**Files:**
- Create: `packages/dashboard/app/(dashboard)/command-center/page.tsx`

- [ ] **Step 1: Create the hub page**

Create `packages/dashboard/app/(dashboard)/command-center/page.tsx`:

```tsx
import Link from 'next/link';

export default function CommandCenterPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Command Center</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Create projects, configure workflow gates, and manage org-level defaults.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/command-center/new-project"
          className="group rounded-lg border p-6 bg-card hover:bg-accent/50 transition-colors space-y-2"
        >
          <h2 className="font-medium">New Project</h2>
          <p className="text-sm text-muted-foreground">
            Create a GitHub repository with scaffolded specs and workflow configuration.
          </p>
        </Link>

        <div className="rounded-lg border p-6 bg-card opacity-50 space-y-2">
          <h2 className="font-medium">Global Matrix Defaults</h2>
          <p className="text-sm text-muted-foreground">
            Configure system-wide workflow gate defaults. Available in the Workflow Gate Engine.
          </p>
        </div>
      </div>

      <div className="rounded-lg border p-6 bg-muted/30 space-y-3">
        <h2 className="font-medium">Org-Level Profile</h2>
        <p className="text-sm text-muted-foreground">
          Configure a shared config repo URL to inherit org-level gate defaults across all repositories.
          Available in the Workflow Gate Engine.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run all dashboard tests**

```bash
pnpm --filter @auto-claude/dashboard test
```
Expected: all pass

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/app/(dashboard)/command-center/page.tsx
git commit -m "feat(dashboard): add Command Center hub page"
```

---

## Task 13: Final integration check

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
```
Expected: dashboard tests all pass; daemon tests pass except for 2 pre-existing failing files (8 failures) that existed before this work. Verify no *new* failures appear beyond the pre-existing 8.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: no TypeScript errors

- [ ] **Step 3: Update traceability.yml**

Add new files to `packages/dashboard/` code_paths under STACK-AC-DASHBOARD, and record the new `packages/daemon/src/control-plane/remote-control.ts` file under its daemon spec. Open `.specify/traceability.yml` and add:

```yaml
# Under STACK-AC-DASHBOARD code_paths, add:
- packages/dashboard/components/claude-panel/claude-panel.tsx
- packages/dashboard/components/claude-panel/use-claude-panel.ts
- packages/dashboard/components/claude-panel/context-actions.ts
- packages/dashboard/app/(dashboard)/command-center/page.tsx
- packages/dashboard/app/(dashboard)/command-center/new-project/page.tsx
- packages/dashboard/actions/new-project.ts
- packages/dashboard/lib/github-api.ts
- packages/dashboard/lib/scaffold-templates.ts

# Under STACK-AC-DAEMON (or equivalent), add:
- packages/daemon/src/control-plane/remote-control.ts
```

- [ ] **Step 4: Final commit**

```bash
git add .specify/traceability.yml
git commit -m "chore(traceability): register command center frontend files"
```
