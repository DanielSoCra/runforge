---
id: ARCH-AC-TECH-LEAD
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-TECH-LEAD
---

# ARCH-AC-TECH-LEAD — Tech Lead Agent

## Overview

The Tech Lead Agent is a scheduled analysis agent within the Coordination Service's agent pool. It monitors code health by consuming a pre-computed signal digest, generates technical proposals that flow through the Product Owner for priority assessment, participates in structured protocols via orchestrator-mediated exchanges, and interacts with the Knowledge Service to both consume findings and produce distilled pitfalls. The Tech Lead operates at the L2-L3 layer — it never makes business-level decisions.

The Tech Lead is not a long-running process. It is a session spawned by the Coordination Engine on a configurable schedule (default: 2 hours) or triggered by specific events (run failures, new review findings, batch retrospective completion). Each session receives a signal digest as context, performs analysis, and produces structured output. The Coordination Engine interprets the output and takes action (stores proposals, triggers protocols, updates state).

## Data Model

**TechnicalProposal** represents a technical improvement proposed by the Tech Lead, awaiting PO priority assessment. It contains: a unique identifier, a proposal type (one of: `debt_reduction`, `quality_improvement`, `architecture_concern`, `dependency_update`, `failure_investigation`), a title, technical evidence (structured description of findings that motivated the proposal), affected areas (array of artifact path patterns), a risk assessment, an estimated effort (or an "unassessed" flag when the Tech Lead cannot reliably estimate), a status (`generated`, `forwarded`, `rejected_by_po`, `pending_operator`, `approved`, `rejected_by_operator`, `expired`), a PO decision record (nullable — contains the PO's priority assessment and reason when the PO acts), an operator decision record (nullable — contains the operator's decision and notes), a reference to a prior rejection (nullable — links to a previously rejected TechnicalProposal when re-proposing with stronger evidence), an expiry timestamp (configurable, default 7 days from creation), and timestamps for creation, PO decision, and operator decision.

The TechnicalProposal lifecycle: `generated` → PO evaluates → either `forwarded` (PO adds priority context, routes to operator) or `rejected_by_po` (PO records reason). If forwarded: `forwarded` → `pending_operator` → operator decides → `approved` (creates work request) or `rejected_by_operator`. From any non-terminal status: `expired` when current time exceeds the expiry timestamp.

When a TechnicalProposal is rejected by the PO, the Tech Lead may generate a new proposal on a subsequent cycle with a `prior_rejection` reference, allowing the operator to see the escalation history.

**TechnicalEnrichment** represents the Tech Lead's contribution to a PO-initiated business proposal. It contains: a unique identifier, a reference to the PO's Proposal, an effort estimate (or "unassessed" flag), a dependency analysis (array of identified dependencies), technical risks (array of risk descriptions), prerequisite work (array of references to issues or specs that should be completed first), and a creation timestamp. When the Tech Lead cannot produce a reliable enrichment (unfamiliar area, insufficient data), it returns an enrichment with the "unassessed" flag set, so the proposal reaches the operator with incomplete technical review.

**SignalDigest** represents the pre-computed bundle of signals assembled by the Coordination Engine for each Tech Lead analysis cycle. It contains: a unique identifier, a cycle trigger (one of: `scheduled`, `run_failure`, `new_findings`, `retrospective_complete`), and signal sections:
- **review_findings**: active KnowledgeRecords of type `review_finding` with severity and affected areas, queried from the Knowledge Service.
- **run_outcomes**: recent run completion records with failure reasons, error categories, phase-level breakdowns, and retry counts, queried from the Control Plane's run state.
- **drift_indicators**: comparison results between L3 spec expectations and actual implementation, computed by a deterministic diff process against the traceability map.
- **deferred_work**: aggregated counts of deferred work markers per code area, computed by a deterministic scan.
- **test_health**: recent test results and coverage trends, queried from run metadata.
- **dependency_risks**: outdated packages and known security advisories, computed by a deterministic dependency audit.
- **active_proposals**: current TechnicalProposals in non-terminal status, for context on what has already been proposed.
- **prior_rejections**: TechnicalProposals rejected by the PO in the current or recent cycles, so the Tech Lead can decide whether to re-propose with stronger evidence.

The signal digest is assembled deterministically by the Coordination Engine before spawning the Tech Lead session. The Tech Lead session receives it as read-only context.

**ProtocolExchange** represents the record of a single protocol execution between agents. It contains: a unique identifier, a protocol type (one of: `proposal_enrichment`, `batch_planning`, `backlog_grooming`, `escalation`, `status_sync`, `retrospective`), the initiating agent type, a sequence of exchange steps (each containing: the agent type that produced it, the structured output, and a timestamp), the final outcome (structured result of the protocol), and timestamps for start and completion.

ProtocolExchanges are stored for audit and for feeding into retrospective analysis. The Coordination Engine creates and manages them — agents do not directly write to them.

**Extensions to existing models:**

- **WorkerClaim** (ARCH-AC-COORDINATION) gains a new agent type value: `tech_lead`. The Tech Lead is a pooled agent with min 0, max 1 — it is spawned on schedule, not kept running.
- **GlobalSettings** (ARCH-AC-COORDINATION) gains: `tech_lead_interval` (schedule for the Tech Lead agent, default 7200 seconds / 2 hours), `tech_lead_proposal_expiry` (default 7 days), `recurring_finding_threshold` (number of records sharing a root-cause tag before triggering a systemic proposal, default 3), `drift_scan_paths` (array of artifact patterns to include in spec-code drift analysis).

## API Contract

The Tech Lead Agent's functionality is exposed through operations on the Coordination Service, not as a separate service.

**Tech Lead analysis operations:**

- `trigger_tech_lead_cycle` — Called by the Coordination Engine's scheduler or by event handlers (run failure, new findings). Parameters: cycle trigger type. Effect: assembles a SignalDigest, spawns a Tech Lead session via Session Runtime, parses the structured output, stores any generated TechnicalProposals, and triggers protocol exchanges if the output requests them. Returns: acknowledgment with the number of proposals generated.

- `get_technical_proposals` — Called by the PO Agent session (via context injection) and by the dashboard. Parameters: optional status filter. Returns: array of TechnicalProposals matching the filter.

**PO-facing operations (for protocol mediation):**

- `submit_po_verdict_on_technical_proposal` — Called by the Coordination Engine after a PO session evaluates a TechnicalProposal. Parameters: proposal identifier, verdict (`forward` or `reject`), priority assessment, reason. Effect: transitions the proposal to `forwarded` or `rejected_by_po`, records the PO decision. If forwarded, transitions to `pending_operator` for dashboard visibility.

- `submit_technical_enrichment` — Called by the Coordination Engine after a Tech Lead session enriches a PO business proposal. Parameters: PO Proposal identifier, effort estimate (or "unassessed"), dependency analysis, technical risks, prerequisite work. Effect: stores the TechnicalEnrichment and links it to the PO's Proposal.

**Operator-facing operations:**

- `approve_technical_proposal` — Called by the operator via dashboard or terminal. Parameters: proposal identifier, optional decision notes. Effect: transitions to `approved`, creates a work request. Returns: created issue number.

- `reject_technical_proposal` — Called by the operator. Parameters: proposal identifier, optional decision notes. Effect: transitions to `rejected_by_operator`.

**Protocol operations:**

- `execute_protocol` — Called by the Coordination Engine when a protocol trigger fires. Parameters: protocol type, initiating context (varies by protocol type). Effect: creates a ProtocolExchange, spawns agent sessions in the defined sequence, passes structured output between sessions, records each step, stores the final outcome. Returns: the completed ProtocolExchange.

**Signal digest assembly operations (internal):**

- `assemble_signal_digest` — Called internally before spawning a Tech Lead session. Parameters: cycle trigger type. Effect: queries all signal sources (Knowledge Service, Control Plane run state, traceability map, deferred work scan, test results, dependency audit), assembles a SignalDigest. Returns: the assembled digest.

## System Boundaries

**Tech Lead Agent (as a component within the Coordination Service) OWNS:** TechnicalProposal, TechnicalEnrichment, SignalDigest assembly, Tech Lead session scheduling, and proposal lifecycle management.

**Tech Lead Agent IS ORCHESTRATED BY:** the Coordination Engine, which spawns Tech Lead sessions on schedule or on events, mediates protocol exchanges, and manages the proposal lifecycle state machine.

**Tech Lead Agent READS FROM:**
- Knowledge Service — review findings (record type: `review_finding`), technical pitfalls, root-cause tag queries via the existing "Match records" and "Query by root cause" APIs.
- Control Plane — run completion records with failure details.
- Traceability map — spec-to-code mappings for drift detection.
- Codebase — deferred work marker counts (deterministic scan).
- Test infrastructure — test results and coverage trends.
- Dependency metadata — package versions and security advisories (deterministic audit).

**Tech Lead Agent WRITES TO:**
- Knowledge Service — distilled pitfalls from retrospectives (record type: `technical_pitfall`, origin: `retrospective-tech-lead`) via the existing "Store record" API.
- Coordination Service — TechnicalProposals, TechnicalEnrichments.

**Tech Lead Agent PARTICIPATES IN:** all six L1 protocols, orchestrated by the Coordination Engine's ProtocolExecutor. The Tech Lead never directly communicates with the PO Agent — all exchange is mediated by the Coordination Engine.

**Relationship to ARCH-AC-COORDINATION:** The Tech Lead is a new agent type within the Coordination Service's agent pool. The Coordination Service gains the ProtocolExecutor responsibility and the TechnicalProposal/TechnicalEnrichment data models. The existing PO cycle in ARCH-AC-COORDINATION is extended — the PO now also evaluates TechnicalProposals during its cycle.

**Relationship to ARCH-AC-KNOWLEDGE:** The Tech Lead consumes and produces KnowledgeRecords through the Knowledge Service's existing APIs. No changes to the Knowledge Service are required — the record types (`review_finding`, `technical_pitfall`) and consumer sets (technical leadership sessions) are already defined in ARCH-AC-KNOWLEDGE.

**Relationship to ARCH-AC-SESSION-RUNTIME:** Tech Lead sessions are spawned through Session Runtime like all other agent types. A new AgentDefinition is registered for the `tech_lead` session type with appropriate model tier, timeout, budget cap, and containment rules.

## Event Flows

**Scheduled analysis flow:**

1. The Coordination Engine's scheduler fires the Tech Lead tick (default: every 2 hours).
2. The engine calls `assemble_signal_digest` with trigger type `scheduled`.
3. The digest assembly queries all signal sources: Knowledge Service for review findings and root-cause patterns, Control Plane for recent run outcomes, traceability map for drift indicators, codebase scan for deferred work density, test infrastructure for health metrics, dependency audit for risks. It also loads active TechnicalProposals and prior rejections for context.
4. The engine spawns a Tech Lead session via Session Runtime with the signal digest as context.
5. The Tech Lead session analyzes the digest and produces structured output: zero or more TechnicalProposals and optional protocol trigger requests.
6. The engine parses the output, stores TechnicalProposals, and enqueues any requested protocol triggers.

**Event-driven analysis flow:**

1. An event occurs: a run fails, new review findings are stored, or a retrospective completes.
2. The Coordination Engine detects the event and fires `trigger_tech_lead_cycle` with the appropriate trigger type.
3. The digest assembly includes event-specific emphasis (e.g., for `run_failure`, the failing run's details are highlighted).
4. The flow continues as in steps 4-6 of the scheduled flow.
5. Event-driven cycles are debounced — if multiple events fire within a configurable window (default: 5 minutes), they are batched into a single cycle.

**Tech Lead proposal flow through PO:**

1. A Tech Lead analysis cycle produces one or more TechnicalProposals (status: `generated`).
2. On the PO's next cycle (or immediately if the PO is idle), the Coordination Engine includes pending TechnicalProposals in the PO's context.
3. The PO session evaluates each proposal against business priorities and produces a verdict for each: `forward` (with priority context) or `reject` (with reason).
4. The Coordination Engine calls `submit_po_verdict_on_technical_proposal` for each verdict.
5. Forwarded proposals transition to `pending_operator` and appear on the dashboard for operator decision.
6. Rejected proposals are recorded. On the next Tech Lead cycle, rejections appear in the signal digest's `prior_rejections` section — the Tech Lead may re-propose with stronger evidence.

**PO business proposal enrichment flow:**

1. The PO generates a business proposal (Proposal in ARCH-AC-COORDINATION).
2. The Coordination Engine spawns a Tech Lead session with the raw proposal as context, requesting enrichment.
3. The Tech Lead session produces a TechnicalEnrichment: effort estimate, dependency analysis, technical risks, prerequisite work. If it cannot assess the area, it returns the "unassessed" flag.
4. The Coordination Engine stores the enrichment and links it to the PO's Proposal.
5. The PO's next session receives the enrichment as context and may adjust priority or scope before the proposal reaches the operator.

**Protocol execution flow (generalized):**

1. A protocol trigger fires (event-driven or schedule-driven).
2. The Coordination Engine's ProtocolExecutor creates a ProtocolExchange record.
3. For each step in the protocol sequence:
   a. Assemble context: prior steps' structured outputs plus relevant state.
   b. Spawn the appropriate agent session via Session Runtime.
   c. Collect structured output.
   d. Record the step in the ProtocolExchange.
4. Store the final outcome in the ProtocolExchange.
5. Execute any resulting actions (store proposals, update batch, trigger follow-up protocols).

**Protocol-specific sequences:**

- **Proposal Enrichment (PO-initiated):** PO generates proposal → Tech Lead enriches → PO reviews enrichment, adjusts → operator sees enriched proposal.
- **Proposal Enrichment (Tech Lead-initiated):** Tech Lead generates proposal → PO evaluates priority → forward or reject.
- **Batch Planning:** PO brings prioritized backlog → Tech Lead brings dependency graph, capacity, health, prospective risk check (from Knowledge Service) → single exchange round → output: batch definition. If no convergence, both positions go to operator.
- **Backlog Grooming:** PO brings current backlog + new signals → Tech Lead brings updated technical landscape → output: re-prioritized backlog.
- **Escalation (Tech Lead):** Tech Lead raises blocker with options → PO evaluates → decision.
- **Escalation (PO):** PO raises priority shift → Tech Lead evaluates capacity impact → joint decision.
- **Status Sync:** Tech Lead reports active work, stuck items, completions → PO reports priority changes, ideas, proposal outcomes → output: shared state update, may trigger other protocols.
- **Retrospective:** PO brings delivery expectations vs actuals → Tech Lead brings failure analysis, patterns, utilization, finding trends → output: lessons learned. Tech Lead distills technical lessons into pitfalls for the Knowledge Service. PO records business observations. Actionable items become proposals.

**Retrospective-to-knowledge flow:**

1. A Retrospective protocol completes, producing lessons learned.
2. The Tech Lead's retrospective output includes structured pitfall records: each with artifact patterns, description, severity, root-cause tag.
3. The Coordination Engine submits these to the Knowledge Service via the "Store record" API with record type `technical_pitfall` and origin `retrospective-tech-lead`.
4. Records enter the Knowledge Service as candidates (requiring operator approval before injection), per ARCH-AC-KNOWLEDGE's retrospective capture flow.
5. The Knowledge Service's systemic proposal detection monitors root-cause tag frequency. When a tag exceeds the recurring finding threshold (default: 3), a SystemicProposal is generated and routed to the Tech Lead for refinement.

**Prospective risk check flow (during Batch Planning):**

1. Before the Batch Planning protocol, the Coordination Engine queries the Knowledge Service's "Query prospective risks" endpoint with the artifact locations of all candidate batch items.
2. High-severity records matching planned work areas are included in the Tech Lead's Batch Planning context.
3. The Tech Lead factors these historical failures into effort estimates and risk assessments during the protocol exchange.

**Proposal expiry flow:**

1. Periodically (alongside the Tech Lead's scheduled cycle), the Coordination Engine sweeps TechnicalProposals with expiry timestamps in the past.
2. Non-terminal proposals are transitioned to `expired`.
3. Expired proposals do not appear in the PO's evaluation context or the operator's dashboard active view.

**Metrics computation flow:**

1. Periodically (configurable, aligned with the retrospective cadence), the Coordination Engine computes Tech Lead effectiveness metrics from existing data stores:
   - **Finding-to-fix rate:** KnowledgeRecords of type `review_finding` that have corresponding completed work requests, divided by total findings.
   - **Spec-code drift reduction:** drift items in the SignalDigest that were present in a prior cycle but absent in the current one, counted per cycle.
   - **Failure pattern detection speed:** timestamp delta between the first run failure matching a pattern and the TechnicalProposal creation for that pattern.
   - **Repeat gotcha rate:** KnowledgeRecords sharing a root-cause tag, divided by total records, measured over a rolling window.
   - **Dependency risk response time:** timestamp delta between a security advisory appearing in the dependency audit and a TechnicalProposal for the affected packages.
2. Metrics are stored as time-series data points and surfaced on the dashboard.
3. Retrospective protocol sessions receive recent metrics as context input.

## Error Handling

**Tech Lead session failure:** The session is treated like any other agent session failure in the Coordination Service. The WorkerClaim is set to `failed`. The Coordination Engine logs the failure and retries on the next scheduled cycle. No proposals are generated from a failed session.

**Signal digest assembly failure (partial):** If one signal source is unavailable (e.g., dependency audit times out), the digest is assembled with the available signals and a marker indicating which sources are missing. The Tech Lead session receives the partial digest and can still analyze available signals. The missing source is logged for operator visibility.

**Signal digest assembly failure (total):** If critical sources (Knowledge Service, Control Plane) are both unreachable, the cycle is skipped and retried on the next tick. Logged as a warning.

**PO unavailable for proposal evaluation:** TechnicalProposals remain in `generated` status. On the PO's next cycle, they are included for evaluation. If proposals approach their expiry timestamp without PO evaluation, they are flagged on the dashboard under "Needs Attention."

**Tech Lead cannot assess effort:** The TechnicalEnrichment is returned with the "unassessed" flag. The proposal proceeds to the operator with incomplete technical review — the operator sees that the Tech Lead could not produce a reliable estimate. This is a defined degraded path, not an error.

**Protocol exchange timeout:** If an agent session within a protocol exchange exceeds its timeout, the ProtocolExecutor records the timeout in the exchange, returns a partial result, and allows the protocol to complete with whatever output was produced before the timeout. The Coordination Engine may trigger a degraded-path action (e.g., PO grooms backlog solo if Tech Lead times out during grooming).

**Escalation to unavailable agent:** If the receiving agent (PO or Tech Lead) is mid-session when an escalation arrives, the escalation is queued and processed on the next tick. Time-critical escalations (budget exceeded, system down) bypass the protocol and go directly to the operator, as defined in the L1 spec.

**Duplicate proposal detection:** Before storing a new TechnicalProposal, the Coordination Engine checks for active proposals with overlapping affected areas and the same proposal type. If a duplicate is detected, the existing proposal's evidence is updated rather than creating a new proposal. This prevents proposal churn from repeated analysis cycles identifying the same issue.

**Metrics computation failure:** Metrics are advisory. If computation fails (data unavailable, query timeout), the failure is logged and the metrics are skipped for that cycle. Previous metric values remain on the dashboard. No escalation needed.
