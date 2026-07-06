---
id: ARCH-AC-PIPELINE-DISPATCH
type: architecture
domain: runforge
status: draft
version: 2
layer: 2
references: FUNC-AC-PIPELINE
---

# ARCH-AC-PIPELINE-DISPATCH — Pipeline Session Dispatch

## Overview

The Pipeline Session Dispatch architecture replaces the direct process invocation in the Phase 1 orchestration script with a dispatch path through the Session Runtime. The script continues to own work detection, label transitions, and backoff — but session execution moves to the Session Runtime's spawn API via the CLI Adapter. This is an intermediate step between the Phase 1 shell-script orchestration and the Phase 2 native FSM pipeline variant (ARCH-AC-SPEC-PIPELINE).

The change delivers three capabilities that direct invocation lacks: session-level cost tracking, rate limit management with coordinated cooldown, and structural containment enforcement.

## Data Model

**PipelineSessionType** maps each Phase 1 skill to a registered AgentDefinition in the Session Runtime. Four session types exist:

- **l2-designer** — agentic mode, higher-capability model tier, write access restricted to architecture spec directories and the traceability map, budget cap sized for design work.
- **l3-generator** — agentic mode, higher-capability model tier, write access restricted to stack spec directories and the traceability map, budget cap sized for generation work.
- **compliance-reviewer** — one-shot mode, standard-capability model tier, read-only access (no write operations), lower budget cap.
- **spec-implementer** — agentic mode, higher-capability model tier, write access to code and test locations governed by the L3 spec, write access denied to spec directories, highest budget cap.

Each AgentDefinition contains: the session type name, model tier, execution mode, budget cap, containment rules (path patterns), the skill reference (which Phase 1 skill provides the session's instructions), and maximum turn count.

**DispatchRequest** is what the orchestration script sends to Session Runtime. It contains: the session type name, context variables (issue number, repository identifier, and any feedback content for re-run sessions), and the workspace branch (always `dev` as the base).

**DispatchResult** is what Session Runtime returns. It contains: exit status (completed, failed, timed-out, budget-exceeded), cost incurred (in currency units), session duration, and an activity summary (extracted from session output).

## API Contract

**Dispatch a pipeline session** — Called by the orchestration script for each work item. Request: a DispatchRequest (session type name and context variables). Response: a DispatchResult (exit status, cost, duration, summary).

The dispatch operation proceeds:
1. The orchestration script identifies eligible work (unchanged from Phase 1).
2. The script maps the work type to a session type name (l2-designer, l3-generator, compliance-reviewer, or spec-implementer).
3. The script constructs a DispatchRequest with the session type name, issue number, repository identifier, and feedback content (if a re-run).
4. The script calls Session Runtime's spawn API with the DispatchRequest.
5. Session Runtime resolves the AgentDefinition, checks budget and rate limits, applies containment, and delegates to the CLI Adapter.
6. The CLI Adapter spawns the session process with the skill reference, context, model tier, budget cap, and containment rules from the AgentDefinition.
7. Session Runtime monitors the session (timeout enforcement, cost tracking, rate limit detection).
8. On completion, Session Runtime returns a DispatchResult to the script.
9. The script interprets the result: on success, continue the polling loop; on failure, apply backoff.

**Budget and rate limit pre-check** — The script can query Session Runtime's budget and rate limit state before attempting dispatch. If budget is exceeded or a cooldown is active, the script skips dispatch and sleeps. This preserves the script's existing backoff behavior while adding awareness of system-wide resource state.

## System Boundaries

- Pipeline Session Dispatch OWNS: the mapping from Phase 1 work types to session type names, the DispatchRequest construction, and the interpretation of DispatchResult.
- Pipeline Session Dispatch DELEGATES TO: Session Runtime (for all session execution, cost tracking, rate limiting, and containment).
- Pipeline Session Dispatch RETAINS from Phase 1: work detection (polling and label checks via source control host API), label transitions (adding/removing labels on work requests), backoff logic (exponential backoff on failures), and the sequential execution model (one session at a time).
- Session Runtime OWNS: AgentDefinition registry, CLI Adapter execution, cost tracking, rate limit management, containment enforcement, session monitoring. These responsibilities are already defined in ARCH-AC-SESSION-RUNTIME and are reused without modification.

**What the orchestration script no longer does:**
- Construct raw process invocation commands (Session Runtime handles process lifecycle)
- Manage budget caps per invocation (Session Runtime owns this via AgentDefinition)
- Skip containment (containment is structural, enforced by the Session Runtime's layered model)

## Event Flows

**Session dispatch flow:**
1. Script polls for eligible work using source control host API label queries (unchanged from Phase 1).
2. Script finds an eligible issue and determines the work type (l2-brainstorm, l3-generate, compliance-review, or implementation).
3. Script queries Session Runtime for budget and rate limit state. If unavailable, skip and sleep.
4. Script maps work type to session type name and constructs a DispatchRequest.
5. Script calls Session Runtime's spawn API.
6. Session Runtime looks up the AgentDefinition for the requested session type.
7. Session Runtime checks daily budget. If exceeded, returns budget-exceeded status immediately.
8. Session Runtime checks rate limit state. If cooling down, returns rate-limited status immediately.
9. Session Runtime delegates to the CLI Adapter, which spawns the session process with the AgentDefinition's parameters.
10. CLI Adapter provides the skill reference as session instructions, injects context variables (issue number, repository), applies model tier and budget cap, applies containment rules.
11. Session Runtime monitors: timeout enforcement, cost accumulation, rate limit signal detection.
12. On session completion: Session Runtime extracts cost, parses exit status, audits for containment violations.
13. Session Runtime returns DispatchResult to the script.
14. Script processes the result:
    - Completed: reset fail count, update heartbeat, continue polling.
    - Failed: increment fail count, apply exponential backoff.
    - Timed-out: treat as failure, apply backoff.
    - Budget-exceeded: log warning, sleep until budget reset.
    - Rate-limited: sleep until cooldown expires.

**Transition from direct invocation:**
The transition is a cutover — one change in the script replaces the direct process invocation with a dispatch call. No gradual migration is needed because:
- The CLI Adapter spawns the same underlying process (the session tool) with the same instructions
- The skill content is unchanged — it is referenced by the AgentDefinition, not embedded in the script
- The script's polling and label logic is unchanged
- The only behavioral difference is that Session Runtime now enforces budget, rate limits, and containment around the session

**AgentDefinition registration:**
On daemon startup, the four pipeline session types are registered in Session Runtime's AgentDefinition registry alongside existing session types (worker, reviewer, coordinator, etc.). The AgentDefinitions reference the Phase 1 skill files as their instruction source. When ARCH-AC-SPEC-PIPELINE is implemented (full Phase 2), these AgentDefinitions evolve into native session types with prompt templates instead of skill references.

## Error Handling

**Session Runtime unavailable:** If the script cannot reach Session Runtime (daemon not running), it falls back to direct invocation with a logged warning. This fallback ensures the pipeline does not break during the transition period. The fallback is temporary — it is removed when the Phase 2 FSM fully replaces the script.

**Budget exceeded:** Session Runtime returns budget-exceeded status. The script logs the event and sleeps until the next budget reset window. No retry is consumed.

**Rate limited:** Session Runtime returns rate-limited status with a cooldown duration. The script sleeps for the specified duration. No retry is consumed.

**Session timeout:** Session Runtime kills the session and returns timed-out status. The script treats this as a failure and applies exponential backoff.

**Containment breach:** Session Runtime detects a violation during post-session audit. The session result is flagged. The script treats this as a failure and does not retry — the Operator must investigate.

**Cost tracking failure:** If Session Runtime cannot determine session cost (metadata unavailable), it uses the duration-based estimate defined in ARCH-AC-SESSION-RUNTIME. The script is not affected — cost tracking is transparent.
