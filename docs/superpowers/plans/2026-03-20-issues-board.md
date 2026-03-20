# Issues Board & Session Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 5-column read-only issues kanban at `/issues`, a Start/Restart Session button in the Claude Panel, and a Scan Now button that immediately triggers the daemon's work-detection loop.

**Architecture:** Three independent feature threads merged into one plan: (1) daemon-side `restart()` and `scanNow()` methods + new HTTP endpoints, (2) two Next.js API proxy routes and Claude Panel button, (3) server-component Issues page that fetches from GitHub API + a client IssuesBoard component with Scan Now. The daemon changes are pure TypeScript — no new dependencies. The dashboard additions follow the exact pattern of existing routes and components.

**Tech Stack:** TypeScript, Node.js (daemon), Next.js 16 App Router (dashboard), Vitest, @testing-library/react, Supabase JS, GitHub REST API via fetch, Lucide icons, shadcn/ui (existing components only — Button, Badge).

---

## File Map

### Daemon — modified (existing files)
- `packages/daemon/src/control-plane/remote-control.ts` — add `restart()` method
- `packages/daemon/src/control-plane/repo-manager.ts` — add `scanNow()` method
- `packages/daemon/src/control-plane/server.ts` — add `restartRemoteControl?` and `scanIssues?` to `ControlHandlers`; add two new POST routes
- `packages/daemon/src/control-plane/daemon.ts` — wire both handlers
- `packages/daemon/src/control-plane/remote-control.test.ts` — new tests for `restart()`
- `packages/daemon/src/control-plane/server.test.ts` — new tests for two new endpoints
- `packages/daemon/src/control-plane/repo-manager.test.ts` — new test for `scanNow()`

### Dashboard — new files
- `packages/dashboard/app/api/daemon/remote-control/restart/route.ts`
- `packages/dashboard/app/api/daemon/issues/scan/route.ts`
- `packages/dashboard/app/(dashboard)/issues/page.tsx`
- `packages/dashboard/components/issues-board.tsx`
- `packages/dashboard/lib/classify-issues.ts` — pure classification function (testable in isolation)
- `packages/dashboard/lib/classify-issues.test.ts`

### Dashboard — modified (existing files)
- `packages/dashboard/components/claude-panel/use-claude-panel.ts` — add `startSession()` + loading state
- `packages/dashboard/components/claude-panel/use-claude-panel.test.ts` — new tests
- `packages/dashboard/components/claude-panel/claude-panel.tsx` — render Start/Restart button
- `packages/dashboard/components/sidebar.tsx` — add Issues nav entry

---

## Task 1: `RemoteControlManager.restart()`

**Files:**
- Modify: `packages/daemon/src/control-plane/remote-control.ts`
- Modify: `packages/daemon/src/control-plane/remote-control.test.ts`

- [ ] **Step 1.1: Write the failing test**

Add to the bottom of the `describe('RemoteControlManager')` block in `remote-control.test.ts`:

```ts
it('restart() resets failure count and spawns a fresh process', async () => {
  let spawnCount = 0;
  vi.mocked(spawn).mockImplementation(() => {
    spawnCount++;
    const proc = makeFakeProcess();
    // First process exits with failure to drive failureCount up
    if (spawnCount === 1) setTimeout(() => proc.emit('exit', 1), 0);
    return proc;
  });

  manager.start();
  // Drive one failure to increment failureCount
  await vi.advanceTimersByTimeAsync(1); // exit fires
  await vi.advanceTimersByTimeAsync(5000); // backoff expires, spawns proc 2
  expect(spawnCount).toBe(2);

  // restart() should stop proc2 and spawn proc3 with a clean failure count
  manager.restart();
  expect(spawnCount).toBe(3);
  expect(manager.getState().remote_control_state).toBe('offline');

  // After restart the failure counter is reset — proc3 can fail 3 times before reaching 'failed'
  // Drive 3 failures from the fresh start
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(1);
    if (i < 2) await vi.advanceTimersByTimeAsync([5000, 15000][i]!);
  }
  expect(manager.getState().remote_control_state).toBe('failed');
});
```

- [ ] **Step 1.2: Run test to confirm it fails**

```bash
cd packages/daemon && pnpm test -- remote-control
```

Expected: FAIL — `manager.restart is not a function`

- [ ] **Step 1.3: Implement `restart()`**

In `remote-control.ts`, add after `stop()`:

```ts
restart(): void {
  // stop() sets this.stopped = true and kills any running process.
  // We must reset stopped before calling start() or start() will return early.
  void this.stop();
  this.stopped = false;
  this.failureCount = 0;
  this.spawn();
}
```

Note: `stop()` is `async` (waits for nothing but returns a Promise). `restart()` calls it fire-and-forget — the SIGTERM is sent synchronously; the process will exit shortly. The new `spawn()` call is intentionally immediate so the restart begins without waiting for the old process to die (consistent with how the daemon recovers from crashes).

- [ ] **Step 1.4: Run tests to confirm they pass**

```bash
cd packages/daemon && pnpm test -- remote-control
```

Expected: all tests PASS

- [ ] **Step 1.5: Commit**

```bash
git add packages/daemon/src/control-plane/remote-control.ts packages/daemon/src/control-plane/remote-control.test.ts
git commit -m "feat(daemon): add RemoteControlManager.restart()"
```

---

## Task 2: `RepoManager.scanNow()`

**Files:**
- Modify: `packages/daemon/src/control-plane/repo-manager.ts`
- Modify: `packages/daemon/src/control-plane/repo-manager.test.ts`

- [ ] **Step 2.1: Write the failing test**

Add to `repo-manager.test.ts` (after existing tests):

```ts
it('scanNow() immediately calls onPoll for all active pollers and returns count', async () => {
  const onPoll = vi.fn();
  const supabase = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockResolvedValue({
        data: [
          { id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: null, connection_id: null },
          { id: 'r2', owner: 'acme', name: 'api', poll_interval_ms: null, connection_id: null },
        ],
        error: null,
      }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
  } as any;

  const mgr = new RepoManager(supabase, 60_000, onPoll);
  await mgr.initialize();

  const result = await mgr.scanNow();
  expect(result.scanned).toBe(2);
  expect(onPoll).toHaveBeenCalledTimes(2);
  mgr.stop();
});

it('scanNow() skips pollers that are pendingDisable', async () => {
  const onPoll = vi.fn();
  const supabase = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockResolvedValue({
        data: [
          { id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: null, connection_id: null },
          { id: 'r2', owner: 'acme', name: 'api', poll_interval_ms: null, connection_id: null },
        ],
        error: null,
      }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
  } as any;

  const mgr = new RepoManager(supabase, 60_000, onPoll);
  await mgr.initialize();
  mgr.disablePoller('r1'); // marks pendingDisable (no active runs, so removes immediately)

  const result = await mgr.scanNow();
  expect(result.scanned).toBe(1);
  mgr.stop();
});
```

- [ ] **Step 2.2: Run tests to confirm they fail**

```bash
cd packages/daemon && pnpm test -- repo-manager
```

Expected: FAIL — `mgr.scanNow is not a function`

- [ ] **Step 2.3: Implement `scanNow()`**

In `repo-manager.ts`, add after `reload()`:

```ts
async scanNow(): Promise<{ scanned: number }> {
  let scanned = 0;
  for (const [repoId, entry] of this.pollers) {
    if (entry.pendingDisable) continue;
    // Resolve repo metadata for the onPoll callback.
    // We need owner/name — store them alongside the entry.
    // See note: pollers map must store owner/name; see Step 2.3b.
    this.onPoll(repoId, entry.owner, entry.name, entry.detector);
    scanned++;
  }
  return { scanned };
}
```

The `PollEntry` interface currently does not store `owner`/`name`. Add them:

```ts
interface PollEntry {
  detector: WorkDetector;
  intervalHandle: ReturnType<typeof setInterval>;
  activeRuns: number;
  pendingDisable: boolean;
  owner: string;   // add
  name: string;    // add
}
```

Update `startPoller()` to store them:

```ts
this.pollers.set(repo.id, {
  detector,
  intervalHandle,
  activeRuns: 0,
  pendingDisable: false,
  owner: repo.owner,  // add
  name: repo.name,    // add
});
```

- [ ] **Step 2.4: Run tests to confirm they pass**

```bash
cd packages/daemon && pnpm test -- repo-manager
```

Expected: all tests PASS

- [ ] **Step 2.5: Commit**

```bash
git add packages/daemon/src/control-plane/repo-manager.ts packages/daemon/src/control-plane/repo-manager.test.ts
git commit -m "feat(daemon): add RepoManager.scanNow()"
```

---

## Task 3: Daemon control server — new endpoints

**Files:**
- Modify: `packages/daemon/src/control-plane/server.ts`
- Modify: `packages/daemon/src/control-plane/server.test.ts`

- [ ] **Step 3.1: Write the failing tests**

Add to `server.test.ts` after the existing tests:

```ts
it('POST /remote-control/restart calls restartRemoteControl', async () => {
  const restarted = vi.fn();
  const { server, start } = createControlServer(PORT + 3, {
    ...handlers,
    restartRemoteControl: restarted,
  });
  const result = await start();
  expect(result.ok).toBe(true);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT + 3}/remote-control/restart`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restarted).toBe(true);
    expect(restarted).toHaveBeenCalledOnce();
  } finally {
    server.close();
  }
});

it('POST /remote-control/restart returns 501 when handler not wired', async () => {
  await startServer();
  const res = await fetch(`http://127.0.0.1:${PORT}/remote-control/restart`, { method: 'POST' });
  expect(res.status).toBe(501);
});

it('POST /issues/scan calls scanIssues and returns count', async () => {
  const { server, start } = createControlServer(PORT + 4, {
    ...handlers,
    scanIssues: async () => ({ scanned: 3 }),
  });
  const result = await start();
  expect(result.ok).toBe(true);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT + 4}/issues/scan`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanned).toBe(3);
  } finally {
    server.close();
  }
});

it('POST /issues/scan returns 501 when handler not wired', async () => {
  await startServer();
  const res = await fetch(`http://127.0.0.1:${PORT}/issues/scan`, { method: 'POST' });
  expect(res.status).toBe(501);
});
```

- [ ] **Step 3.2: Run tests to confirm they fail**

```bash
cd packages/daemon && pnpm test -- server
```

Expected: FAIL — 404 responses instead of 200/501

- [ ] **Step 3.3: Add handler types and routes to `server.ts`**

In `ControlHandlers`, add two optional fields:

```ts
export interface ControlHandlers {
  getStatus: () => unknown;
  pause: () => void;
  resume: () => void;
  retry: (issueNumber: number) => Result<void>;
  reloadRepos?: () => Promise<{ active: number }>;
  restartRemoteControl?: () => void;            // add
  scanIssues?: () => Promise<{ scanned: number }>; // add
}
```

In the `createServer` request handler, add two new branches before the final `else`:

```ts
} else if (method === 'POST' && url.pathname === '/remote-control/restart') {
  if (handlers.restartRemoteControl) {
    handlers.restartRemoteControl();
    json(res, 200, { restarted: true });
  } else {
    json(res, 501, { error: 'not configured' });
  }
} else if (method === 'POST' && url.pathname === '/issues/scan') {
  if (handlers.scanIssues) {
    handlers.scanIssues().then((result) => {
      json(res, 200, result);
    }).catch(() => {
      json(res, 500, { error: 'scan failed' });
    });
  } else {
    json(res, 501, { error: 'not configured' });
  }
} else {
```

- [ ] **Step 3.4: Run tests to confirm they pass**

```bash
cd packages/daemon && pnpm test -- server
```

Expected: all tests PASS

- [ ] **Step 3.5: Commit**

```bash
git add packages/daemon/src/control-plane/server.ts packages/daemon/src/control-plane/server.test.ts
git commit -m "feat(daemon): add /remote-control/restart and /issues/scan endpoints"
```

---

## Task 4: Wire daemon handlers + run daemon tests

**Files:**
- Modify: `packages/daemon/src/control-plane/daemon.ts`

- [ ] **Step 4.1: Wire the two new handlers in `daemon.ts`**

In the `createControlServer` call (around line 118), add both handlers to the handlers object:

```ts
const { server, start } = createControlServer(config.controlPort, {
  getStatus: () => ({
    activeRuns,
    dailyCost: costTracker.getDailyCost(),
    paused,
    uptime: process.uptime(),
    ...remoteControl.getState(),
  }),
  pause: () => { paused = true; },
  resume: () => { paused = false; },
  retry: (_issueNumber) => err(new Error('retry not yet implemented')),
  reloadRepos: repoManager
    ? async () => repoManager!.reload()
    : undefined,
  restartRemoteControl: () => { remoteControl.restart(); },    // add
  scanIssues: repoManager
    ? async () => repoManager!.scanNow()
    : undefined,                                               // add
});
```

- [ ] **Step 4.2: Run all daemon tests**

```bash
cd packages/daemon && pnpm test
```

Expected: all tests PASS

- [ ] **Step 4.3: Commit**

```bash
git add packages/daemon/src/control-plane/daemon.ts
git commit -m "feat(daemon): wire restartRemoteControl and scanIssues handlers"
```

---

## Task 5: Next.js API routes

**Files:**
- Create: `packages/dashboard/app/api/daemon/remote-control/restart/route.ts`
- Create: `packages/dashboard/app/api/daemon/issues/scan/route.ts`

These follow the exact same pattern as `pause/route.ts` and `repos-reload/route.ts`.

- [ ] **Step 5.1: Create `restart/route.ts`**

```ts
// packages/dashboard/app/api/daemon/remote-control/restart/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: member } = await supabase.from('team_members')
    .select('role').eq('user_id', user.id).single();
  if (member?.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const res = await fetch(`${process.env.DAEMON_URL}/remote-control/restart`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
```

- [ ] **Step 5.2: Create `scan/route.ts`**

```ts
// packages/dashboard/app/api/daemon/issues/scan/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: member } = await supabase.from('team_members')
    .select('role').eq('user_id', user.id).single();
  if (member?.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const res = await fetch(`${process.env.DAEMON_URL}/issues/scan`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
```

- [ ] **Step 5.3: Commit**

```bash
git add packages/dashboard/app/api/daemon/remote-control/restart/route.ts \
        packages/dashboard/app/api/daemon/issues/scan/route.ts
git commit -m "feat(dashboard): add API routes for remote-control/restart and issues/scan"
```

---

## Task 6: `useClaudePanel` + Claude Panel button

**Files:**
- Modify: `packages/dashboard/components/claude-panel/use-claude-panel.ts`
- Modify: `packages/dashboard/components/claude-panel/use-claude-panel.test.ts`
- Modify: `packages/dashboard/components/claude-panel/claude-panel.tsx`

- [ ] **Step 6.1: Write the failing tests**

Add to `use-claude-panel.test.ts` (after existing tests):

```ts
it('startSession() calls POST /api/daemon/remote-control/restart', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ remote_control_state: 'offline', remote_control_url: null }) } as Response)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ restarted: true }) } as Response);

  const { result } = renderHook(() => useClaudePanel());
  await act(async () => { await vi.advanceTimersByTimeAsync(100); }); // initial poll

  await act(async () => { await result.current.startSession(); });

  expect(fetch).toHaveBeenCalledWith('/api/daemon/remote-control/restart', { method: 'POST' });
});

it('startSession() sets isStarting=true while in flight, false after', async () => {
  let resolveRestart!: () => void;
  vi.mocked(fetch)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ remote_control_state: 'offline', remote_control_url: null }) } as Response)
    .mockImplementationOnce(() => new Promise<Response>((res) => {
      resolveRestart = () => res({ ok: true, json: async () => ({ restarted: true }) } as Response);
    }));

  const { result } = renderHook(() => useClaudePanel());
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });

  let startPromise!: Promise<void>;
  act(() => { startPromise = result.current.startSession(); });
  expect(result.current.isStarting).toBe(true);

  await act(async () => { resolveRestart(); await startPromise; });
  expect(result.current.isStarting).toBe(false);
});
```

- [ ] **Step 6.2: Run tests to confirm they fail**

```bash
cd packages/dashboard && pnpm test -- use-claude-panel
```

Expected: FAIL — `result.current.startSession is not a function`

- [ ] **Step 6.3: Implement `startSession()` in `use-claude-panel.ts`**

Add `isStarting` state and `startSession` callback alongside the existing state:

```ts
const [isStarting, setIsStarting] = useState(false);

const startSession = useCallback(async () => {
  setIsStarting(true);
  try {
    await fetch('/api/daemon/remote-control/restart', { method: 'POST' });
  } finally {
    setIsStarting(false);
  }
}, []);
```

Add both to the return value:

```ts
return { isOpen, toggle, sessionUrl, sessionState, startSession, isStarting };
```

Also export the updated return type — update the existing `RemoteControlState` type export (already exported) and ensure the hook signature is consistent.

- [ ] **Step 6.4: Run tests to confirm they pass**

```bash
cd packages/dashboard && pnpm test -- use-claude-panel
```

Expected: all tests PASS

- [ ] **Step 6.5: Add Start/Restart button to `claude-panel.tsx`**

In the expanded panel content, after the session URL block (around line 66), add the button:

```tsx
{sessionState !== 'active' && (
  <button
    onClick={startSession}
    disabled={isStarting}
    className="w-full text-left text-xs px-2 py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5
      data-[state=failed]:border-destructive data-[state=failed]:text-destructive
      data-[state=offline]:border-border data-[state=offline]:text-foreground
      hover:bg-accent"
    data-state={sessionState}
  >
    {isStarting
      ? 'Starting…'
      : sessionState === 'failed'
        ? '↺ Restart Session'
        : '▶ Start Session'}
  </button>
)}
```

Destructure `startSession` and `isStarting` from `useClaudePanel()` at the top of the component.

- [ ] **Step 6.6: Commit**

```bash
git add packages/dashboard/components/claude-panel/use-claude-panel.ts \
        packages/dashboard/components/claude-panel/use-claude-panel.test.ts \
        packages/dashboard/components/claude-panel/claude-panel.tsx
git commit -m "feat(dashboard): add Start/Restart Session button to Claude Panel"
```

---

## Task 7: Issue classification logic

**Files:**
- Create: `packages/dashboard/lib/classify-issues.ts`
- Create: `packages/dashboard/lib/classify-issues.test.ts`

This is a pure function — no HTTP, no Supabase. Test it thoroughly here so `issues/page.tsx` stays simple.

- [ ] **Step 7.1: Write the failing tests**

```ts
// packages/dashboard/lib/classify-issues.test.ts
import { describe, it, expect } from 'vitest';
import { classifyIssues, type GitHubIssue, type RunRecord } from './classify-issues';

function issue(number: number, labels: string[] = []): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/owner/repo/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    state: 'open',
  };
}

function run(issueNumber: number, outcome: RunRecord['outcome'], phase?: string): RunRecord {
  return {
    issue_number: issueNumber,
    repo_owner: 'owner',
    repo_name: 'repo',
    issue_title: `Issue ${issueNumber}`,
    outcome,
    current_phase: phase ?? null,
  };
}

const REPO = { owner: 'owner', name: 'repo' };

describe('classifyIssues', () => {
  it('classifies unlabelled issue as not-ready', () => {
    const cards = classifyIssues([{ ...REPO, issues: [issue(1)] }], []);
    expect(cards[0]?.column).toBe('not-ready');
  });

  it('classifies issue with ready label as ready', () => {
    const cards = classifyIssues([{ ...REPO, issues: [issue(1, ['ready'])] }], []);
    expect(cards[0]?.column).toBe('ready');
  });

  it('classifies issue with in-progress label as running', () => {
    const cards = classifyIssues([{ ...REPO, issues: [issue(1, ['in-progress'])] }], []);
    expect(cards[0]?.column).toBe('running');
  });

  it('classifies issue with stuck label as stuck', () => {
    const cards = classifyIssues([{ ...REPO, issues: [issue(1, ['stuck'])] }], []);
    expect(cards[0]?.column).toBe('stuck');
  });

  it('DB in-progress run takes priority over ready label', () => {
    const cards = classifyIssues(
      [{ ...REPO, issues: [issue(1, ['ready'])] }],
      [run(1, 'in-progress', 'planning')],
    );
    expect(cards[0]?.column).toBe('running');
    expect(cards[0]?.currentPhase).toBe('planning');
  });

  it('complete runs appear as cards even though the issue is closed (not in GitHub list)', () => {
    const cards = classifyIssues(
      [{ ...REPO, issues: [] }], // GitHub API returns no open issues
      [run(7, 'complete')],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.column).toBe('complete');
    expect(cards[0]?.issueNumber).toBe(7);
  });

  it('aggregates issues from multiple repos', () => {
    const cards = classifyIssues(
      [
        { owner: 'o1', name: 'r1', issues: [issue(1)] },
        { owner: 'o2', name: 'r2', issues: [issue(2, ['ready'])] },
      ],
      [],
    );
    expect(cards).toHaveLength(2);
    const cols = cards.map((c) => c.column);
    expect(cols).toContain('not-ready');
    expect(cols).toContain('ready');
  });
});
```

- [ ] **Step 7.2: Run tests to confirm they fail**

```bash
cd packages/dashboard && pnpm test -- classify-issues
```

Expected: FAIL — module not found

- [ ] **Step 7.3: Implement `classify-issues.ts`**

```ts
// packages/dashboard/lib/classify-issues.ts

export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  labels: Array<{ name: string }>;
  state: string;
}

export interface RunRecord {
  issue_number: number;
  repo_owner: string;
  repo_name: string;
  issue_title: string;
  outcome: 'in-progress' | 'complete' | 'stuck' | 'escalated';
  current_phase: string | null;
}

export type BoardColumn = 'not-ready' | 'ready' | 'running' | 'complete' | 'stuck';

export interface BoardCard {
  column: BoardColumn;
  issueNumber: number;
  issueTitle: string;
  repoOwner: string;
  repoName: string;
  issueUrl: string;
  labels: string[];
  currentPhase: string | null;
}

export function classifyIssues(
  repos: Array<{ owner: string; name: string; issues: GitHubIssue[] }>,
  runs: RunRecord[],
): BoardCard[] {
  const cards: BoardCard[] = [];

  // Index runs by "owner/name#number" for O(1) lookup
  const runIndex = new Map<string, RunRecord>();
  for (const run of runs) {
    runIndex.set(`${run.repo_owner}/${run.repo_name}#${run.issue_number}`, run);
  }

  // Classify open GitHub issues
  for (const repo of repos) {
    for (const issue of repo.issues) {
      const key = `${repo.owner}/${repo.name}#${issue.number}`;
      const run = runIndex.get(key);
      const labelNames = issue.labels.map((l) => l.name);

      let column: BoardColumn;
      let currentPhase: string | null = null;

      if (run?.outcome === 'in-progress' || labelNames.includes('in-progress')) {
        column = 'running';
        currentPhase = run?.current_phase ?? null;
      } else if (run?.outcome === 'stuck' || labelNames.includes('stuck')) {
        column = 'stuck';
      } else if (labelNames.includes('ready')) {
        column = 'ready';
      } else {
        column = 'not-ready';
      }

      cards.push({
        column,
        issueNumber: issue.number,
        issueTitle: issue.title,
        repoOwner: repo.owner,
        repoName: repo.name,
        issueUrl: issue.html_url,
        labels: labelNames,
        currentPhase,
      });
    }
  }

  // Add complete cards from DB runs (issues are closed on GitHub — not in the API response)
  for (const run of runs) {
    if (run.outcome !== 'complete') continue;
    const key = `${run.repo_owner}/${run.repo_name}#${run.issue_number}`;
    // Only add if this issue wasn't already classified from GitHub (shouldn't happen — closed issues
    // don't appear in state=open, but guard against double-counting)
    const alreadyAdded = cards.some(
      (c) => c.repoOwner === run.repo_owner && c.repoName === run.repo_name && c.issueNumber === run.issue_number,
    );
    if (!alreadyAdded) {
      cards.push({
        column: 'complete',
        issueNumber: run.issue_number,
        issueTitle: run.issue_title,
        repoOwner: run.repo_owner,
        repoName: run.repo_name,
        issueUrl: `https://github.com/${run.repo_owner}/${run.repo_name}/issues/${run.issue_number}`,
        labels: [],
        currentPhase: null,
      });
    }
  }

  return cards;
}
```

- [ ] **Step 7.4: Run tests to confirm they pass**

```bash
cd packages/dashboard && pnpm test -- classify-issues
```

Expected: all tests PASS

- [ ] **Step 7.5: Commit**

```bash
git add packages/dashboard/lib/classify-issues.ts packages/dashboard/lib/classify-issues.test.ts
git commit -m "feat(dashboard): add classifyIssues pure function"
```

---

## Task 8: Issues page server component + sidebar nav

**Files:**
- Create: `packages/dashboard/app/(dashboard)/issues/page.tsx`
- Modify: `packages/dashboard/components/sidebar.tsx`

- [ ] **Step 8.1: Add "Issues" to the sidebar nav**

In `sidebar.tsx`, import `CircleDot` from lucide-react and add the nav entry after Runs (between Runs and Command Center — Repos sits above Runs in the current sidebar):

```ts
import { LayoutDashboard, GitFork, Activity, CircleDot, DollarSign, Users, Settings, Terminal, Zap, LogOut } from 'lucide-react';

const nav = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/repos', label: 'Repositories', icon: GitFork },
  { href: '/runs', label: 'Runs', icon: Activity },
  { href: '/issues', label: 'Issues', icon: CircleDot },   // add
  { href: '/command-center', label: 'Command Center', icon: Zap },
  { href: '/cost', label: 'Costs', icon: DollarSign },
  { href: '/team', label: 'Team', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
];
```

- [ ] **Step 8.2: Create the Issues page server component**

```tsx
// packages/dashboard/app/(dashboard)/issues/page.tsx
import { createClient } from '@/lib/supabase/server';
import { classifyIssues, type RunRecord, type GitHubIssue } from '@/lib/classify-issues';
import { IssuesBoard } from '@/components/issues-board';

export const dynamic = 'force-dynamic';

interface RepoRow {
  id: string;
  owner: string;
  name: string;
  connection_id: string | null;
}

async function fetchIssuesForRepo(
  owner: string,
  name: string,
  token: string | undefined,
): Promise<{ issues: GitHubIssue[]; error: string | null }> {
  if (!token) return { issues: [], error: `No GitHub token for ${owner}/${name}` };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${name}/issues?state=open&per_page=100`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        next: { revalidate: 0 },
      },
    );
    if (!res.ok) return { issues: [], error: `GitHub API error ${res.status} for ${owner}/${name}` };
    const data = await res.json() as GitHubIssue[];
    // GitHub issues endpoint returns PRs too — filter them out
    return { issues: data.filter((i) => !('pull_request' in i)), error: null };
  } catch {
    return { issues: [], error: `Failed to fetch issues for ${owner}/${name}` };
  }
}

export default async function IssuesPage() {
  const supabase = await createClient();

  const [{ data: repos }, { data: runs }] = await Promise.all([
    supabase.from('repos').select('id, owner, name, connection_id').eq('enabled', true).is('deleted_at', null),
    supabase.from('runs').select('issue_number, repo_owner, repo_name, issue_title, outcome, current_phase').order('started_at', { ascending: false }).limit(200),
  ]);

  const repoList = (repos ?? []) as RepoRow[];
  const runList = (runs ?? []) as RunRecord[];

  // Fetch token + issues per repo in parallel
  const repoIssueResults = await Promise.all(
    repoList.map(async (repo) => {
      let token: string | undefined;
      if (repo.connection_id) {
        const { data } = await supabase.rpc('decrypt_github_token', { p_connection_id: repo.connection_id });
        token = (data as string | null) ?? process.env.GITHUB_TOKEN;
      } else {
        token = process.env.GITHUB_TOKEN;
      }
      const { issues, error } = await fetchIssuesForRepo(repo.owner, repo.name, token);
      return { owner: repo.owner, name: repo.name, issues, error };
    }),
  );

  const fetchErrors = repoIssueResults.filter((r) => r.error !== null).map((r) => r.error!);
  const repoIssues = repoIssueResults.map(({ owner, name, issues }) => ({ owner, name, issues }));
  const cards = classifyIssues(repoIssues, runList);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Issues</h1>
        <p className="text-muted-foreground text-sm">
          Open issues across {repoList.length} enabled {repoList.length === 1 ? 'repo' : 'repos'}
        </p>
      </div>
      {fetchErrors.length > 0 && (
        <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive space-y-1">
          {fetchErrors.map((e) => <p key={e}>{e}</p>)}
        </div>
      )}
      <IssuesBoard cards={cards} />
    </div>
  );
}
```

- [ ] **Step 8.3: Commit**

```bash
git add packages/dashboard/app/\(dashboard\)/issues/page.tsx \
        packages/dashboard/components/sidebar.tsx
git commit -m "feat(dashboard): add Issues page server component and sidebar nav entry"
```

---

## Task 9: IssuesBoard client component

**Files:**
- Create: `packages/dashboard/components/issues-board.tsx`

- [ ] **Step 9.1: Create `issues-board.tsx`**

```tsx
// packages/dashboard/components/issues-board.tsx
'use client';
import { useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { BoardCard, BoardColumn } from '@/lib/classify-issues';

const COLUMNS: { id: BoardColumn; label: string; countColor: string }[] = [
  { id: 'not-ready', label: 'Not Ready', countColor: 'text-muted-foreground' },
  { id: 'ready',     label: 'Ready',     countColor: 'text-green-500' },
  { id: 'running',   label: 'Running',   countColor: 'text-blue-400' },
  { id: 'complete',  label: 'Complete',  countColor: 'text-muted-foreground' },
  { id: 'stuck',     label: 'Stuck',     countColor: 'text-destructive' },
];

const COLUMN_BORDER: Record<BoardColumn, string> = {
  'not-ready': 'border-l-destructive',
  'ready':     'border-l-green-500',
  'running':   'border-l-blue-400',
  'complete':  'border-l-purple-500',
  'stuck':     'border-l-destructive',
};

function IssueCard({ card }: { card: BoardCard }) {
  return (
    <div className={`bg-background rounded-md p-3 border-l-2 ${COLUMN_BORDER[card.column]} space-y-2`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-muted-foreground font-mono">
          #{card.issueNumber} · {card.repoOwner}/{card.repoName}
        </span>
        <a
          href={card.issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline shrink-0"
        >
          ↗
        </a>
      </div>
      <p className="text-xs font-medium leading-snug">{card.issueTitle}</p>
      {card.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {card.labels.map((l) => (
            <Badge key={l} variant="outline" className="text-[10px] px-1.5 py-0">{l}</Badge>
          ))}
        </div>
      )}
      {card.column === 'not-ready' && (
        <div className="border-t border-border pt-2 text-[10px] text-muted-foreground">
          Missing: <Badge variant="secondary" className="text-[10px] px-1.5 py-0">ready</Badge>
          <span className="ml-1">— add in GitHub to queue</span>
        </div>
      )}
      {card.column === 'ready' && (
        <p className="text-[10px] text-green-500">Queued for pickup</p>
      )}
      {card.column === 'running' && card.currentPhase && (
        <div className="flex items-center gap-1.5 text-[10px] text-blue-400">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 inline-block" />
          {card.currentPhase}
        </div>
      )}
      {card.column === 'stuck' && (
        <p className="text-[10px] text-destructive">✗ stuck — needs attention</p>
      )}
    </div>
  );
}

interface IssuesBoardProps {
  cards: BoardCard[];
}

export function IssuesBoard({ cards }: IssuesBoardProps) {
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);

  const scanNow = useCallback(async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await fetch('/api/daemon/issues/scan', { method: 'POST' });
      const data = await res.json() as { scanned?: number; error?: string };
      if (res.ok) {
        setScanResult(`Scanned ${data.scanned ?? 0} repos`);
        setTimeout(() => setScanResult(null), 3000);
      } else {
        setScanResult(data.error ?? 'Error');
        setTimeout(() => setScanResult(null), 3000);
      }
    } catch {
      setScanResult('Daemon unreachable');
      setTimeout(() => setScanResult(null), 3000);
    } finally {
      setScanning(false);
    }
  }, []);

  return (
    <div className="space-y-4">
      {/* Scan Now header action */}
      <div className="flex items-center justify-end gap-3">
        {scanResult && <span className="text-xs text-muted-foreground">{scanResult}</span>}
        <Button variant="outline" size="sm" onClick={scanNow} disabled={scanning}>
          {scanning ? 'Scanning…' : '⟳ Scan Now'}
        </Button>
      </div>

      {/* 5-column kanban */}
      <div className="grid grid-cols-5 gap-3 min-h-[400px]">
        {COLUMNS.map(({ id, label, countColor }) => {
          const colCards = cards.filter((c) => c.column === id);
          return (
            <div key={id} className="bg-muted/30 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {label}
                </span>
                <span className={`text-[10px] font-semibold ${countColor}`}>
                  {colCards.length}
                </span>
              </div>
              {colCards.length === 0 ? (
                <p className="text-[10px] text-muted-foreground italic pt-2">None</p>
              ) : (
                colCards.map((card) => (
                  <IssueCard key={`${card.repoOwner}/${card.repoName}#${card.issueNumber}`} card={card} />
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 9.2: Run all dashboard tests to confirm nothing broke**

```bash
cd packages/dashboard && pnpm test
```

Expected: all tests PASS

- [ ] **Step 9.3: Commit**

```bash
git add packages/dashboard/components/issues-board.tsx
git commit -m "feat(dashboard): add IssuesBoard client component with Scan Now button"
```

---

## Task 10: Full integration check

- [ ] **Step 10.1: Run all tests across the monorepo**

```bash
cd ~/code/auto-claude && pnpm --filter daemon test && pnpm --filter dashboard test
```

Expected: all tests PASS

- [ ] **Step 10.2: Build the dashboard to catch any TypeScript errors**

```bash
cd packages/dashboard && pnpm build
```

Expected: build succeeds with no type errors

- [ ] **Step 10.3: Commit final status (if any fixups needed)**

If any fixup changes were made in steps 10.1–10.2:

```bash
git add -p  # stage only the fixup changes
git commit -m "fix: address build/type issues from integration check"
```
