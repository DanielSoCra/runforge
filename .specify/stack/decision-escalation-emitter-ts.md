---
id: STACK-AC-DECISION-ESCALATION-EMITTER
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-DECISION-ESCALATION
code_paths:
  - packages/daemon/src/control-plane/decision-escalation/
test_paths:
  - packages/daemon/src/control-plane/decision-escalation/**/*.test.ts
---

# STACK-AC-DECISION-ESCALATION-EMITTER — Daemon Control-Plane Emitter (TypeScript)

## Pattern

**The Control Plane is the single writer; the emitter is a thin adapter over the folded `decision-index`.** When a Worker run reaches a pause it cannot pass, the Control Plane calls the index writer to `raise` a `DecisionRequest`, then parks the run via the existing checkpoint mechanism. The steering surface submits the answer through the index; the Control Plane reads it and dispatches **resume** (`mid_run`) or **requeue** through adapters. On daemon boot, a single `reconcile()` completes any in-flight write/resume/requeue exactly once — the same two-phase-outbox recovery the store provides, invoked from startup.

This reuses the daemon's existing control-plane primitives (`fsm.ts`, `checkpoint.ts`, `failure-routing.ts`) rather than introducing a parallel pause mechanism: a decision pause is one more checkpoint reason, and the emitter supplies the `Notifier` / `ResumeDispatcher` / `SourceSink` adapters the index expects.

## Key Decisions

- **Boot-time reconcile wired into daemon startup** (`main.ts` → control-plane init) — the prior process's `executing` rows are always older than the claim-lease at boot, so recovery is unconditional and safe.
- **Resume mode chosen at answer time** — `mid_run` if the worker session is still alive (resume from the exact pause), else `requeue` (restart the work carrying the answer, and tell the Operator partial work may repeat). Reuse `RESUME_MODES` from the protocol.
- **Adapters, not new transport** — `ResumeDispatcher` re-enters the paused run; `Notifier` emits shared-form-only notifications; `SourceSink` writes the answer back. The emitter owns these implementations; the index owns the lifecycle.
- **Legacy human-required pauses convert once** — a one-time migration turns an old free-form `human-required` note into a `detected` DecisionRequest so it is read and answered like the rest.
- **Merge-governed boot guard (first-use safety, A1)** — `DecisionIndexManager` distinguishes `isEnabled()` (the configured flag) from `isAvailable()` (`enabled && !broken && ledger built`). At `startDaemon`, immediately after deployment registration, a *configured* deployment (`config.deployment !== undefined`) that either fails registration or has `!decisionManager.isAvailable()` aborts boot via the existing `return err(...)` path (mirroring the sanitizer fail-closed), with a message distinguishing **disabled** (`!isEnabled()` → "set `RUNFORGE_DECISION_INDEX_ENABLED=1`") from **enabled-but-unreachable** (`isEnabled() && !isAvailable()` → "decision index unreachable"). A non-governed daemon boots unchanged with the index disabled.
- **Runtime-degraded marker (governed-only marking policy)** — `DecisionIndexManager` carries a `#runtimeDegraded` flag (`markRuntimeDegraded`/`clearRuntimeDegraded`/`isRuntimeDegraded`), independent of `#enabled`/`#broken`. Helper functions `withGovernedDecisionMarking(manager, deploymentId, fn)` / `markRuntimeDegradedIfGoverned` / `clearRuntimeDegradedIfGoverned` apply the policy at **every** approval-path ledger site for a governed run only: the integrate floor-miss and publish (`phases.ts`), and resume `statusOf`/`answer`/`advanceToResumed` plus the per-tick `reconcile`/`expireOverdue` sweep (`daemon.ts`). The existing fail-closed control flow (return `'failure'` / stay parked) is unchanged — marking is a side-effect only. The marker is cleared exclusively by a successful governed **decision-index** op that proves the approval transport recovered — a successful `raise`+`notify` in the publish block, or a successful `advanceToResumed` in resume. A successful Git **merge** does NOT clear it (a merge never touches the ledger, and an approved auto-merge could otherwise erase a real `advanceToResumed` failure that left the run merge-armed while the transport was still broken); neither does a non-governed or l2-gate op.
- **Minimal /health + /status surfacing** — the marker is not inert: `getStatus()` exposes `isGoverned` (a deployment profile is configured) + `isRuntimeDegraded` on `/status`, and the real control server's `/health` (`server.ts`) returns HTTP **503** `{ ok:false, degraded:true, reason:'decision-index-unavailable' }` for a **governed** daemon when the marker is set **or** the index is `isEnabled() && !isAvailable()`. A non-governed (or governed-and-healthy) daemon keeps the legacy `200 { ok:true, degraded:false }` byte-for-byte — a non-governed daemon's index state never affects `/health`. The degraded-boot server (`degraded-server.ts`) is unchanged. The FULL `/health` mapping (stuck / watchdog / `pauseReason`) is deferred to ARCH-AC-OPERATIONAL-SAFETY (PR2 / T2.6); only this governed decision-index signal lands in PR1.

## Examples

```ts
// raise at a pause, then park — the index owns the lifecycle, the control plane owns the run
const decisionId = await index.raise({ runRef, question, context, choices, recommended,
  consequence, reversibility, deadline, sensitivity });
await checkpoint.park(runRef, { reason: "decision", decisionId });

// boot recovery: complete any in-flight write/resume/requeue exactly once
await outbox.reconcile();   // re-claims only claims older than claimLeaseMs

// resume mode is a function of session liveness
const mode: ResumeMode = workerSession.isAlive(runRef) ? "mid_run" : "requeue";
```

## Gotchas

- **Never resume before `source_written` is durable.** The answer must be persisted (status past `answered_pending_source_write`) before any run continues or repeats — this is the exactly-once contract.
- **Mint the generation token once per process**, at control-plane construction — not per claim — or the claim-lease logic cannot tell a crashed claim from a live one.
- **`mid_run` requires a live worker session.** If the session died, fall back to `requeue`; do not attempt to resume a dead session — surface the possible-repeat to the Operator.
- **Do not let a decision pause leak into the generic failure-routing path.** A decision pause is answerable and recoverable; it must not be classified as a run failure and retried blindly.
