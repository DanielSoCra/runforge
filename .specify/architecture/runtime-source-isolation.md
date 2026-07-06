---
id: ARCH-AC-RUNTIME-SOURCE-ISOLATION
type: architecture
domain: runforge
status: draft
version: 1
layer: 2
references: FUNC-AC-RUNTIME-SOURCE-ISOLATION
---

# ARCH-AC-RUNTIME-SOURCE-ISOLATION - Runtime Source Isolation

## Overview

Runtime Source Isolation defines the source-state boundary between the daemon process and agent workspaces. The daemon runs from a runtime source root that is validated before use. Agent workspaces are disposable and are created from explicit source references owned by the workspace layer. Human development checkouts are not valid runtime sources unless they satisfy the runtime policy.

## Data Model

**RuntimeSourcePolicy** defines the allowed runtime mode, source root, configured base reference, update policy, cleanliness requirement, and whether self-repair is allowed.

**RuntimeSourceStatus** records: source root, current reference, expected reference, cleanliness, synchronization state, active run count, last validation timestamp, and failure kind if unhealthy.

**SourceReference** identifies an approved source point for workspace creation. It contains a branch, tag, or immutable revision plus the repository identity.

**WorkspaceSourcePlan** is produced for each run. It contains the SourceReference, workspace path, whether an existing workspace may be reused, and whether stale workspaces must be archived.

**RuntimeSourceFailure** records unhealthy source state such as dirty runtime source, behind configured reference, missing reference, active-run update conflict, or source validation unavailable.

## API Contract

**Validate runtime source** - Called on daemon startup, before crash resumption, and before claiming new work. Request: RuntimeSourcePolicy. Response: RuntimeSourceStatus.

**Resolve workspace source** - Called before workspace preparation. Request: work request identifier, phase, and current RuntimeSourceStatus. Response: WorkspaceSourcePlan.

**Repair runtime source** - Called only when RuntimeSourcePolicy allows self-repair and no active run would be invalidated. Request: RuntimeSourceFailure and policy. Response: repaired, paused, or human-required.

**Publish source health** - Called when runtime source status changes. Request: RuntimeSourceStatus. Response: status endpoint and operator notifications updated.

## System Boundaries

- Control Plane OWNS: runtime source policy loading, preflight timing, health publication, and pause decisions.
- Workspace layer OWNS: workspace source plans, disposable workspace creation, workspace archive and repair, and explicit source checkout.
- Agent Service OWNS: execution inside assigned workspaces only.
- Operator OWNS: approving runtime source policy changes and resolving unsafe source drift.
- Runtime source validation DOES NOT OWN: feature implementation, artifact delivery, or release approval.

## Event Flows

**Startup preflight flow**
1. Control Plane loads RuntimeSourcePolicy.
2. Control Plane validates runtime source before initializing schedulers that claim work.
3. If healthy, startup continues and status includes RuntimeSourceStatus.
4. If repairable and self-repair is allowed, Control Plane repairs then validates again.
5. If unhealthy after repair, startup fails or enters paused mode according to policy.

**Pre-run flow**
1. Work detection finds eligible work.
2. Before claim, Control Plane checks RuntimeSourceStatus freshness.
3. If healthy, it claims work and asks the workspace layer for a WorkspaceSourcePlan.
4. If unhealthy, it pauses or enqueues repair without consuming a run attempt.

**Crash resumption flow**
1. Daemon starts and finds incomplete runs.
2. Runtime source is validated before resuming any run.
3. For each run, WorkspaceSourcePlan chooses the persisted source reference when present, otherwise the current approved source.
4. Stale workspace paths are reconciled before the phase handler executes.

**Source update flow**
1. Control Plane detects a newer approved source reference or receives an Operator update.
2. If active runs exist, update is deferred.
3. If idle, Control Plane updates runtime source according to policy and validates.
4. New workspaces use the new SourceReference. Existing run records keep their original reference.

## Error Handling

**Dirty runtime source:** If policy requires cleanliness, pause and publish runtime source failure. Repair may discard only daemon-owned runtime state, never human work.

**Behind configured reference:** If self-repair is allowed and no active run exists, update to the configured reference. Otherwise pause and notify.

**Missing source reference:** Human-required. The system cannot infer the correct source.

**Validation unavailable:** Fail safe by pausing. Do not claim work while source health is unknown.

**Active run update conflict:** Defer source update until active runs complete. Do not change runtime source under active sessions.

**Workspace source mismatch:** Archive or recreate the workspace if safe; otherwise route through recoverable failure handling.
