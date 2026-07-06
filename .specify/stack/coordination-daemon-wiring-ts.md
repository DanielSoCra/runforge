---
id: STACK-AC-COORDINATION-DAEMON-WIRING
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-COORDINATION
code_paths:
  - packages/daemon/src/control-plane/daemon.ts
  - packages/daemon/src/coordination/coordinator.ts
test_paths:
  - packages/daemon/src/control-plane/daemon.test.ts
  - packages/daemon/src/coordination/coordinator.test.ts
---

# STACK-AC-COORDINATION-DAEMON-WIRING — Coordinator Daemon Integration (TypeScript)

## Pattern

**Coordinator instantiation during daemon startup.** The daemon's `startDaemon` function instantiates the Coordinator via `createCoordinator()` after all services are initialized (SessionRuntime, StateManager, CostTracker) but before the polling loop starts. The Coordinator receives injected dependencies — it does not construct its own services. The daemon owns the lifecycle: `coordinator.start()` returns a stop function called during shutdown.

**Dependency assembly in daemon.ts.** The daemon constructs `CoordinatorDeps` by wiring existing services into the required interface. `spawnWorker` delegates to `SessionRuntime.spawnSession`. `checkDiskSpace` uses `fs.statfs()`. `isPaused` and `isShuttingDown` close over the daemon's existing `paused` and `shuttingDown` flags. `getDispatchQueue` wraps the existing work detection logic (ready work, bug-fix work, feature-pipeline work) into the `DispatchQueueItem[]` format the Coordinator consumes. `getActiveClaimRepoKeys` reads active claims from the WorkClaimer and maps them to repo keys for per-repo limit enforcement.

**Replace direct poll loop with Coordinator tick.** The existing `setInterval` poll loop in daemon.ts (both DB-mode RepoManager callback and legacy poller) that calls `detectReadyWork` → `processWorkRequest` is replaced by the Coordinator's tick-driven dispatch. The Coordinator's tick calls `getDispatchQueue` (which internally calls the same work detectors), runs the concurrency algorithm, claims work via WorkClaimer, and spawns workers via `spawnWorker`. The `processWorkRequest` function remains — it is called by `spawnWorker` after the Coordinator decides to dispatch.

**PO and TL as pooled agents.** The existing standalone `createPOAgent` and `createTechLeadScheduler` are wired into the Coordinator's agent pool as `po` and `tech_lead` agent types. Their per-type minimums (min 1, max 1 each per ARCH-AC-COORDINATION) are enforced by the concurrency algorithm. The existing standalone schedulers stop managing their own intervals — the Coordinator's tick triggers them when a slot is available and their schedule is due.

**CoordinatorConfig from existing config.** The `CoordinatorConfig` values are sourced from the daemon's existing `Config` and `GlobalSettings`: `tickIntervalMs` from a new `coordination.tickInterval` config field (default 5000), `maxAgents` from `coordination.maxAgents` (falling back to `maxConcurrentRuns`), `diskSpaceThreshold` from `coordination.diskSpaceThreshold` (default 2 GB), `perRepoLimits` from per-repo configuration in SupabaseConfigReader.

**Merge Agent lifecycle under Coordinator.** The Coordinator starts the Merge Agent via `deps.mergeAgent.start()` on its own startup and restarts it on unexpected exit (unless paused or shutting down). The daemon does not manage the Merge Agent directly — it is infrastructure supervised by the Coordinator (per ARCH-AC-COORDINATION: "runs outside the pool").

**Daemon restart recovery through Coordinator.** On startup, the Coordinator scans `state/coordination/claims/` for active claims and reconciles with running processes (per STACK-AC-COORDINATION). The daemon's existing `stateMgr.findIncompleteRuns()` crash resumption coexists during migration — incomplete runs from before the Coordinator was wired continue through the legacy path. New work always flows through the Coordinator.

### l3 Feedback Round-Trip and Cross-Phase Loop Cap

`run.l3Feedback` carries compliance findings from the `l3-compliance`
phase back into the next `l3-generate` invocation, mirroring the
`l2Feedback` pattern but driven by an autonomous gate rather than a
human label.

The transition `l3-compliance.failure → l3-generate` is cross-phase and
is therefore not counted by the self-loop retry mechanism in
`pipeline.ts`. A separate counter `run.l3ComplianceAttempts` is
incremented on **every** failure path — `compliant === false`, session
error, session timeout. When the counter reaches
`MAX_L3_COMPLIANCE_ATTEMPTS` (default 3), the phase emits `'escalated'`,
which the spec variant routes to `stuck`. The counter is cleared on the
next compliance success.

A general cross-phase feedback-loop counter in `pipeline.ts` is the right
long-term solution; a follow-up issue tracks that work. The per-loop
counter here is intentionally narrow.

## Key Decisions

**Gradual migration, not big-bang replacement.** The legacy poll loop and the Coordinator can coexist during rollout. A feature flag (`coordination.useCoordinator`, default `false`) gates whether the Coordinator is instantiated and the legacy poll loop is skipped. When enabled, the Coordinator owns all dispatch decisions. When disabled, the existing behavior is unchanged. This prevents a risky all-at-once cutover.

**PO/TL scheduling moves into the Coordinator tick.** Rather than running independent `setInterval` schedulers, the PO and TL agents are spawned by the Coordinator's concurrency algorithm when: (a) their minimum count is not met in the active pool, (b) their schedule interval has elapsed, and (c) a pool slot is available. The existing `createPOAgent` and `createTechLeadScheduler` become spawn functions called by the Coordinator, not self-scheduling loops.

**processWorkRequest stays as-is.** The existing `processWorkRequest` function (pipeline FSM, phase handlers, state tracking) is not refactored. The Coordinator's `spawnWorker` callback calls it. This preserves the existing pipeline behavior while adding Coordinator-mediated dispatch above it.

**handleRunOutcome wired through Coordinator.** The daemon's `handleRunOutcome` (auto-pause on budget/stuck) is called when `spawnWorker`'s promise resolves. The Coordinator does not own outcome handling — it delegates to the daemon's existing logic. The Coordinator tracks claim status; the daemon tracks operational responses (pause, notify).

**Reviewer stays on its own scheduler initially.** The review scheduler has a different cadence (long interval, signal-ratio throttling) that doesn't map cleanly to the tick-driven pool model. It is wired into the pool for concurrency accounting (counts against `maxAgents`) but retains its own interval trigger. Full integration into the Coordinator tick is deferred.

## Examples

```typescript
// Coordinator instantiation — deps wired from existing daemon services
const coordinator = createCoordinator({
  workClaimer, batchManager, mergeAgent,
  spawnWorker, checkDiskSpace,
  isPaused: () => paused, isShuttingDown: () => shuttingDown,
}, coordinatorConfig);
```

```typescript
// Feature flag gating legacy vs coordinator path
if (config.coordination.useCoordinator) {
  const stopCoordinator = coordinator.start();
  // legacy poller is NOT started
} else {
  // existing setInterval poll loop
}
```

```typescript
// PO/TL as pooled agent types in concurrency config
const agentMinimums = { po: 1, tech_lead: 1, worker: 1, reviewer: 1 };
const agentMaximums = { po: 1, tech_lead: 1, worker: Infinity, reviewer: 1 };
```

```typescript
// Coordinator shutdown in daemon's shutdown handler
const shutdown = async () => {
  shuttingDown = true;
  stopCoordinator(); // stops tick, merge agent
  // ... existing cleanup
};
```

## Gotchas

- The `activeRuns` counter in daemon.ts and the Coordinator's claim-based count must stay in sync during migration. When the Coordinator is enabled, `activeRuns` should be derived from active claims, not independently incremented. A mismatch causes concurrency limit violations.
- The Coordinator's `spawnWorker` is async and may fail (e.g., runtime error, worktree creation failure). The Coordinator must handle spawn failures gracefully — mark the claim as `failed` and continue to the next decision. Do not let a single spawn failure abort the tick.
- Per-repo limits from `SupabaseConfigReader` are dynamic (updated via config reload). The Coordinator must read them fresh on each tick, not cache them at startup.
- The `checkDiskSpace` implementation uses `fs.statfs()` which requires Node 22+. The daemon's minimum Node version must be verified.
- When the feature flag is off, the Coordinator is not instantiated at all — no tick, no merge agent, no pool evaluation. All existing behavior is preserved exactly.
- The Merge Agent's crash handler (`onMergeAgentCrash`) must be registered before `coordinator.start()` is called, since the merge agent starts immediately on `start()`.
