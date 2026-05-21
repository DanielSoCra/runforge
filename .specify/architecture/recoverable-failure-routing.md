---
id: ARCH-AC-RECOVERABLE-FAILURE-ROUTING
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-RECOVERABLE-FAILURE-ROUTING
---

# ARCH-AC-RECOVERABLE-FAILURE-ROUTING - Recoverable Failure Routing

## Overview

Recoverable Failure Routing extends the Control Plane with typed failure outcomes and a bounded repair loop. Phases no longer report only success, failure, or escalation. They may attach a FailureRecord that identifies the failure kind, retryability, repair action, and whether Operator action is required.

The Control Plane remains the routing owner. Services report structured facts; the Control Plane decides whether to retry, repair, pause, or escalate.

## Data Model

**FailureKind** classifies the reason a phase could not continue. Initial kinds are: workspace-repair-needed, delivery-repair-needed, agent-output-invalid, provider-temporarily-unavailable, budget-unavailable, containment-violation, containment-audit-suspect, spec-contradiction, and human-required.

**FailureSeverity** is one of: info, warning, blocking, or critical.

**RepairAction** is one of: recreate-workspace, reconcile-artifact, retry-session, wait-for-provider, clear-contradictory-labels, request-human, or none.

**FailureRecord** contains: failure kind, phase, message, normalized error hash, severity, retryable flag, repair action, attempt number, max attempts, first seen timestamp, last seen timestamp, and optional related artifact reference.

**RepairQueueItem** contains: run identifier, work request identifier, failure record, scheduled time, attempt count, and status.

**RepairHistory** is stored on RunState and results records. It records all repair attempts and their outcomes.

## API Contract

**Classify phase failure** - Called by the Control Plane after a phase handler returns a failure signal or throws. Request: phase name, event, error text, service metadata, current run state. Response: FailureRecord.

**Route failure** - Called after classification. Request: FailureRecord and run state. Response: route decision: retry-phase, enqueue-repair, pause, human-required, or terminal-stuck.

**Execute repair** - Called for a RepairQueueItem. Request: repair action, run state, and related artifact metadata. Response: repaired, retry-later, or repair-failed.

**Publish failure state** - Called when route decision changes Operator-visible state. Request: run state and FailureRecord. Response: labels, comments, status records, and notifications updated.

## System Boundaries

- Control Plane OWNS: failure classification, routing decisions, repair queue, repair bounds, visible status transitions, and results ledger failure metadata.
- Workspace layer EXECUTES: recreate-workspace repair actions and workspace validation.
- Controlled Artifact Delivery EXECUTES: reconcile-artifact repair actions.
- Agent Service REPORTS: session status, provider availability, budget status, containment status, and output validation errors.
- Validation Service REPORTS: spec contradictions, quality failures, and holdout failures.
- Operator OWNS: decisions after human-required routing.

## Event Flows

**Workspace repair flow**
1. Detect or resume asks the workspace layer for a usable workspace.
2. Workspace layer reports a repairable workspace failure.
3. Control Plane records FailureKind workspace-repair-needed.
4. Control Plane enqueues recreate-workspace if attempts remain.
5. Workspace layer archives or recreates the workspace.
6. Control Plane retries the failed phase from the start.

**Delivery repair flow**
1. Artifact packaging or proposal reconciliation fails.
2. Control Plane records FailureKind delivery-repair-needed.
3. Control Plane checks the recorded PhaseArtifact and ProposalKey.
4. If a safe proposal can be found or recreated, Control Plane repairs and retries the gate transition.
5. If multiple conflicting proposals exist, Control Plane routes to human-required.

**Agent output repair flow**
1. Agent Service exits successfully but required artifacts or structured output are missing.
2. Control Plane records FailureKind agent-output-invalid.
3. If attempts remain, Control Plane retries the session with failure feedback.
4. After attempts are exhausted, Control Plane routes to human-required with the output contract violation.

**Containment routing flow**
1. Agent Service reports confirmed preventive containment denial.
2. Control Plane records FailureKind containment-violation.
3. Control Plane routes directly to human-required.
4. Advisory output-audit warnings are recorded as containment-audit-suspect and do not block the run unless repeated with corroborating evidence.

**Repair exhaustion flow**
1. A repairable failure recurs.
2. Control Plane increments the FailureRecord attempt count.
3. When the maximum is reached, Control Plane records repair exhaustion.
4. The work request is labeled and commented as human-required, with repair history attached.

## Error Handling

**Unknown failure kind:** Treat as human-required until a classifier rule exists. Unknown failures must not silently retry forever.

**Repair action throws:** Record the thrown error on the RepairHistory and retry only if the repair action itself is marked retryable.

**Repair queue persistence fails:** Pause the daemon. Continuing without durable repair state risks duplicate or infinite repair attempts.

**Contradictory failure signals:** Safety-critical signals win over repairable signals. Confirmed containment and budget unavailability take precedence over workspace repair.

**Human-required publication fails:** Keep the run in a non-claimable internal state and retry publication. Do not release the issue as ready while the Operator-visible state is missing.
