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

/** Test-only: reset registry between cases. */
export function __clearManagedProcessesForTests(): void {
  active.clear();
}
