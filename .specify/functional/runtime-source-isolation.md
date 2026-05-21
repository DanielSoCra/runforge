---
id: FUNC-AC-RUNTIME-SOURCE-ISOLATION
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-RUNTIME-SOURCE-ISOLATION - Runtime Source Isolation

## Problem Statement

The daemon must not execute from a mutable human development checkout whose uncommitted changes, stale branches, or checked-out work can affect autonomous runs. Runtime source state must be clean, intentional, and independent from workspaces used by agents.

## Actors

- **Operator** - configures the runtime source policy and receives startup or pre-run failures
- **Control Plane** - validates runtime source health before starting or resuming work
- **Workspace layer** - creates disposable workspaces from approved source references
- **Agent Service** - runs only inside prepared workspaces, never inside the daemon runtime source

## Behavior

**Scenario: Runtime source preflight**
- Given the daemon starts
- When the Control Plane initializes
- Then it validates that the runtime source is clean, points at the configured source reference, and is not the same mutable workspace used by agent sessions

**Scenario: Pre-run source assertion**
- Given the daemon is about to start or resume a work request
- When runtime source health is unknown, dirty, behind policy, or contradictory
- Then the Control Plane pauses or repairs before consuming a run attempt

**Scenario: Disposable workspaces**
- Given a work request begins
- When the Workspace layer prepares a workspace
- Then it creates or repairs a disposable workspace from an explicit approved source reference

**Scenario: Human checkout separation**
- Given the Operator edits a development checkout
- When the daemon runs
- Then uncommitted human changes do not affect daemon prompts, specifications, workspaces, or validation commands

**Scenario: Safe source update**
- Given the configured runtime source has a newer approved reference
- When the daemon can update safely
- Then the Control Plane updates or switches to that reference only while no active run depends on the old source

**Scenario: Unsafe source drift**
- Given runtime source drift cannot be repaired safely
- When the Control Plane detects it
- Then the daemon pauses and reports the drift instead of continuing with ambiguous source state

## Success Criteria

- Daemon startup reports runtime source health before accepting work
- Workspaces are created from explicit source references, not implicit current checkout state
- Dirty or stale runtime source cannot silently influence autonomous work
- Runtime source failures are routed through recoverable failure handling when repairable
- The Operator can distinguish runtime source health from ordinary run status

## Constraints

- Runtime source validation must run before crash resumption and before new work detection
- The daemon must not mutate a human development checkout as part of normal operation
- Active runs must not be invalidated by a background source update
- Source isolation must remain compatible with single-repository and multi-repository operation
- The runtime source policy must be explicit in configuration or derived from a safe default
