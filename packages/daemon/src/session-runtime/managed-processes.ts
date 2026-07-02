// src/session-runtime/managed-processes.ts
//
// Shared registry of in-flight child processes spawned by the provider adapters
// (CliAdapter, CodexCliAdapter). It exists so an operator FORCE-KILL path
// (daemon SIGUSR2 handler) can terminate every active `claude`/`codex` worker —
// and its tool subprocesses — within seconds, instead of waiting for drain.
//
// Why a module-level registry (not adapter-instance state):
//   - There are multiple adapter classes, and provider fallback creates a fresh
//     adapter per attempt (runtime.ts spawnWithProviderFallback). An
//     instance-local set would miss processes. A single shared registry is the
//     one place the control plane can reach without threading proc handles
//     through every call layer.
//
// Why process GROUPS (negative pid) instead of proc.kill():
//   - The CLIs spawn their own grandchildren (Bash tool subprocesses, MCP
//     servers). Killing only the direct child can orphan those. Adapters spawn
//     with `detached: true` so each child is a process-group leader; sending the
//     signal to `-pid` reaches the whole group.

import type { ChildProcess } from 'child_process';

const active = new Set<ChildProcess>();

/**
 * Register a freshly-spawned child. Call immediately after `spawn()`. Idempotent.
 */
export function registerManagedProcess(child: ChildProcess): void {
  active.add(child);
}

/**
 * Unregister a child once it has exited. Call from the adapter's
 * close/exit/error handlers. `Set.delete` is idempotent, so racing with a
 * kill sweep is safe.
 */
export function unregisterManagedProcess(child: ChildProcess): void {
  active.delete(child);
}

/** Number of currently-tracked child processes (test/observability helper). */
export function managedProcessCount(): number {
  return active.size;
}

/**
 * Send `signal` to the PROCESS GROUP of a single child (negative pid). Used by
 * the adapter timeout path so SIGTERM/SIGKILL reaches the CLI's tool
 * subprocesses, not just the CLI. Never throws (ESRCH/EPERM swallowed) and
 * no-ops if the child has no pid. Returns true if a signal was delivered.
 */
export function killProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGKILL',
): boolean {
  const pid = child.pid;
  if (pid === undefined || pid === null) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send `signal` to the PROCESS GROUP of every registered child, then clear the
 * registry. Returns the count of groups signalled.
 *
 * Reliability contract for the operator force-kill path:
 *   - Never throws. ESRCH (already gone) / EPERM are swallowed — a kill sweep
 *     must not fail because one child raced to exit.
 *   - Children without a pid (never spawned / already reaped) are skipped.
 *   - The registry is cleared afterwards so a second sweep is a clean no-op.
 */
export function killAllManagedProcessGroups(
  signal: NodeJS.Signals = 'SIGKILL',
): number {
  let killed = 0;
  for (const child of active) {
    const pid = child.pid;
    if (pid === undefined || pid === null) continue;
    try {
      // Negative pid → deliver to the whole process group (detached children
      // are group leaders, so this reaps their tool subprocesses too).
      process.kill(-pid, signal);
      killed += 1;
    } catch {
      // ESRCH/EPERM: the child (or its group) is already gone. Best-effort —
      // never block the operator kill on a racing exit.
    }
  }
  active.clear();
  return killed;
}

/**
 * Escalating termination: SIGTERM every registered process group, wait `graceMs`
 * (default 5000ms), then SIGKILL any survivors, and ONLY THEN clear the registry.
 * Returns the count of processes that exited gracefully after SIGTERM and the
 * count that required SIGKILL escalation.
 *
 * Idempotent: a second call on an already-empty registry resolves immediately
 * with `{ terminated: 0, escalated: 0 }`. The registry is never cleared before
 * the escalation pass — that would orphan survivors.
 */
export async function terminateAllManagedProcessGroups(
  opts: { graceMs?: number } = {},
): Promise<{ terminated: number; escalated: number }> {
  const graceMs = opts.graceMs ?? 5000;
  const targets = [...active];

  if (targets.length === 0) {
    return { terminated: 0, escalated: 0 };
  }

  // Phase 1: SIGTERM sweep.
  for (const child of targets) {
    killProcessGroup(child, 'SIGTERM');
  }

  // Phase 2: wait for graceful exits up to graceMs.
  let terminated = 0;
  const pending = new Set(targets);
  const start = Date.now();
  while (pending.size > 0 && Date.now() - start < graceMs) {
    for (const child of [...pending]) {
      if (child.exitCode !== null || child.signalCode !== null) {
        terminated += 1;
        pending.delete(child);
      }
    }
    if (pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // Phase 3: SIGKILL survivors.
  for (const child of pending) {
    killProcessGroup(child, 'SIGKILL');
  }

  // Phase 4: brief bounded wait for SIGKILL to take effect.
  let escalated = 0;
  const killStart = Date.now();
  while (pending.size > 0 && Date.now() - killStart < 2000) {
    for (const child of [...pending]) {
      if (child.exitCode !== null || child.signalCode !== null) {
        escalated += 1;
        pending.delete(child);
      }
    }
    if (pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // Phase 5: clear registry only after escalation — never before, and only the
  // swept targets. A child registered during the grace/kill window must remain
  // tracked so a subsequent /halt or force-kill can still reach it.
  for (const child of targets) active.delete(child);
  return { terminated, escalated };
}

/** Test-only: reset registry between cases. */
export function __clearManagedProcessesForTests(): void {
  active.clear();
}
