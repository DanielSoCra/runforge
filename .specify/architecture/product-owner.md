---
id: ARCH-AC-PRODUCT-OWNER
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-PRODUCT-OWNER
---

# ARCH-AC-PRODUCT-OWNER — Product Owner Agent

## Overview

The Product Owner Agent analyzes system signals and generates proposals for what to build next. It runs as a scheduled agent session spawned by the Coordination Service, reading signal sources to identify spec pipeline gaps, stale work, and backlog priorities, then producing structured proposals that require operator approval before becoming work requests.

This spec defines the PO agent's internal architecture: signal aggregation, proposal generation, protocol participation, and session design. It complements ARCH-AC-COORDINATION, which owns the Proposal lifecycle, agent pool, PO scheduling, and terminal interface. It complements ARCH-AC-KNOWLEDGE, which owns the knowledge store that the PO reads from (proposal history, business observations) and writes to (retrospective lessons).

The PO and Tech Lead interact through six structured protocols (defined in FUNC-AC-PRODUCT-OWNER). At the architecture level, protocols are orchestrator-mediated: the Coordination Service spawns sequential agent sessions, passing each session's structured output as input to the next. Protocol state is persisted in the database for crash recovery.

## Data Model

**SignalSnapshot** represents the aggregated input context for a PO analysis cycle. It contains: a unique identifier, the cycle timestamp, a spec pipeline summary (which specs have complete layer chains and which have gaps), an aggregate delivery summary (pass/fail rates and completion counts per repository — no detailed failure analysis), a backlog summary (open issues with labels, ages, and staleness flags), an active proposal summary (current proposals with statuses), a proposal history summary (recently decided proposals with outcomes and operator reasons), and an operator idea inbox (pending idea submissions). The snapshot is assembled by the Coordination Service before spawning the PO session and is not persisted — it is a transient input document.

**ProtocolExecution** represents a single run of an interaction protocol between the PO and Tech Lead. It contains: a unique identifier, a protocol type (enrichment, batch_planning, backlog_grooming, escalation, status_sync, retrospective), an initiator role (po or tech_lead), a status (initiated, round_in_progress, awaiting_response, completed, failed, escalated_to_operator), a trigger reason (scheduled, event_driven, chained — with the chaining source protocol identifier when applicable), an array of ProtocolRound entries, the final output document (structured per protocol type, nullable until completed), an operator escalation reason (nullable, set when the protocol could not converge), and timestamps for creation, last update, and completion.

**ProtocolRound** represents one agent's contribution within a protocol execution. It contains: a sequence number, the contributing role (po or tech_lead), the session identifier of the agent session that produced it, a structured input document (what the agent received), a structured output document (what the agent produced), a status (pending, in_progress, completed, failed, skipped), and timestamps for start and completion. A round with status "skipped" indicates a degraded path where one agent could not contribute.

**ProposalEnrichment** extends the Proposal model (defined in ARCH-AC-COORDINATION) with Tech Lead assessment data. It contains: a reference to the Proposal, a reference to the ProtocolExecution that produced the enrichment, an effort estimate (small, medium, large, or unassessed), a dependency analysis (array of spec or issue references that must complete first), a technical risk summary, a list of prerequisite work items, and an assessed flag (false when the Tech Lead could not assess — the "unassessed" degraded path from L1).

**ProtocolSchedule** represents the configured cadence for protocol triggers. It contains: the protocol type, a trigger mode (periodic or event_driven), a periodic interval (nullable — used for periodic triggers), an event source (nullable — used for event-driven triggers, e.g., "batch_completed", "idea_submitted", "stuck_item_detected"), and a debounce window (nullable — minimum time between event-driven triggers). Default schedules: Status Sync every 30 minutes, Backlog Grooming every 4 hours, Retrospective on batch completion, Escalation on event, Proposal Enrichment on new proposal, Batch Planning chained from Retrospective or Backlog Grooming.

## API Contract

The PO Agent does not expose its own service API. It operates as a session spawned by the Coordination Service and produces structured output that the Coordination Service processes. The interfaces below describe the contract between the Coordination Service and the PO session.

**PO session input:** The Coordination Service assembles a session context containing: the SignalSnapshot, the protocol execution context (if the session is a protocol round rather than a standalone analysis cycle), relevant knowledge records from the Knowledge Service (business observations and proposal history, filtered by the PO's consumer set), and operating instructions (the PO prompt template).

**PO session output — analysis cycle:** The session produces an array of raw proposals (each with: title, rationale, proposal type, related spec or issue references, estimated scope). These are submitted to the Coordination Service, which creates Proposal records and triggers Proposal Enrichment protocols with the Tech Lead.

**PO session output — protocol round:** The session produces a structured document specific to the protocol type:
- Enrichment (PO-initiated): raw proposal with business rationale, spec references, estimated value.
- Enrichment (PO review of Tech Lead input): priority assessment, scope adjustments, forward/reject decision with reason.
- Batch Planning: top N backlog items ordered by business priority, with rationale for ordering.
- Backlog Grooming: re-prioritized backlog with movement rationale (items moved up, down, or removed).
- Status Sync: priority changes, new operator ideas, proposal outcomes.
- Retrospective: delivery expectations versus actuals, business-level lessons learned.
- Escalation (PO-initiated): priority shift description, affected batch items, urgency justification.
- Escalation (PO response): decision on Tech Lead's options, rationale grounded in business priority.

**Protocol trigger notifications:** The Coordination Service determines when protocols should execute based on ProtocolSchedule entries. It does not delegate scheduling to the PO — the PO is a participant, not a scheduler.

## System Boundaries

The PO agent is a session-based component — it has no persistent process. The Coordination Service spawns PO sessions on schedule and on protocol triggers via Session Runtime. The following describes how the PO connects to each system and what it owns, reads, and writes.

**Coordination Service → PO Agent:** The Coordination Service assembles a SignalSnapshot and spawns a PO session via Session Runtime. It passes the snapshot, protocol context (if applicable), and the PO prompt template as session input. When the session completes, the Coordination Service processes its structured output (proposals, protocol round documents). The Coordination Service is the PO's sole lifecycle manager.

**Knowledge Service → PO Agent (read-only):** The Coordination Service queries the Knowledge Service for business_observation records relevant to the PO's current cycle and includes them in the session context. The PO does not call the Knowledge Service directly — it receives pre-fetched knowledge as part of its input.

**PO Agent → Tech Lead Agent (mediated):** PO and Tech Lead never communicate directly. The Coordination Service mediates all interaction through ProtocolExecution: it spawns a PO session, collects its output, then spawns a Tech Lead session with that output as input (and vice versa). Each agent sees only its round's input document.

**Operator → PO Agent (indirect):** Operators interact with the PO through the Coordination Service's terminal interface and the Dashboard. Idea submissions, proposal approvals/rejections, and priority changes flow through the Coordination Service, which incorporates them into the PO's next SignalSnapshot.

**Session Runtime:** Provides the execution environment for PO sessions. Enforces per-session budget and time limits. Reports session completion, failure, or timeout to the Coordination Service.

**PO Agent OWNS:** Signal analysis logic (within session), proposal generation logic (within session), business priority assessment (within protocol rounds), protocol round outputs.

**PO Agent READS (via SignalSnapshot assembled by Coordination Service):**
- Specification directory — for pipeline gap analysis.
- Aggregate delivery outcomes — from run history (pass/fail rates, completion counts per repository). The PO never reads detailed failure reasons, error categories, or phase breakdowns (Tech Lead territory, per L1 constraint).
- Proposal history — from the Knowledge Service (business_observation records) and from the Proposal store (decided proposals with outcomes).
- Issue backlog — from the work request source (open issues with labels, ages).
- Operator idea inbox — from the IdeaSubmission store.

**PO Agent WRITES (via structured session output processed by Coordination Service):**
- Raw proposals → Coordination Service creates Proposal records.
- Protocol round outputs → Coordination Service stores as ProtocolRound entries.
- Business-level retrospective lessons → Coordination Service submits to Knowledge Service as business_observation records with origin type "retrospective-po" and lifecycle status "candidate."

**PO Agent NEVER:**
- Reads detailed failure analysis (Tech Lead territory).
- Performs code-level analysis or reads source files (operates at L0-L2 spec layers only).
- Creates work requests directly (operator approval required, enforced by Coordination Service).
- Modifies specs directly (L0 boundary).
- Schedules its own execution (Coordination Service owns scheduling).
- Auto-approves its own proposals (L0 boundary, enforced by Coordination Service).

**Coordination Service responsibilities (defined in ARCH-AC-COORDINATION, referenced here for clarity):**
- Spawns PO sessions on schedule and on protocol triggers.
- Assembles SignalSnapshot before each PO session.
- Processes PO session output: creates Proposals, initiates Protocol Enrichment.
- Manages ProtocolExecution lifecycle: creates entries, spawns sequential rounds, detects convergence failure, escalates to operator.
- Enforces all guardrails: operator approval, proposal expiry, no self-approval.

**Operational constraints:** The PO analysis cycle runs on a configurable schedule (default: every 30 minutes). Event-driven triggers (operator idea submission, batch completion) are debounced with a configurable minimum interval (default: 5 minutes). Proposals remaining in `proposed` status beyond a configurable window (default: 7 days) are transitioned to `expired` by the Coordination Service as part of its PO-cycle tick — the PO agent does not manage expiry. The PO operates exclusively at spec layers 0 through 2 (vision, functional, architecture) and never performs code-level analysis. Each PO session operates within per-session budget and time limits configured in the Coordination Service. The system supports exactly one PO agent instance (pool allocation: min 1, max 1, per ARCH-AC-COORDINATION).

## Event Flows

**PO analysis cycle (standalone — not part of a protocol):**

1. The Coordination Service's PO schedule tick fires (default: every 30 minutes) or an IdeaSubmission arrives (debounced: at most once per interval).
2. The Coordination Service assembles a SignalSnapshot: reads the spec directory for pipeline state, queries run history for aggregate delivery outcomes, queries the Proposal store for active and decided proposals, queries the issue backlog for open items, reads the IdeaSubmission inbox for pending ideas, and queries the Knowledge Service for relevant business observations.
3. The Coordination Service spawns a PO session via Session Runtime with the SignalSnapshot and PO prompt template as context.
4. The PO session analyzes signals, identifies gaps and opportunities, and produces an array of raw proposals as structured output.
5. The Coordination Service processes the output: for each raw proposal, it creates a Proposal record (status: proposed) in the database. For proposals that refine an operator idea, it links the Proposal to the originating IdeaSubmission and marks the IdeaSubmission as processed.
6. For each new Proposal, the Coordination Service initiates a Proposal Enrichment protocol (see below).
7. The Coordination Service sweeps Proposals past their expiry timestamp as part of its PO-cycle tick, transitioning them from `proposed` to `expired`. This runs in the Coordination Service, not in the PO session — expiry is a lifecycle operation, not an analysis task.

**Proposal Enrichment protocol (PO-initiated):**

1. The Coordination Service creates a ProtocolExecution (type: enrichment, initiator: po, status: initiated).
2. Round 1 — PO: The Coordination Service spawns a PO protocol session with the raw Proposal as input. The PO produces business rationale, spec references, and estimated value. The round output is stored as a ProtocolRound. (Note: if the Proposal was generated in the same PO analysis cycle, the Coordination Service may skip this round and use the raw proposal output directly as Round 1 output, avoiding a redundant session spawn.)
3. Round 2 — Tech Lead: The Coordination Service spawns a Tech Lead protocol session with the PO's Round 1 output. The Tech Lead adds effort estimate, dependency analysis, technical risks, and prerequisite work. The round output is stored as a ProtocolRound. If the Tech Lead cannot assess (insufficient data), it produces an output with assessed=false and the enrichment proceeds with the "unassessed" flag.
4. Round 3 — PO review: The Coordination Service spawns a PO protocol session with both Round 1 and Round 2 outputs. The PO reviews the Tech Lead's input, may adjust priority or scope, and produces the final enriched proposal.
5. The Coordination Service creates a ProposalEnrichment record linking the Proposal to the assessment data. The Proposal is now visible to the operator with both business case and technical assessment (or the "unassessed" flag).
6. ProtocolExecution status transitions to completed.

**Proposal Enrichment protocol (Tech Lead-initiated):**

1. The Tech Lead generates a raw technical proposal during its analysis cycle.
2. The Coordination Service creates a ProtocolExecution (type: enrichment, initiator: tech_lead, status: initiated).
3. Round 1 — Tech Lead: The raw technical proposal with evidence, affected areas, and risk assessment. Stored as a ProtocolRound.
4. Round 2 — PO: The Coordination Service spawns a PO protocol session. The PO evaluates business priority: worth doing now versus other backlog items. The PO either forwards the proposal to the operator with priority context, or rejects it with reason. Stored as a ProtocolRound.
5. If rejected: ProtocolExecution status transitions to completed. The rejection reason is recorded. The Tech Lead may re-propose with stronger evidence on a future cycle.
6. If forwarded: the Coordination Service creates a Proposal record visible to the operator. ProtocolExecution status transitions to completed.

**Batch Planning protocol:**

1. Triggered when: a Retrospective completes (chained), a Backlog Grooming completes (chained), or operator requests re-planning.
2. The Coordination Service creates a ProtocolExecution (type: batch_planning, status: initiated).
3. Round 1 — PO: The Coordination Service spawns a PO session with the current backlog. The PO produces the top N items ordered by business priority with rationale.
4. Round 2 — Tech Lead: The Coordination Service spawns a Tech Lead session with the PO's prioritized list plus current system health data and the prospective risk query results from the Knowledge Service. The Tech Lead flags hard constraints (dependencies, parallelism limits, capacity), proposes an ordering and parallelism map.
5. The Coordination Service evaluates convergence: if the Tech Lead's constraints are compatible with the PO's priorities (no items vetoed, ordering adjustments are minor), the protocol produces a final batch definition. If incompatible (Tech Lead vetoes a PO priority item, or capacity forces removal of items the PO considers essential), the protocol cannot converge in one round.
6. On convergence failure: ProtocolExecution status transitions to escalated_to_operator. Both the PO's priorities and the Tech Lead's constraints are presented to the operator for resolution.
7. On empty batch: if both the PO and Tech Lead agree that no items are viable (all items are blocked, capacity is insufficient, or dependencies cannot be satisfied), the protocol produces an empty batch definition with a reason summary. The Coordination Service creates an Escalation to the operator explaining why no work can proceed. ProtocolExecution status transitions to completed. No Batch is created.
8. On convergence: the Coordination Service creates a Batch (as defined in ARCH-AC-COORDINATION) from the protocol output. ProtocolExecution status transitions to completed.

**Backlog Grooming protocol:**

1. Triggered on the grooming schedule (default: every 4 hours) or when a significant backlog change occurs (new specs approved, large batch of issues created).
2. The Coordination Service creates a ProtocolExecution (type: backlog_grooming, status: initiated).
3. Round 1 — PO: Current prioritized backlog plus new signals (ideas, stale items, completed specs).
4. Round 2 — Tech Lead: Updated technical landscape (new findings, resolved debt, changed dependencies). If the Tech Lead has no new technical input, this round is skipped (status: skipped) and the grooming is recorded as PO-only.
5. Output: re-prioritized backlog.
6. ProtocolExecution status transitions to completed.

**Status Sync protocol:**

1. Triggered on the status sync schedule (default: every 30 minutes, aligned with PO analysis cycle).
2. The Coordination Service creates a ProtocolExecution (type: status_sync, status: initiated).
3. Round 1 — Tech Lead: Active work status, stuck items, completed items, resource utilization.
4. Round 2 — PO: Priority changes, new operator ideas, proposal outcomes.
5. Output: shared state update. The Coordination Service evaluates whether the output triggers a chained protocol (batch complete → Retrospective, stuck item → Escalation).
6. ProtocolExecution status transitions to completed.

**Retrospective protocol:**

1. Triggered when a Status Sync detects batch completion (chained).
2. The Coordination Service creates a ProtocolExecution (type: retrospective, status: initiated).
3. Round 1 — PO: Delivery expectations versus actuals.
4. Round 2 — Tech Lead: Failure analysis, recurring patterns, resource utilization, knowledge record trends.
5. Output: lessons learned and process adjustments. The Coordination Service processes lessons: Tech Lead technical lessons are submitted to the Knowledge Service as technical_pitfall records (origin: retrospective-tech-lead). PO business lessons are submitted as business_observation records (origin: retrospective-po). Both enter with lifecycle status "candidate" per ARCH-AC-KNOWLEDGE.
6. Actionable items become proposals (PO generates) or technical debt items (Tech Lead generates), triggering Proposal Enrichment protocols.
7. The Coordination Service chains to Backlog Grooming, then Batch Planning.
8. ProtocolExecution status transitions to completed.

**Escalation protocol:**

1. Triggered by events: Tech Lead detects a technical blocker, PO detects a priority shift (operator submits urgent idea), or Status Sync detects a stuck item.
2. The Coordination Service creates a ProtocolExecution (type: escalation, status: initiated, with trigger reason).
3. For Tech Lead escalation: Round 1 — Tech Lead presents the blocker with options. Round 2 — PO evaluates against business priority and decides.
4. For PO escalation: Round 1 — PO presents the priority shift. Round 2 — Tech Lead evaluates capacity impact. Joint decision: re-plan or queue for next cycle.
5. If domains clash and agents cannot resolve: ProtocolExecution status transitions to escalated_to_operator. Both positions go to the operator.
6. If resolved: the Coordination Service may trigger re-Batch Planning if the decision requires it.
7. Time-critical escalations (budget exceeded, system health critical) bypass the protocol and go directly to the operator via the Coordination Service's existing alerting.

**Protocol composition (chaining):**

The Coordination Service manages protocol chains. When a ProtocolExecution completes, the Coordination Service checks if the protocol type and output trigger a chained protocol:
- Status Sync detects batch complete → chain to Retrospective.
- Retrospective completes → chain to Backlog Grooming → chain to Batch Planning.
- Status Sync detects stuck item → chain to Escalation.
- Escalation resolves with re-plan decision → chain to Batch Planning.
- Operator idea arrives → PO refines → chain to Proposal Enrichment.

Chained protocols reference their parent ProtocolExecution in the trigger reason (trigger: chained, source: parent protocol identifier). This provides an audit trail of protocol chains.

## Error Handling

**PO session failure (crash or timeout):** The Coordination Service detects the session failure. If the session was a standalone analysis cycle, the cycle is skipped — the next scheduled tick will produce a fresh analysis. If the session was a protocol round, the ProtocolRound status is set to failed. The Coordination Service evaluates whether to retry the round (if retries remain) or mark the ProtocolExecution as failed and escalate to the operator.

**Tech Lead unavailable during protocol:** If the Tech Lead session fails or times out during a protocol round, the round is marked as skipped. The protocol proceeds on the degraded path defined in L1: Proposal Enrichment produces an "unassessed" enrichment, Backlog Grooming proceeds PO-only, Batch Planning escalates to the operator (cannot form a batch without technical assessment).

**Protocol convergence failure:** When Batch Planning cannot converge in one round (PO priorities and Tech Lead constraints are incompatible), both positions are packaged and presented to the operator for resolution. The ProtocolExecution status transitions to escalated_to_operator. The operator's decision is recorded and the Coordination Service creates a Batch from the operator's chosen option.

**Protocol chain interruption:** If a protocol in a chain fails, the chain stops. The Coordination Service logs the interruption and surfaces it on the briefing page. The next scheduled trigger for the interrupted protocol type will restart the chain from that point.

**Stale SignalSnapshot:** If signal sources are temporarily unavailable (database unreachable, issue tracker API down), the Coordination Service assembles a partial snapshot with available data and flags the missing sources. The PO session receives the partial snapshot and can still produce proposals based on available signals, noting which signal sources were unavailable.

**Duplicate proposal detection:** The Coordination Service checks new proposals against existing active proposals (by related spec/issue references and proposal type). If a duplicate is detected, the new proposal is discarded and logged. This prevents the PO from re-proposing work that is already pending operator decision.
