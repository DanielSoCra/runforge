---
id: ARCH-AC-DAG-EXECUTOR
type: architecture
domain: runforge
status: draft
version: 1
layer: 2
references: FUNC-AC-PIPELINE
---

# ARCH-AC-DAG-EXECUTOR — DAG-Based Workflow Executor

## Overview

The DAG-based Workflow Executor replaces the linear FSM phase sequencer inside the Daemon Control Plane. Pipeline variants are expressed as Directed Acyclic Graphs of typed workflow nodes; the executor resolves dependency edges, runs independent nodes in parallel, and drives iterative loops until exit conditions are met. The existing linear pipelines (`feature`, `feature-simple`, `bug`) are expressed as degenerate linear DAGs — the DAG model is a strict superset of the prior FSM and produces identical observable behavior (same phase labels, same service calls, same crash-recovery semantics). This spec does not introduce a new service; the executor is the internal execution engine of the existing Control Plane. Migration of in-progress runs that were persisted under the old `RunState` format is handled transparently on load: the Control Plane converts `currentPhase` / `phaseCompletionMap` fields into synthetic `nodeStates` entries before handing the run to the DAG executor.

## Data Model

A **WorkflowDefinition** is a declarative description of one pipeline variant. It contains: a variant name (e.g. `feature`, `feature-simple`, `bug`, `adversarial-dev`, or an operator-supplied name); a map of node ID to WorkflowNode; an entry node ID where execution begins; and a label map that records the FSM phase label to emit when each node is entered (preserving observability compatibility with existing tooling).

Four built-in variant shapes:

| Variant | Node chain |
|---|---|
| `feature` | detect → classify → decompose → implement → review → holdout → integrate → deploy → test → report |
| `feature-simple` | detect → classify → implement → review → holdout → integrate → deploy → test → report |
| `bug` | detect → implement → review → integrate → deploy → test → report |
| `adversarial-dev` | detect → classify → decompose → implement → parallel-review → adversarial-loop → holdout → integrate → deploy → test → report |

A **WorkflowNode** is a discriminated union of three types.

A **TaskNode** wraps one pipeline phase. It records: the abstract phase name; the system component that executes it (`ControlPlane`, `ImplementationCoordinator`, `ValidationService`, `BugDiagnosisService`, or `SessionRuntime`); whether it is retryable and how many retries are allowed; the next node ID on success; the next node ID on non-retryable failure (absent means enter stuck); and an optional skip target.

A **ParallelGroup** fans out to a set of child nodes, executes them concurrently, and fans back in when all complete. It records: the ordered list of child node IDs; a failure policy (`fail-fast` — abort remaining children on first failure; or `continue-all` — complete all children and surface combined failures at fan-in); the next node ID when all children succeed; and the next node ID when any child fails.

A **LoopNode** wraps an inner workflow and re-executes it until an exit condition is satisfied. It records: the entry node ID of the inner workflow (must be a node in the same WorkflowDefinition); the exit condition — either `success` (exit when inner completes without failure) or `max-iterations` (exit after a configurable iteration limit regardless of outcome); the next node ID on exit-pass; the next node ID on exit-fail (absent means enter stuck); and an iteration label prefix used to generate per-iteration phase labels (e.g. prefix `adversarial` yields `adversarial:iteration:1`, `adversarial:iteration:2`).

A **NodeState** is a per-node execution record embedded in RunState. It contains: node ID; status (`pending`, `running`, `succeeded`, `failed`, `skipped`); start and completion timestamps; iteration count (LoopNode only); and a normalized error hash of the last failure, used by the circular error detector.

The **RunState** gains three fields beyond those defined in `ARCH-AC-CONTROL-PLANE`: a map of node ID to NodeState (initialized with all nodes `pending` at run start); the currently executing or last-completed node ID (crash-recovery resume point); and a list of node IDs that are concurrently active inside a ParallelGroup (used to re-attach after a crash).

## API Contract

The DAG Executor exposes an internal interface consumed by the Daemon Control Plane. No external-facing endpoint is introduced; all calls are in-process.

**Execute** — Request: WorkflowDefinition, RunState (freshly created for a new run). Effect: begins node dispatch from the entry node. Returns: updated RunState after the first node completes or the run enters a waiting state.

**Resume** — Request: WorkflowDefinition, RunState (loaded from persistent storage after a crash). Effect: restores NodeState entries and re-enters dispatch from the saved resume point. Nodes whose status is `succeeded` are skipped; nodes whose status is `running` are re-executed from the beginning. Returns: updated RunState.

**Validate** — Request: WorkflowDefinition (operator-supplied). Effect: checks that all referenced node IDs exist, that the entry node is present, that no cycles exist in the node graph, that each LoopNode's inner entry node is reachable from the definition's root, and that the label map covers all node IDs. Returns: validation result (pass or list of violations). Called at startup before registering operator-supplied definitions; built-in variants are pre-validated and not checked at runtime.

Variant selection is performed by the Daemon Control Plane before calling Execute, using the same routing logic defined in `ARCH-AC-CONTROL-PLANE`: bug work requests route to `bug`; simple feature work requests route to `feature-simple`; operator-defined matching criteria select custom variants; all others use `feature` (or `adversarial-dev` if configured as project default). If a selected variant requires capabilities that are not present (e.g. `adversarial-dev` requires adversarial reviewer and model tiering features), the Control Plane falls back to `feature` and records the reason.

## System Boundaries

- **DAG Executor OWNS:** WorkflowDefinition loading and validation, NodeState lifecycle, parallel concurrency scheduling, loop iteration control, phase label emission triggers, crash-recovery resume logic, old-format RunState migration.
- **DAG Executor CALLS:** the same downstream services as the prior FSM — SessionRuntime (for classifier and reporter sessions), ImplementationCoordinator (for decompose and implement phases), ValidationService (for review, holdout, deploy, and test phases), BugDiagnosisService (for holdout-failure diagnosis), KnowledgeService (for exemplar storage). Delegation contracts are identical to those in `ARCH-AC-CONTROL-PLANE`.
- **DAG Executor DOES NOT OWN:** label writing on work requests (Control Plane writes labels, executor triggers those writes), notification dispatch (Control Plane dispatches), integration lock (Control Plane holds), operator commands (Control Plane exposes), work detection and claiming, integration flow, stuck handling, completion flow, graceful shutdown, instance locking, budget enforcement. These remain owned by the Control Plane as defined in `ARCH-AC-CONTROL-PLANE`.

## Event Flows

**Variant selection and run start:**
1. Control Plane detects and claims a work request, creates a RunState, selects a WorkflowDefinition, and calls Execute.
2. Executor initializes NodeState entries for all nodes as `pending`.
3. Executor begins dispatch from the entry node.

**TaskNode dispatch:**
1. Executor triggers the Control Plane's label-writing function with the node's entry label.
2. Executor sets NodeState status to `running`.
3. Executor delegates to the owning system component. On success: sets status to `succeeded`, advances to the next node.
4. On failure: applies retry logic (see Error Handling). If retries exhausted, advances to the failure target or enters stuck.

**ParallelGroup dispatch:**
1. Executor emits the group's entry label.
2. Executor spawns all child nodes for concurrent execution; records their IDs as active parallel nodes.
3. Each child executes its TaskNode dispatch independently.
4. Under `fail-fast`: on first child failure, remaining children are cancelled; executor advances to the failure target.
5. Under `continue-all`: executor waits for all children; on any failure, advances to the failure target; on all success, advances to the success target.
6. Executor clears the active parallel node list.

**LoopNode dispatch:**
1. Executor emits the loop entry label.
2. On each iteration: executor increments the iteration counter, emits the iteration-scoped label, executes the inner workflow recursively (inner NodeState entries are reset per iteration).
3. After each inner completion: executor evaluates the exit condition. If the `success` condition is met, the loop exits (pass). If `max-iterations` is reached, the loop exits (pass if the last iteration succeeded, fail if it failed).
4. If exit condition is not yet met and the limit is not reached: executor begins the next iteration.
5. On exit-pass: advances to the pass target. On exit-fail: advances to the fail target or enters stuck.

**Adversarial-dev variant flow:**
1. Linear phases execute sequentially: detect → classify → decompose → implement.
2. `parallel-review` (ParallelGroup, `continue-all`) spawns three independent reviewer sessions concurrently. Combined findings are assembled as input context.
3. `adversarial-loop` (LoopNode, `success` exit) executes an inner workflow: the adversarial-challenge node generates adversarial test cases and attempts to break the implementation. If the implementation survives all challenges, the loop exits (pass) and execution continues to holdout. If any challenge exposes a failure, the inner workflow includes a re-implementation step before the next challenge iteration. If the iteration limit is reached without a passing inner run, the loop exits (fail) and the run enters stuck.
4. Remaining linear phases execute: holdout → integrate → deploy → test → report.
5. The specific session types, model tiers, and challenge strategies used in the parallel-review and adversarial-loop nodes are defined in L3 specs.

**Crash recovery:**
1. Control Plane detects incomplete RunState files on startup.
2. For each incomplete run: Control Plane loads the WorkflowDefinition, migrates old-format state if needed, and calls Resume.
3. Executor restores NodeState entries. If active parallel node IDs are recorded, each is re-attached and re-executed from the beginning (skipping children whose status is `succeeded`). Otherwise, execution resumes from the recorded current node.

## Error Handling

**TaskNode failure:** Retry up to `maxRetries`. Each retry re-executes from the node's start (or sub-phase checkpoint if one exists). After exhausting retries: advance to the failure target or enter stuck.

**Circular error detection:** Before each retry, the executor normalizes the error (stripping timestamps and resource-specific identifiers) and checks whether the same error hash has appeared three or more times within the run. If so, the node transitions to stuck immediately without consuming remaining retries.

**ParallelGroup child failure:** Under `fail-fast`, cancels remaining children and propagates failure to the group's failure target. Under `continue-all`, records the failure and continues; at fan-in, propagates combined failure to the group's failure target. Stuck handling (label, comment, notification, results ledger entry) is applied at the run level, reporting which parallel branch caused the failure.

**LoopNode inner failure:** A stuck inner node surfaces through the loop. The loop advances to its fail target (or enters stuck). Error context includes the iteration number and inner node identity.

**Daily budget exceeded:** Executor pauses the daemon (delegates to Control Plane). Resumes automatically when the budget window resets or the operator intervenes.

**Per-run budget exceeded:** Executor transitions the run to stuck. Other concurrent runs are not affected.

**Rate limited:** Executor pauses with escalating cooldown (increasing delays on consecutive rate-limit signals, up to a configured maximum). Resumes automatically when the cooldown expires.

**Operator-supplied WorkflowDefinition invalid:** Validate returns violations. The definition is not registered. The Control Plane logs the violations and falls back to the built-in variant for any work request that would have matched.

**Unknown variant at resume time:** If the WorkflowDefinition for a persisted run's variant cannot be found (e.g. operator removed a custom definition), the Control Plane does not resume that run. It enters stuck, notifies the operator, and records the reason.
