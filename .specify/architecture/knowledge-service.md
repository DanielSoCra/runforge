---
id: ARCH-AC-KNOWLEDGE
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-LEARNING
---

# ARCH-AC-KNOWLEDGE — Knowledge Service

## Overview

The Knowledge Service accumulates, structures, and distributes institutional knowledge across sessions. It captures pitfall observations from session output, persists them, matches them against artifact locations for injection into future sessions, promotes high-frequency observations to permanent documentation, maintains reference implementations (exemplars) for consistency comparison, and proposes instruction improvements based on empirical outcomes. All permanent changes require operator approval.

## Data Model

**Gotcha** represents a captured pitfall observation. It contains: a unique identifier, an array of artifact patterns, a description (what the pitfall is and how to avoid it), the source work request identifier (where it was first observed), a confidence score (extracted from the session or defaulted), a creation timestamp, a hit count (incremented each time the gotcha is matched and injected into a session context), a promoted flag (true once the gotcha has been merged into permanent documentation), an origin type (autonomous or operator — operator-origin gotchas carry higher weight), and a priority tier (normal or elevated — elevated gotchas are injected with higher prominence and have a lower promotion threshold).

**GotchaStore** is the persistent collection of all gotchas. It is an append-only structured log. Each entry is a self-contained record. The store supports: appending new entries, querying by artifact pattern match, incrementing hit counts, marking entries as promoted, and archiving entries that meet staleness criteria.

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

## API Contract

**Store gotcha** — Called by Session Runtime after each session completes. Request: an array of extracted gotcha markers (each with artifact patterns and description), the source work request identifier, and an origin type (autonomous by default). Response: acknowledgment with the number of new gotchas stored and the number of duplicates deduplicated (if a gotcha with the same artifact patterns and similar description already exists, the hit count is incremented instead of creating a duplicate).

**Store operator correction** — Called by the Validation Service when the Operator provides corrections during warmup approval or random sampling review. Request: an array of correction observations (each with artifact patterns and description), the source work request identifier. Response: acknowledgment. Corrections are stored as gotchas with origin type "operator" and priority tier "elevated." Elevated gotchas have a lower promotion threshold (default: 2 hits instead of the standard 5) and are injected with higher prominence in session contexts (placed before normal-priority gotchas).

**Match gotchas** — Called by Implementation Coordinator (and other services) before assembling session context. Request: an array of expected artifact locations. Response: an array of matching Gotchas, filtered to only those whose artifact patterns match the requested locations. Gotchas marked as promoted are excluded (their knowledge is already in permanent documentation). Each matched gotcha's hit count is incremented.

**Get exemplar** — Called by Validation Service during review for consistency comparison. Request: a deliverable type name. Response: the Exemplar for that type, or none if no exemplar exists yet.

**Store exemplar** — Called after a successful implementation is confirmed as the first or a superior version of a deliverable type. Request: deliverable type, implementation reference, quality score. Response: acknowledgment. If an exemplar already exists for that type, it is replaced only if the new quality score exceeds the existing one.

**Get promotion candidates** — Called by the operator (via the Daemon Control Plane's control interface) to review gotchas eligible for promotion. Request: none. Response: an array of Gotchas where hit count is at or above the promotion threshold and age is below the maximum age, and the gotcha is not already promoted or archived.

**Approve promotion** — Called by the operator. Request: gotcha identifier. Effect: the gotcha's content is written to a proposal document for permanent documentation. On approval, the gotcha is marked as promoted and stops being injected per-session.

**Reject promotion** — Called by the operator. Request: gotcha identifier. Effect: mark the gotcha as reviewed. It will not be re-proposed for a configured cooldown period, but continues to be injected per-session.

**Get prompt proposals** — Called by the operator to review proposed instruction improvements. Request: none. Response: an array of pending PromptProposals.

**Approve prompt proposal** — Called by the operator. Request: proposal identifier. Effect: the proposed version replaces the current instruction content. The previous version is archived in the version history for rollback.

**Reject prompt proposal** — Called by the operator. Request: proposal identifier. Effect: the proposal is archived with "rejected" status. The current instructions remain unchanged.

**Trigger optimization** — Called periodically by the Daemon Control Plane (on a configurable schedule: after a threshold of completed work requests, or after a time interval). Request: none. Effect: spawn a prompt optimizer session via Session Runtime, analyze accumulated gotchas, error patterns from recent runs, and review findings. Produce a PromptProposal for each instruction file that has actionable improvements. Proposals are stored as pending for operator review.

## System Boundaries

- Knowledge Service OWNS: gotcha store, exemplar store, pattern store, prompt proposals, version history, promotion logic, archival logic.
- Knowledge Service IS CALLED BY: Session Runtime (after each session, to store extracted gotcha markers), Implementation Coordinator (before session context assembly, to retrieve matching gotchas), Validation Service (to retrieve exemplars for consistency comparison, and to store operator corrections from warmup/sampling reviews), Daemon Control Plane (to trigger optimization on schedule, to expose promotion candidates and prompt proposals to the operator).
- Knowledge Service CALLS: Session Runtime (to spawn prompt optimizer sessions during the optimization flow).
- Knowledge Service NEVER applies changes to permanent documentation or instructions automatically. All promotions and instruction changes require operator approval.

## Event Flows

**Gotcha capture flow:**
1. An intelligent session completes (any type: worker, reviewer, diagnostician, etc.).
2. Session Runtime parses the session output for structured observation markers. Each marker contains artifact patterns and a description.
3. Session Runtime calls Knowledge Service to store the extracted gotchas.
4. Knowledge Service checks for duplicates: if a gotcha with matching artifact patterns and similar description already exists, increment its hit count instead of creating a new entry. Otherwise, create a new Gotcha with hit count 1.

**Gotcha injection flow:**
1. Before a session starts, the calling service (typically Implementation Coordinator) requests matching gotchas from Knowledge Service, providing the expected artifact locations for the unit.
2. Knowledge Service matches the artifact locations against gotcha patterns using glob matching. Promoted gotchas are excluded.
3. Matching gotchas are returned, sorted by priority tier (elevated first, then normal) and within each tier by hit count (descending). Each matched gotcha's hit count is incremented.
4. The calling service includes the matching gotchas in the session's context as a dedicated section. Elevated gotchas (operator corrections) are placed in a prominent position before normal-priority gotchas.

**Promotion flow:**
1. Periodically (or on operator request), Knowledge Service evaluates gotchas against promotion criteria: hit count at or above a configurable threshold (default: 5 for normal priority, 2 for elevated/operator-origin) and age below a configurable maximum (default: 90 days).
2. Eligible gotchas are surfaced as promotion candidates.
3. The operator reviews candidates via the control interface.
4. On approval: the gotcha's description is written to a proposal for permanent project documentation. Once the operator merges the proposal, the gotcha is marked promoted and stops being injected per-session — it is now available to all sessions automatically through the permanent documentation.
5. On rejection: the gotcha is marked as reviewed and will not be re-proposed for a configurable cooldown period. It continues to be injected per-session.

**Archival flow:**
1. Periodically, Knowledge Service evaluates gotchas against archival criteria: age exceeds a configurable maximum and hit count is below a configurable minimum.
2. Stale gotchas are archived (removed from the active store but retained in an archive for historical reference). This prevents unbounded growth of the gotcha store.

**Exemplar management flow:**
1. After a successful implementation is reviewed and passes all validation gates, the system evaluates whether it represents a new deliverable type or a superior version of an existing exemplar.
2. If no exemplar exists for the deliverable type: store the implementation as the reference exemplar.
3. If an exemplar exists: compare quality scores. If the new implementation scores higher, replace the exemplar.
4. Reviewers can reference exemplars during quality evaluation to ensure consistency across implementations of the same deliverable type.

**Pattern extraction flow:**
1. Periodically, Knowledge Service analyzes the gotcha store for recurring themes: multiple gotchas with overlapping artifact patterns and related descriptions.
2. When a pattern is identified, store it as a structured Pattern: key, description, confidence (based on frequency), and source specs.
3. Patterns are available for injection into future sessions and for informing convention documentation.

**Instruction optimization flow:**
1. The Daemon Control Plane triggers optimization (after a configured number of completed work requests, or after a configured time interval).
2. Knowledge Service assembles optimization context: current instruction templates, accumulated gotchas (with hit counts), error patterns from recent run states, and review findings.
3. Spawn a prompt optimizer session via Session Runtime.
4. The optimizer produces proposed revisions for instruction templates where empirical evidence suggests improvement.
5. Each proposal is stored as a pending PromptProposal.
6. The operator is notified that proposals are available for review.
7. On approval: the proposed version replaces the current instructions. The previous version is archived in the version history with a timestamp.
8. On rejection: the proposal is archived with "rejected" status. The current instructions remain unchanged. The system does not re-propose the same changes for a configurable cooldown period.

**Mutable vs protected instruction boundary:**
The system distinguishes between two categories of instructions:
- **Mutable instructions** (owned by Knowledge Service): session prompt templates, project-specific convention documentation, and gotcha-promoted permanent documentation. These are the "lever" that the optimization flow can propose changes to. They live in the project's prompt and convention directories.
- **Protected instructions** (NOT owned by Knowledge Service): the SDD methodology definitions, the spec layer contract, holdout scenarios, and the system's own operational logic. These are structurally excluded from the optimization flow — the prompt optimizer session never receives protected content as mutable input. Changes to protected instructions require explicit Operator approval outside the optimization flow.
The optimization flow only proposes changes to mutable instructions. It cannot propose changes to methodology, layer contracts, or the system itself. This boundary is enforced by the Knowledge Service's context assembly: protected instruction paths are excluded from the optimization context.

**Instruction rollback flow:**
1. The operator identifies that an approved instruction change caused degraded performance.
2. The operator requests a rollback via the control interface.
3. Knowledge Service retrieves the previous version from the version history and replaces the current instructions.
4. The rollback is recorded in the version history.

## Error Handling

**Gotcha parse failure (malformed marker):** Skip silently. Log a warning with the raw marker content. The session result is not affected — failed gotcha extraction is a non-critical issue.

**Duplicate detection ambiguity:** When it is unclear whether a new gotcha is a duplicate of an existing one (similar but not identical descriptions), store it as a new entry. The promotion flow will surface both, and the operator can deduplicate manually.

**Promotion proposal rejected:** Mark the gotcha as reviewed. Do not re-propose for the configured cooldown period. The gotcha continues to be injected per-session.

**Prompt optimization rejected:** Archive the proposal with "rejected" status. Keep current instructions. Do not re-propose the same changes for the configured cooldown period.

**Prompt optimizer session failure:** Log the failure. Do not create proposals. The next scheduled optimization run will try again with updated context.

**Gotcha store corruption:** The store uses an append-only format. On read failure, attempt to recover by reading all valid entries up to the point of corruption. Log a warning. The system continues with the recovered subset.

**Exemplar reference becomes invalid (branch deleted, files moved):** On lookup failure, return no exemplar for that type. Log a warning. The next successful implementation of that deliverable type will become the new exemplar.
