---
id: ARCH-AC-PRODUCT-OWNER
type: architecture
domain: auto-claude
status: draft
version: 2
layer: 2
references: FUNC-AC-PRODUCT-OWNER
---

# ARCH-AC-PRODUCT-OWNER — Product Owner Agent

## Overview

The Product Owner Agent analyzes system signals and generates proposals for what to build next. It runs as a scheduled agent session spawned by the Coordination Service, reading signal sources to identify spec pipeline gaps, stale work, and backlog priorities, then producing structured proposals that require operator approval before becoming work requests.

In v2, the PO also operates the **Finding Approval Gate**: it evaluates findings already approved by the Tech Lead (`tl-approved`) and decides whether to recommend them to the operator (`po-approved`) or reject them (`po-rejected`). Ambiguous findings enter a `NeedsDiscussionEntry` queue surfaced during interactive sessions. The PO is also available in **Interactive Session** mode: the operator opens a conversation with the PO, which loads its current state (proposals, needs-discussion items, recent decisions) and executes decisions on the spot, writing to shared persistent state that the daemon's next autonomous cycle reads.

This spec defines the PO agent's internal architecture: signal aggregation, proposal generation, finding approval, interactive session state, and protocol participation. It complements ARCH-AC-COORDINATION (Proposal lifecycle, agent pool, PO scheduling, terminal interface) and ARCH-AC-KNOWLEDGE (knowledge store the PO reads from and writes to).

## Data Model

**SignalSnapshot** represents the aggregated input context for a PO analysis cycle. It contains: a unique identifier, the cycle timestamp, a spec pipeline summary (which specs have complete layer chains and which have gaps), an aggregate delivery summary (pass/fail rates and completion counts per repository — no detailed failure analysis), a backlog summary (open issues with labels, ages, and staleness flags), an active proposal summary (current proposals with statuses), a proposal history summary (recently decided proposals with outcomes and operator reasons), an operator idea inbox (pending idea submissions), a `pending_approvals` section (findings with `tl-approved` label that have not yet received a PO verdict — each entry contains: issue number, issue title, severity label, Tech Lead triage reason, and a `previously_rejected_by_po` flag), and a `needs_discussion` section (NeedsDiscussionEntry records awaiting operator input, ordered by creation time). The snapshot is assembled by the Coordination Service before spawning the PO session and is not persisted — it is a transient input document.

**FindingApprovalDecision** represents the PO's verdict on a single `tl-approved` finding. It contains: a unique identifier, `finding_issue_number` (the GitHub issue number of the finding), `decision` (one of: `approve`, `reject`, `defer`, `needs_discussion`), `reason` (text explanation), `cycle_date` (ISO date string, used for daily cap accounting), `prior_rejection_count` (number of previous PO rejections for this finding — allows the operator to see escalation history), and `timestamp` (creation timestamp). Records are immutable once written. A finding with decision `defer` is re-evaluated on the next PO cycle without label change. A finding with decision `needs_discussion` moves to the NeedsDiscussionEntry queue.

**POApprovalDailyCap** tracks the number of PO finding approvals on a given calendar day. It contains: `date` (ISO date string, primary key), `approval_count` (count of decisions with `approve` made on this date), and `cap` (snapshot of the configured cap value at the time the first decision was written for this date — prevents mid-day config changes from retroactively affecting the cap). The Coordination Service reads this record before processing each approval from the PO session output, stopping when the cap is reached and deferring remaining approvals to the next cycle.

**NeedsDiscussionEntry** represents a finding or decision item that the PO cannot resolve autonomously and needs operator input on. It contains: a unique identifier, an `item_type` (one of: `finding_approval`, `proposal_decision`), `finding_issue_number` (nullable, set for `finding_approval` items), `proposal_id` (nullable, set for `proposal_decision` items), `context` (structured description of why the PO is uncertain and what input would help — includes the Tech Lead's triage reason and any prior rejection history), `status` (one of: `pending`, `discussed`, `overridden`), `operator_decision` (nullable — set when the operator acts on this item during an interactive session), `created_at`, and `resolved_at` (nullable). Items remain in the queue until the operator resolves them in an interactive session or the underlying finding/proposal is resolved by other means.

**POInteractiveState** represents the shared persistent state read and written by both daemon PO sessions and interactive PO sessions. It contains: `pending_proposals` (proposals awaiting operator decision, with summaries), `needs_discussion_queue` (current NeedsDiscussionEntry records with status `pending`), `recent_autonomous_decisions` (a rolling window of autonomous decisions made since the last interactive session — each entry contains the decision type, item reference, outcome, and timestamp; cleared after each interactive session review), `triage_queue_summary` (current `tl-approved` findings count and oldest age, for interactive context), and `last_daemon_cycle_at` (timestamp of the last autonomous PO cycle). This record is stored at a known path in file-based state storage, updated by the Coordination Service after each daemon cycle and after each interactive session.

**ProtocolExecution** (unchanged from v1) — see v1 for full definition.

**ProtocolRound** (unchanged from v1) — see v1 for full definition.

**ProposalEnrichment** (unchanged from v1) — see v1 for full definition.

**ProtocolSchedule** (unchanged from v1) — see v1 for full definition.

## API Contract

The PO Agent does not expose its own service API. It operates as a session spawned by the Coordination Service and produces structured output that the Coordination Service processes. The interfaces below describe the contract between the Coordination Service and the PO session.

**PO daemon session input:** The Coordination Service assembles a session context containing: the SignalSnapshot (including `pending_approvals` and `needs_discussion` sections), the protocol execution context (if the session is a protocol round rather than a standalone analysis cycle), relevant knowledge records from the Knowledge Service (business observations and proposal history), and operating instructions (the PO prompt template).

**PO daemon session output — analysis cycle:** The session produces: an array of raw proposals (each with: title, rationale, proposal type, related spec or issue references, estimated scope), an array of FindingApprovalDecisions (one per evaluated finding — all findings in `pending_approvals` must receive a verdict), and any new NeedsDiscussionEntry items (for findings the PO cannot decide). The Coordination Service processes each section independently.

**PO daemon session output — protocol round:** (Unchanged from v1.) The session produces a structured document specific to the protocol type.

**PO interactive session input:** The Coordination Service assembles an interactive context containing: the current POInteractiveState (pending proposals, needs-discussion queue, recent autonomous decisions, triage queue summary), relevant knowledge records, and the interactive PO prompt template (which instructs the PO to surface all pending items proactively and execute decisions via available tools). The interactive session has expanded tool access including the issue tracker mutation tool for applying labels and posting comments.

**PO interactive session output:** The PO executes decisions on the spot within the session (applies labels via issue tracker tool, updates proposal statuses, resolves NeedsDiscussionEntry items). After the session, the Coordination Service reads the updated state from POInteractiveState and flushes any pending decisions that were not already executed during the session (for any items where the PO queued a decision but did not execute it inline).

**Protocol trigger notifications:** (Unchanged from v1.)

## System Boundaries

The PO agent is a session-based component — it has no persistent process. The Coordination Service spawns PO sessions on schedule, on protocol triggers, and on operator request (interactive). The following describes how the PO connects to each system and what it owns, reads, and writes.

**Coordination Service → PO Agent (daemon):** The Coordination Service assembles a SignalSnapshot (now including `pending_approvals` and `needs_discussion` sections) and spawns a PO session via Session Runtime. It processes the session output: creates Proposals, records FindingApprovalDecisions, applies GitHub label transitions (adding `po-approved` or `po-rejected`), creates NeedsDiscussionEntry records, and updates POInteractiveState.

**Coordination Service → PO Agent (interactive):** The operator requests an interactive session via the terminal interface or dashboard. The Coordination Service assembles a POInteractiveState-based context and spawns an interactive PO session with expanded tool access. After the session, the Coordination Service reconciles any remaining pending decisions from POInteractiveState.

**Knowledge Service → PO Agent (read-only):** The Coordination Service queries the Knowledge Service for business_observation records relevant to the PO's current cycle and includes them in the session context. The PO does not call the Knowledge Service directly.

**PO Agent → Tech Lead Agent (mediated):** (Unchanged from v1.) PO and Tech Lead never communicate directly. All protocol exchanges are mediated by the Coordination Service.

**Operator → PO Agent (indirect, daemon):** Operators interact with the PO through the Coordination Service's terminal interface and the Dashboard. Idea submissions, proposal approvals/rejections, and priority changes flow through the Coordination Service into the PO's next SignalSnapshot.

**Operator → PO Agent (direct, interactive):** The operator opens an interactive session. The PO loads its current state and executes decisions on the spot. Decisions are written to POInteractiveState and executed immediately (labels applied via issue tracker tool within the session).

**PO Agent OWNS:** Signal analysis logic (within session), proposal generation logic (within session), finding approval decisions (within session, enforced within daily cap), business priority assessment (within protocol rounds), POInteractiveState updates (flushed by Coordination Service after each session).

**PO Agent READS (via SignalSnapshot/POInteractiveState assembled by Coordination Service):**
- Specification directory — for pipeline gap analysis.
- Aggregate delivery outcomes — from run history (pass/fail rates, completion counts per repository). The PO never reads detailed failure reasons or phase breakdowns (Tech Lead territory).
- Proposal history — from the Knowledge Service and from the Proposal store.
- Issue backlog — open issues with labels, ages.
- Operator idea inbox — from the IdeaSubmission store.
- Pending approvals — `tl-approved` findings awaiting PO verdict (new in v2).
- Needs-discussion queue — NeedsDiscussionEntry records pending operator input (new in v2).
- POInteractiveState — shared persistent state for interactive session initialization (new in v2).

**PO Agent WRITES (via structured session output processed by Coordination Service):**
- Raw proposals → Coordination Service creates Proposal records.
- Protocol round outputs → Coordination Service stores as ProtocolRound entries.
- Business-level retrospective lessons → Coordination Service submits to Knowledge Service as business_observation records with lifecycle status "candidate."
- FindingApprovalDecisions → Coordination Service records and applies label transitions (new in v2).
- NeedsDiscussionEntry items → Coordination Service creates records in the queue (new in v2).
- POInteractiveState updates (daemon: partial update via session output; interactive: in-session mutations via tools) (new in v2).

**PO Agent NEVER:**
- Reads detailed failure analysis (Tech Lead territory).
- Performs code-level analysis or reads source files.
- Creates work requests directly (operator approval required).
- Modifies specs directly (L0 boundary).
- Schedules its own execution.
- Auto-approves its own proposals.
- Approves findings beyond the daily cap (Coordination Service enforces the cap).

**Operator bypass — `auto-fix-approved` label (L1 scenario: Operator overrides triage via auto-fix-approved):**
The operator may manually label a finding `auto-fix-approved` to bypass the TL/PO triage lifecycle entirely. Work Detection (defined in ARCH-AC-COORDINATION) treats `auto-fix-approved` findings as eligible for bug-fix work regardless of whether TL triage or PO approval has occurred. This preserves the operator's authority to fast-track urgent fixes. The PO agent is not involved in this path — it is a Work Detection boundary exception. The PO's finding approval cap and daily quota do not apply to `auto-fix-approved` findings.

**Coordination Service responsibilities:**
- Spawns PO daemon sessions on schedule and on protocol triggers.
- Spawns PO interactive sessions on operator request.
- Assembles SignalSnapshot (including `pending_approvals` and `needs_discussion`) before each daemon session.
- Assembles POInteractiveState context before each interactive session.
- Processes PO session output: creates Proposals, records FindingApprovalDecisions, applies GitHub label transitions, manages NeedsDiscussionEntry queue, updates POInteractiveState.
- Enforces finding approval daily cap (POApprovalDailyCap).
- Enforces operator approval for all proposals and findings (L0 boundary).
- Manages ProtocolExecution lifecycle.

**Operational constraints:** The PO analysis cycle runs on a configurable schedule (default: every 30 minutes). Event-driven triggers are debounced (default: 5 minutes). Proposals past expiry (default: 7 days) are transitioned to `expired` by the Coordination Service. Finding approval daily cap: configurable, default 5 (independent of Tech Lead triage cap, per L1). The PO operates at spec layers 0 through 2 only. Interactive sessions share the same agent identity (same prompt, same boundaries) but have expanded tool access. The system supports exactly one PO agent instance.

## Event Flows

**Finding Approval Gate (daemon cycle):**

1. As part of the PO analysis cycle (step 2 of the PO analysis cycle flow), the Coordination Service queries GitHub for issues with `tl-approved` label that do not yet have `po-approved` or `po-rejected`. It includes these as the `pending_approvals` section of the SignalSnapshot.
2. The PO session evaluates each pending approval. For each finding, the PO produces a FindingApprovalDecision: `approve`, `reject`, `defer`, or `needs_discussion`.
3. The Coordination Service processes FindingApprovalDecisions:
   - For each `approve` decision: check POApprovalDailyCap for the current date. If `approval_count < cap`, post an audit comment on the GitHub issue explaining the PO's recommendation, apply `po-approved` label, increment `approval_count`. If `approval_count >= cap`, convert the decision to `defer` and log that it was cap-deferred.
   - For each `reject` decision: post a comment explaining the reason, apply `po-rejected` label, remove `tl-approved` label.
   - For each `defer` decision: no label change. The finding remains in `pending_approvals` for the next cycle.
   - For each `needs_discussion` decision: create a NeedsDiscussionEntry record. No label change. The finding is excluded from `pending_approvals` on the next daemon cycle until the operator resolves the entry.
4. The Coordination Service updates POInteractiveState with the current `needs_discussion_queue` and `recent_autonomous_decisions`.

**Operator Confirmation of PO-Approved Finding:**

1. The Coordination Service surfaces `po-approved` findings to the operator via the briefing page and as items in the POInteractiveState.
2. The operator confirms a finding (via dashboard, briefing action, or interactive session command). The Coordination Service receives the confirmation.
3. The Coordination Service removes `po-approved`, adds `auto-fix-approved` (making the finding eligible for work detection), and records the operator decision.
4. If the operator rejects a `po-approved` finding: the Coordination Service removes `po-approved`, adds `po-rejected` with operator comment, and records the rejection.

**Tech Lead re-triage after PO rejection:**

1. A finding with `po-rejected` label may be re-evaluated by the Tech Lead on a subsequent triage cycle (with new evidence or changed circumstances).
2. The Tech Lead adds a comment referencing the prior rejection and new justification, then removes `po-rejected` and re-applies `tl-approved`.
3. On the next PO daemon cycle, the finding re-enters `pending_approvals` with `previously_rejected_by_po: true` in its SignalSnapshot entry, allowing the PO to consider the escalation history.

**Interactive Session (operator-initiated):**

1. The operator requests an interactive PO session via the terminal interface (`claude -p "Start interactive PO session"`) or dashboard action.
2. The Coordination Service assembles the POInteractiveState context (pending proposals, needs-discussion queue, recent autonomous decisions, triage queue summary) and spawns an interactive PO session via Session Runtime with expanded tool access.
3. The PO session loads its state and proactively surfaces items requiring operator input, in priority order: (a) needs-discussion findings with context, (b) pending proposals awaiting operator decision, (c) recent autonomous decisions for review.
4. The operator makes decisions during the conversation. The PO executes each decision on the spot using its available tools:
   - Finding approvals: applies labels via issue tracker tool, posts audit comment.
   - Finding rejections: applies `po-rejected`, removes `tl-approved`, posts comment.
   - Proposal approvals: applies `auto-fix-approved` or equivalent, records operator approval.
   - Proposal rejections: archives with reason.
   - Decision overrides: reverts any recent autonomous decision the operator disagrees with.
5. Each executed decision is written to the POInteractiveState `recent_autonomous_decisions` log and the relevant NeedsDiscussionEntry is updated to `discussed` status with the operator's decision recorded.
6. After the session, the Coordination Service reads the updated POInteractiveState, flushes any queued decisions not yet applied (in case the session ended before the PO could execute all of them), and clears the `recent_autonomous_decisions` rolling window (resetting it for the next interactive session).

**PO analysis cycle (standalone — not part of a protocol):** (Unchanged from v1, with addition of Finding Approval Gate in step 2–3.)

1. The Coordination Service's PO schedule tick fires (default: every 30 minutes) or an IdeaSubmission arrives (debounced).
2. The Coordination Service assembles a SignalSnapshot: reads spec directory, queries run history, queries Proposal store, queries issue backlog, reads IdeaSubmission inbox, queries Knowledge Service, and (new in v2) queries `tl-approved` findings for `pending_approvals` section.
3. The Coordination Service spawns a PO daemon session.
4. The PO session analyzes signals, generates proposals, and (new in v2) produces FindingApprovalDecisions.
5. The Coordination Service processes: creates Proposals, initiates Proposal Enrichment, and (new in v2) processes FindingApprovalDecisions with cap enforcement and applies label transitions.
6. The Coordination Service updates POInteractiveState.
7. The Coordination Service sweeps expired Proposals.

**Protocol flows:** (Unchanged from v1.) See v1 for Proposal Enrichment, Batch Planning, Backlog Grooming, Status Sync, Retrospective, Escalation, and Protocol Composition event flows.

## Error Handling

**PO daemon session failure:** (Unchanged from v1.) The cycle is skipped; the next scheduled tick produces a fresh analysis. If a protocol round, the ProtocolRound is failed and the Coordination Service evaluates retry or escalation.

**Interactive session failure:** If the interactive PO session crashes or times out before completing, the Coordination Service reads the POInteractiveState for any decisions written before the crash and flushes them. Any remaining NeedsDiscussionEntry items stay pending for the next interactive session.

**Finding approval cap exceeded:** The Coordination Service converts excess approvals to `defer` (not `reject`) — the finding re-enters `pending_approvals` the next cycle. No label change. The Coordination Service logs that the cap was reached. This is not an error condition.

**Tech Lead unavailable during protocol:** (Unchanged from v1.) Proposal Enrichment produces "unassessed" enrichment; Backlog Grooming proceeds PO-only; Batch Planning escalates.

**Protocol convergence failure:** (Unchanged from v1.) Both positions go to the operator.

**Stale SignalSnapshot:** (Unchanged from v1.) Partial snapshot with missing sources flagged.

**Duplicate proposal detection:** (Unchanged from v1.) New proposal discarded and logged.

**NeedsDiscussionEntry staleness:** If a NeedsDiscussionEntry has been pending for longer than a configurable threshold (default: 3 days), the Coordination Service includes a staleness flag in the interactive session context and in briefing summaries, prompting the operator to address it.
