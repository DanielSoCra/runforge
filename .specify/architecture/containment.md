---
id: ARCH-AC-CONTAINMENT
type: architecture
domain: runforge
status: draft
version: 1
layer: 2
references: FUNC-AC-SAFETY
---

# ARCH-AC-CONTAINMENT — Directory-Level Permission Sandboxing

## Overview

The system-wide ContainmentPolicy defined in ARCH-AC-SESSION-RUNTIME applies identical path exclusions to every session. This spec introduces DirectoryScope: per-agent path restrictions that narrow each agent's write surface to the directories relevant for its role. Enforcement is structural — injected at session spawn time via native ProviderAdapter mechanisms — so boundaries hold even when an agent ignores its prompt instructions. A post-session workspace audit acts as an independent detective layer that catches any write that bypassed pre-execution enforcement.

## Data Model

A **DirectoryScope** configures the read/write surface for one agent type. It contains: an array of path patterns the agent is permitted to read, an array of path patterns the agent is permitted to write, and an array of path patterns that are explicitly denied (denied patterns override both read and write permissions).

A **ScopeRegistry** maps each known agent type to its DirectoryScope. It is populated from daemon configuration at startup. Built-in defaults are provided for known agent types and may be overridden or extended by the Operator in configuration:

- The **worker-implement** agent type: may write to source directories, package directories, and test directories; denied access to holdout scenario directories and methodology directories.
- **Reviewer agent types** (any agent type matching the reviewer pattern): write surface is empty — read-only everywhere. No additional deny patterns are needed beyond system-wide exclusions.
- The **merge-agent** agent type: may write to version control configuration, package manifests, and dependency lockfiles; denied access to source directories and specification directories.

Scope definitions are never hardcoded into runtime logic — they are always configuration-driven. The ScopeRegistry treats the configuration as the authoritative source for all agent types.

An **AgentDefinition** (defined in ARCH-AC-SESSION-RUNTIME) gains an optional DirectoryScope. When a DirectoryScope is present, it governs the per-agent path restrictions for that session. When absent, only the system-wide ContainmentPolicy applies.

A **ViolationRecord** documents a scope enforcement event. It records: the session identifier, the agent type, the path that was accessed or modified, the scope rule that was violated (write attempted outside permitted paths, or access to an explicitly denied path), the detection layer (pre-execution blocking or post-session audit), and the timestamp.

A **ScopeAuditResult** is produced by the post-session audit step. It contains a pass/fail status and the list of ViolationRecords found (empty on a clean audit).

## API Contract

**Resolve scope** — Called by Session Runtime before spawning a session.
Request: agent type name.
Response: the resolved DirectoryScope for that agent type. The resolver merges the ScopeRegistry entry's denied patterns with the system-wide ContainmentPolicy's prohibited paths — system-wide denials always take precedence. If no entry exists in the ScopeRegistry for the requested agent type, a warning is emitted and no per-agent restriction beyond the system-wide policy is applied.

**Apply scope** — Called by the ProviderAdapter at session spawn time. Translates the resolved DirectoryScope into adapter-specific enforcement:
- The CLI Adapter encodes the write-permitted paths as path restriction arguments and the denied paths as path-denial arguments; these are passed to the session process at spawn time so the process enforces them natively.
- The SDK Adapter installs tool-invocation callbacks that intercept file write operations and reject any write outside the agent's permitted write paths or to any denied paths. Rejected calls return an explicit denial message to the session — never a silent failure.
Response: none. Enforcement is embedded into the spawn parameters and takes effect for the lifetime of the session.

**Audit scope** — Called by Session Runtime after session completion as the detective enforcement layer.
Request: session identifier, agent type, resolved DirectoryScope, workspace reference.
Process: enumerates all files modified in the workspace during the session and evaluates each against the DirectoryScope. Files modified outside the permitted write paths produce a write-outside-permitted-paths ViolationRecord. Files matching denied paths produce an access-to-denied-path ViolationRecord.
Response: ScopeAuditResult.

**Report scope violation** — Session Runtime → Daemon Control Plane.
Request: ViolationRecord list, run identifier.
Effect: Daemon Control Plane transitions the run to stuck with a scope-violation note. The Operator is notified. The run cannot proceed without Operator review, regardless of remaining retry budget.

## System Boundaries

- **ScopeRegistry OWNED BY** Session Runtime. Loaded from daemon configuration at startup. Treated as immutable for the lifetime of the daemon instance; rebuilt only on explicit configuration reload.
- **Pre-execution enforcement OWNED BY** ProviderAdapter. The CLI Adapter and SDK Adapter are the structural enforcement points because they control session spawn parameters. Session Runtime resolves and passes the scope; the adapter translates it into native restrictions.
- **Post-session audit OWNED BY** Session Runtime. The scope audit runs as an additional step within the existing post-session containment audit defined in ARCH-AC-SESSION-RUNTIME, using the same workspace reference.
- **Violation handling OWNED BY** Daemon Control Plane. It receives violation signals from Session Runtime, transitions affected runs to stuck, and notifies the Operator.
- **ScopeRegistry READS FROM** daemon configuration only. Scope definitions are never derived from session output and never modified by intelligent sessions.
- **DirectoryScope is ADDITIVE to** (not a replacement for) the system-wide ContainmentPolicy. Both apply simultaneously. The effective denied paths are the union of the system-wide prohibited paths and the per-agent denied paths. The per-agent write-permitted paths further restrict write access within the space not already excluded by the system-wide policy.

## Event Flows

**Scope resolution and enforcement flow (at session spawn):**
1. Session Runtime receives a spawn request for a given agent type.
2. Session Runtime queries ScopeRegistry and resolves the DirectoryScope for the agent type.
3. Session Runtime merges the per-agent denied paths with the system-wide ContainmentPolicy's prohibited paths. The effective denied set is the union; neither policy can grant access to what the other denies.
4. Session Runtime passes the merged DirectoryScope to the ProviderAdapter as part of the session spawn parameters.
5. ProviderAdapter encodes the scope as native restrictions and spawns the session with them active.
6. Throughout the session, any write attempt outside the permitted write paths or to a denied path is rejected at the tool boundary with an explicit denial message returned to the session.

**Post-session scope audit flow:**
1. After session completion, Session Runtime invokes the scope audit against the workspace.
2. The audit enumerates all files modified during the session.
3. Each modified path is evaluated against the agent's resolved DirectoryScope.
4. If no violations are found: audit passes; the session result is returned to the caller normally.
5. If ViolationRecords are produced: Session Runtime sends a scope-violation signal to the Daemon Control Plane with the ViolationRecord list and run identifier.
6. Daemon Control Plane transitions the run to stuck with a scope-violation note and notifies the Operator.

**Configuration load flow:**
1. On daemon startup: Session Runtime reads scope definitions from the daemon configuration.
2. For each agent type present in configuration: its built-in default scope is replaced with the configured scope.
3. ScopeRegistry is initialized and treated as immutable for the daemon instance lifetime.
4. On explicit configuration reload: ScopeRegistry is rebuilt from the current configuration. Sessions already in flight are not affected — new scopes apply only to sessions spawned after the reload completes.

## Error Handling

**No scope defined for agent type:** Log a warning identifying the unscoped agent type. Apply the system-wide ContainmentPolicy only — no per-agent restriction is added. The session is not blocked; the warning signals to the Operator that an agent type lacks explicit scoping.

**Post-session audit unavailable** (workspace diff cannot be computed): Default to the safe state — produce a ScopeAuditResult with a ViolationRecord of type audit-unavailable and route the run to Operator review. The run cannot be marked successful until the Operator confirms no violation occurred.

**Configuration parse error for a scope entry:** Reject the malformed entry and log an error identifying the agent type and configuration key. Apply the built-in default scope for the affected agent type. Daemon startup is not prevented.

**Scope-violation signal delivery failure** (Daemon Control Plane unreachable): Session Runtime retries signal delivery with backoff. If the Daemon Control Plane remains unreachable beyond the retry window, Session Runtime marks the run locally as stuck with a scope-violation note and continues retrying in the background. On reconnect, the Daemon Control Plane queries Session Runtime for any outstanding violation signals.

**Overly restrictive scope** (write to a legitimately permitted path incorrectly rejected): The rejection surfaces as an explicit denial message within the session, which may cause the session to fail or escalate. The Operator can adjust the agent's write-permitted paths in configuration. No daemon restart is required — a configuration reload updates the ScopeRegistry for subsequent sessions.
