---
id: ARCH-AC-KNOWLEDGE
type: architecture
domain: runforge
status: draft
version: 2
layer: 2
references: FUNC-AC-LEARNING
---

# ARCH-AC-KNOWLEDGE — Knowledge Service

## Overview

The Knowledge Service accumulates, structures, and distributes institutional knowledge across sessions. It manages a unified knowledge store that holds multiple record types — technical pitfalls, business observations, operator corrections, and review findings — each governed by type-specific lifecycle policies. It captures observations from session output and retrospective protocols, persists them, matches them against artifact locations for injection into future sessions, promotes high-frequency observations to permanent documentation, detects recurring root causes to trigger systemic proposals, provides prospective checks for batch planning, maintains reference implementations (exemplars) for consistency comparison, and proposes instruction improvements based on empirical outcomes. All permanent changes require operator approval.

## Data Model

**KnowledgeRecord** is the base entity for all institutional knowledge. It contains: a unique identifier, a record type (see RecordType below), an array of artifact patterns, a description, the source identifier (work request, retrospective, or review that produced it), a confidence score, a creation timestamp, a hit count (incremented each time the record is matched and injected), a lifecycle status (candidate, active, promoted, or archived — see Lifecycle Status below), an origin type (autonomous, operator, retrospective-tech-lead, or retrospective-po), a priority tier (normal or elevated), an optional root-cause tag (a short identifier grouping records that share the same underlying cause), and an optional reasoning section (a structured narrative capturing what changed, why the approach was chosen, what was discovered, and what approaches failed — populated for records originating from implementation sessions).

**RecordType** discriminates the kind of knowledge a record represents:
- **technical_pitfall** — a non-obvious pitfall discovered during implementation. Consumers: implementation sessions, review sessions.
- **business_observation** — a business-level lesson (e.g., "this type of proposal consistently gets rejected"). Consumers: product ownership sessions.
- **operator_correction** — a correction provided by the Operator during warmup or sampling review. Consumers: implementation sessions, review sessions. Always stored with priority tier "elevated."
- **review_finding** — an issue discovered by a proactive review agent. Consumers: technical leadership sessions.

Each record type shares the base KnowledgeRecord fields. The record type determines which lifecycle policy applies and which consumers receive the record during injection.

**LifecyclePolicy** defines type-specific rules for a record type. Each policy specifies: a promotion hit-count threshold, a promotion maximum age, an archival maximum age, an archival minimum hit count, an injection target set (which session types receive this record type), and an injection priority ordering rule.

**PolicyRegistry** maps each RecordType to its LifecyclePolicy. Default policies:
- technical_pitfall: promotion threshold 5 hits, archival after configurable max age with low hits, injected into implementation and review sessions, sorted by priority tier then hit count descending.
- business_observation: promotion threshold 3 hits (business lessons have fewer repetition opportunities), archival after configurable max age, injected into product ownership sessions only, sorted by recency.
- operator_correction: promotion threshold 2 hits, no archival (operator knowledge is never automatically discarded), injected into implementation and review sessions with elevated prominence.
- review_finding: promotion threshold 5 hits, archival after configurable max age, injected into technical leadership sessions, sorted by severity then recency.

**Lifecycle Status** tracks where a record is in its lifecycle:
- **candidate** — newly created from a retrospective or external source. Not yet available for injection. Requires operator approval to transition to active.
- **active** — available for matching and injection into sessions. Records created from session output (autonomous origin) enter directly as active. Records from retrospective protocols enter as candidate.
- **promoted** — merged into permanent documentation. Excluded from per-session injection.
- **archived** — removed from the active set due to staleness. Retained for historical reference.

**KnowledgeStore** is the persistent collection of all KnowledgeRecords. It is an append-only structured log. Each entry is a self-contained record. The store supports: appending new entries, querying by artifact pattern match with optional record-type filter, querying by root-cause tag, incrementing hit counts, transitioning lifecycle status, and archiving entries that meet staleness criteria per their lifecycle policy.

**Exemplar** represents a reference implementation for a deliverable type. It contains: the deliverable type name, a reference to the implementation, a quality score (assigned during review), and a creation timestamp.

**DeliverableType** categorizes the kind of artifact a unit produces (e.g., "data model," "service endpoint," "migration," "background job," "integration test suite"). Deliverable type is determined by:
- The L3 spec category referenced by the unit's governing specs (primary signal).
- The task graph's unit metadata, where the Coordinator assigns a type based on the unit's scope description.
- Operator-configured mappings from spec patterns to deliverable types.
If the type cannot be determined automatically, the unit is not exemplar-eligible. The Operator can manually assign deliverable types to completed work via the control interface.

**ExemplarStore** is the collection of all exemplars. It supports: looking up by deliverable type, replacing an exemplar when a superior implementation is identified, and listing all exemplars.

**Pattern** represents a recurring theme extracted from multiple observations. It contains: a key (short identifier), a description, a confidence score (derived from the frequency and consistency of the underlying observations), and an array of source spec identifiers.

**PromptProposal** represents a proposed change to operating instructions. It contains: the template name (which prompt or instruction file is being improved), the current version content, the proposed version content, a reasoning narrative (what empirical evidence supports the change), and a status (pending, approved, or rejected).

**PromptVersionHistory** tracks the evolution of each instruction file. It contains: the template name, an ordered array of versions (each with content, a timestamp, and an approval status).

**SystemicProposal** represents a proposed systemic fix for a recurring root cause. It contains: the root-cause tag, a description of the underlying problem, an array of related KnowledgeRecord identifiers, a proposed remediation approach, and a status (pending, approved, or rejected). Systemic proposals are routed to technical leadership for refinement before operator review.

## API Contract

**Store record** — Called by Session Runtime after each session completes, or by protocol handlers after retrospective completion. Request: an array of extracted observations (each with artifact patterns, description, and optional root-cause tag), the source identifier, an origin type, and a record type. Response: acknowledgment with the number of new records stored and the number of duplicates deduplicated (if a record with the same artifact patterns and similar description already exists, the hit count is incremented instead of creating a duplicate). Records with origin type "retrospective-tech-lead" or "retrospective-po" enter with lifecycle status "candidate." Records with origin type "autonomous" enter as "active."

**Store operator correction** — Called by the Validation Service when the Operator provides corrections during warmup approval or random sampling review. Request: an array of correction observations (each with artifact patterns and description), the source work request identifier. Response: acknowledgment. Corrections are stored as KnowledgeRecords with record type "operator_correction," origin type "operator," priority tier "elevated," and lifecycle status "active." Elevated records have a lower promotion threshold (default: 2 hits) and are injected with higher prominence.

**Approve candidate** — Called by the operator (via the Daemon Control Plane's control interface) to approve a candidate record for injection. Request: record identifier. Effect: transitions the record's lifecycle status from "candidate" to "active." The record becomes available for matching and injection.

**Reject candidate** — Called by the operator. Request: record identifier. Effect: transitions the record to "archived" status. It is never injected.

**Match records** — Called by Implementation Coordinator, Coordination Engine, and other services before assembling session context. Request: an array of expected artifact locations and an optional record-type filter. Response: an array of matching KnowledgeRecords, filtered to only those whose artifact patterns match the requested locations, whose lifecycle status is "active," and whose record type matches the filter (or all types if no filter). Records are sorted according to their type's injection priority ordering rule. Each matched record's hit count is incremented.

**Query prospective risks** — Called by the Coordination Engine before batch planning. Request: an array of planned work area artifact locations. Response: an array of active KnowledgeRecords matching the planned areas, filtered to high-severity entries (elevated priority tier, or hit count above a configurable severity threshold). This endpoint does NOT increment hit counts — it is a read-only risk assessment query.

**Query by root cause** — Called internally by the systemic proposal detection process, and externally by technical leadership sessions. Request: a root-cause tag. Response: all KnowledgeRecords sharing that tag, regardless of lifecycle status. Used to assess root-cause recurrence.

**Get exemplar** — Called by Validation Service during review for consistency comparison. Request: a deliverable type name. Response: the Exemplar for that type, or none if no exemplar exists yet.

**Store exemplar** — Called after a successful implementation is confirmed as the first or a superior version of a deliverable type. Request: deliverable type, implementation reference, quality score. Response: acknowledgment. If an exemplar already exists for that type, it is replaced only if the new quality score exceeds the existing one.

**Get promotion candidates** — Called by the operator (via the Daemon Control Plane's control interface) to review records eligible for promotion. Request: optional record-type filter. Response: an array of KnowledgeRecords where hit count is at or above the type's promotion threshold, age is below the type's promotion maximum age, lifecycle status is "active," and the record is not already promoted or archived.

**Approve promotion** — Called by the operator. Request: record identifier. Effect: the record's content is written to a proposal document for permanent documentation. On approval, the record is marked as promoted and stops being injected per-session.

**Reject promotion** — Called by the operator. Request: record identifier. Effect: mark the record as reviewed. It will not be re-proposed for a configured cooldown period, but continues to be injected per-session.

**Get systemic proposals** — Called by the operator to review proposed systemic fixes. Request: none. Response: an array of pending SystemicProposals.

**Approve systemic proposal** — Called by the operator. Request: proposal identifier. Effect: a work item is created to address the root cause. The proposal status transitions to "approved."

**Reject systemic proposal** — Called by the operator. Request: proposal identifier. Effect: the proposal is archived. The root-cause tag is marked with a cooldown period to prevent re-proposal.

**Get prompt proposals** — Called by the operator to review proposed instruction improvements. Request: none. Response: an array of pending PromptProposals.

**Approve prompt proposal** — Called by the operator. Request: proposal identifier. Effect: the proposed version replaces the current instruction content. The previous version is archived in the version history for rollback.

**Reject prompt proposal** — Called by the operator. Request: proposal identifier. Effect: the proposal is archived with "rejected" status. The current instructions remain unchanged.

**Trigger optimization** — Called periodically by the Daemon Control Plane (on a configurable schedule: after a threshold of completed work requests, or after a time interval). Request: none. Effect: spawn a prompt optimizer session via Session Runtime, analyze accumulated records, error patterns from recent runs, and review findings. Produce a PromptProposal for each instruction file that has actionable improvements. Proposals are stored as pending for operator review.

**Get patterns** — Called by Implementation Coordinator (and other services) when assembling session context or evaluating convention updates. Request: optional filter by source spec identifiers. Response: an array of Patterns matching the filter, or all patterns if no filter is provided. Each pattern includes its key, description, confidence score, and source spec identifiers.

**Store pattern** — Called internally by the pattern extraction process. Request: key, description, confidence score, array of source spec identifiers. Response: acknowledgment. If a pattern with the same key already exists, the confidence score is updated and source specs are merged. Otherwise, a new Pattern entry is created.

## System Boundaries

- Knowledge Service OWNS: knowledge store (all record types), exemplar store, pattern store, prompt proposals, systemic proposals, version history, promotion logic, archival logic, policy registry, candidate approval queue.
- Knowledge Service IS CALLED BY: Session Runtime (after each session, to store extracted observations), Implementation Coordinator (before session context assembly, to retrieve matching records), Coordination Engine (before batch planning, to query prospective risks), Validation Service (to retrieve exemplars for consistency comparison, and to store operator corrections from warmup/sampling reviews), Daemon Control Plane (to trigger optimization on schedule, to expose promotion candidates, systemic proposals, and prompt proposals to the operator), Retrospective Protocol Handler (to store tech-lead pitfalls and PO business observations as candidate records).
- Knowledge Service CALLS: Session Runtime (to spawn prompt optimizer sessions during the optimization flow).
- Knowledge Service NEVER applies changes to permanent documentation or instructions automatically. All promotions, candidate approvals, systemic proposals, and instruction changes require operator approval.

## Event Flows

**Record capture flow (session-sourced):**
1. An intelligent session completes (any type: worker, reviewer, diagnostician, etc.). **Precondition:** Only sessions that completed successfully contribute knowledge. Sessions that ended in a stuck state, were escalated, or otherwise did not reach successful completion are excluded — their output is not parsed for knowledge extraction.
2. Session Runtime parses the session output for structured observation markers. Each marker contains artifact patterns, a description, an optional root-cause tag, and a reasoning section. The reasoning section captures: what changed, why the approach was chosen, what was discovered during implementation, and what alternative approaches were attempted and why they failed. This structure ensures implementation records carry sufficient context for future sessions to understand not just the outcome but the decision-making process.
3. Session Runtime calls Knowledge Service to store the extracted records with origin type "autonomous" and the appropriate record type.
4. Knowledge Service checks for duplicates: if a record with matching artifact patterns and similar description already exists, increment its hit count instead of creating a new entry. Otherwise, create a new KnowledgeRecord with hit count 1 and lifecycle status "active."

**Retrospective capture flow:**
1. A retrospective protocol completes, producing lessons learned.
2. The Tech Lead distills technical lessons into pitfall records (record type: technical_pitfall, origin: retrospective-tech-lead). Each record includes artifact patterns scoped to the affected area and an optional root-cause tag.
3. The PO records business-level lessons as observation records (record type: business_observation, origin: retrospective-po). Each record includes artifact patterns relevant to the business area affected.
4. Both are submitted to the Knowledge Service via the store record API.
5. Knowledge Service stores them with lifecycle status "candidate" — they are NOT immediately available for injection.
6. The operator is notified that candidate records are pending approval.
7. On approval: lifecycle status transitions to "active" and the record becomes available for injection into future sessions matching its consumer set.
8. On rejection: lifecycle status transitions to "archived."

**Record injection flow:**
1. Before a session starts, the calling service requests matching records from Knowledge Service, providing the expected artifact locations and the session type (to filter by record type's consumer set).
2. Knowledge Service matches the artifact locations against record patterns using glob matching. Only records with lifecycle status "active" are considered. Only record types whose consumer set includes the requesting session type are returned.
3. Matching records are returned, sorted according to each type's injection priority ordering rule (typically: elevated priority first, then by hit count descending within each tier). Each matched record's hit count is incremented.
4. The calling service includes the matching records in the session's context as a dedicated section. Elevated records (operator corrections) are placed in a prominent position before normal-priority records.

**Prospective risk check flow:**
1. The Coordination Engine prepares a batch for the batch planning protocol.
2. It queries Knowledge Service's prospective risks endpoint with the artifact locations of all planned work items.
3. Knowledge Service returns high-severity active records matching those areas (elevated priority tier, or hit count above severity threshold).
4. The Coordination Engine includes these risk signals in the Tech Lead's input to the batch planning protocol.
5. The Tech Lead factors historical failures into effort estimates and risk assessments.
6. Hit counts are NOT incremented — this is a read-only risk query, not an injection.

**Systemic proposal detection flow:**
1. Periodically (alongside the pattern extraction cycle), Knowledge Service scans for root-cause tags that appear across multiple active records.
2. When records sharing the same root-cause tag exceed a configurable threshold (default: 3), the system generates a SystemicProposal.
3. The proposal includes: the root-cause tag, a description synthesized from the related records, the list of related record identifiers, and a proposed remediation approach.
4. The proposal is routed to technical leadership for refinement. Technical leadership may adjust the remediation approach before the proposal reaches the operator.
5. The operator reviews the systemic proposal via the control interface.
6. On approval: a work item is created to address the root cause. Related records are annotated with the proposal reference.
7. On rejection: the proposal is archived. The root-cause tag enters a cooldown period (configurable, default: 30 days) during which it will not trigger a new proposal.

**Promotion flow:**
1. Periodically (or on operator request), Knowledge Service evaluates active records against their type-specific promotion criteria (hit count and age thresholds from the PolicyRegistry).
2. Eligible records are surfaced as promotion candidates.
3. The operator reviews candidates via the control interface.
4. On approval: the record's description is written to a proposal for permanent project documentation. Once the operator merges the proposal, the record is marked promoted and stops being injected per-session — it is now available to all sessions automatically through the permanent documentation.
5. On rejection: the record is marked as reviewed and will not be re-proposed for a configurable cooldown period. It continues to be injected per-session.

**Archival flow:**
1. Periodically, Knowledge Service evaluates active records against their type-specific archival criteria from the PolicyRegistry.
2. Stale records are archived (removed from the active set but retained in an archive for historical reference). This prevents unbounded growth of the knowledge store.
3. Exception: records with origin type "operator" (operator corrections) are exempt from automatic archival per their lifecycle policy.

**Exemplar management flow:**
1. After a successful implementation is reviewed and passes all validation gates, the system evaluates whether it represents a new deliverable type or a superior version of an existing exemplar.
2. If no exemplar exists for the deliverable type: store the implementation as the reference exemplar.
3. If an exemplar exists: compare quality scores. If the new implementation scores higher, replace the exemplar.
4. Reviewers can reference exemplars during quality evaluation to ensure consistency across implementations of the same deliverable type.

**Pattern extraction flow:**
1. Periodically, Knowledge Service analyzes the knowledge store for recurring themes: multiple records with overlapping artifact patterns and related descriptions.
2. When a pattern is identified, store it as a structured Pattern: key, description, confidence (based on frequency), and source specs.
3. Patterns are available for injection into future sessions and for informing convention documentation.

**Instruction optimization flow:**
1. The Daemon Control Plane triggers optimization (after a configured number of completed work requests, or after a configured time interval).
2. Knowledge Service assembles optimization context: current instruction templates, accumulated records (with hit counts), error patterns from recent run states, and review findings.
3. Spawn a prompt optimizer session via Session Runtime.
4. The optimizer produces proposed revisions for instruction templates where empirical evidence suggests improvement.
5. Each proposal is stored as a pending PromptProposal.
6. The operator is notified that proposals are available for review.
7. On approval: the proposed version replaces the current instructions. The previous version is archived in the version history with a timestamp.
8. On rejection: the proposal is archived with "rejected" status. The current instructions remain unchanged. The system does not re-propose the same changes for a configurable cooldown period.

**Mutable vs protected instruction boundary:**
The system distinguishes between two categories of instructions:
- **Mutable instructions** (owned by Knowledge Service): session prompt templates, project-specific convention documentation, and record-promoted permanent documentation. These are the "lever" that the optimization flow can propose changes to. They live in the project's prompt and convention directories.
- **Protected instructions** (NOT owned by Knowledge Service): the SDD methodology definitions, the spec layer contract, holdout scenarios, and the system's own operational logic. These are structurally excluded from the optimization flow — the prompt optimizer session never receives protected content as mutable input. Changes to protected instructions require explicit Operator approval outside the optimization flow.
The optimization flow only proposes changes to mutable instructions. It cannot propose changes to methodology, layer contracts, or the system itself. This boundary is enforced by the Knowledge Service's context assembly: protected instruction paths are excluded from the optimization context.

**Instruction rollback flow:**
1. The operator identifies that an approved instruction change caused degraded performance.
2. The operator requests a rollback via the control interface.
3. Knowledge Service retrieves the previous version from the version history and replaces the current instructions.
4. The rollback is recorded in the version history.

## Error Handling

**Record parse failure (malformed marker):** Skip silently. Log a warning with the raw marker content. The session result is not affected — failed record extraction is a non-critical issue.

**Duplicate detection ambiguity:** When it is unclear whether a new record is a duplicate of an existing one (similar but not identical descriptions), store it as a new entry. The promotion flow will surface both, and the operator can deduplicate manually.

**Candidate approval timeout:** If a candidate record is neither approved nor rejected within a configurable period (default: 14 days), it is automatically archived. This prevents unbounded growth of the candidate queue.

**Retrospective protocol produces no structured output:** Log a warning. No records are created. The next retrospective cycle will produce fresh output.

**Systemic proposal for a root-cause tag in cooldown:** Skip silently. The cooldown prevents the system from repeatedly proposing the same fix after rejection.

**Promotion proposal rejected:** Mark the record as reviewed. Do not re-propose for the configured cooldown period. The record continues to be injected per-session.

**Prompt optimization rejected:** Archive the proposal with "rejected" status. Keep current instructions. Do not re-propose the same changes for the configured cooldown period.

**Prompt optimizer session failure:** Log the failure. Do not create proposals. The next scheduled optimization run will try again with updated context.

**Knowledge store corruption:** The store uses an append-only format. On read failure, attempt to recover by reading all valid entries up to the point of corruption. Log a warning. The system continues with the recovered subset.

**Exemplar reference becomes invalid (branch deleted, files moved):** On lookup failure, return no exemplar for that type. Log a warning. The next successful implementation of that deliverable type will become the new exemplar.
