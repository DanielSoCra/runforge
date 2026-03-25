---
id: FUNC-AC-TECH-LEAD
type: functional
domain: auto-claude
status: draft
version: 2
layer: 1
---

# FUNC-AC-TECH-LEAD — Tech Lead Agent

## Problem Statement

The system has no agent responsible for code-level health. Review findings accumulate, deferred work grows, test coverage drifts, and dependency risks go unnoticed unless the operator manually inspects. Without a dedicated technical leadership function, the gap between specification and implementation widens silently.

## Relationship to Other Specs

This spec defines the technical leadership role extracted from FUNC-AC-COORDINATION. The Tech Lead operates at the L2-L3 layer, deciding how to build and guarding code health. For product ownership (what to build and why), see FUNC-AC-PRODUCT-OWNER. For coordination mechanics (batch execution, merge sequencing, concurrency), see FUNC-AC-COORDINATION. For the learning system that stores gotchas, see FUNC-AC-LEARNING.

## Actors

- **Operator** — approves technical proposals, resolves PO/Tech Lead disagreements
- **Tech Lead Agent** — analyzes code health, estimates effort, manages technical quality
- **PO Agent** — receives Tech Lead input during shared protocols, has veto power on Tech Lead proposals reaching the operator

## Behavior

### Signal Analysis

**Scenario: Tech Lead reads review findings**
- Given the knowledge store contains unaddressed findings with severity ratings
- When the Tech Lead's analysis cycle triggers
- Then it reads accumulated findings and identifies areas with high finding density or severity

**Scenario: Tech Lead analyzes detailed run outcomes**
- Given recent runs have completed or failed
- When the Tech Lead reads run data
- Then it analyzes failure reasons, error categories, phase-level breakdowns, and retry counts
- And it identifies systemic patterns across multiple runs

**Scenario: Tech Lead detects spec-code drift**
- Given L3 stack specs define expected implementation patterns
- When the Tech Lead compares specs against actual implementation
- Then it identifies areas where implementation has diverged from the spec

**Scenario: Tech Lead monitors deferred work density**
- Given the codebase contains deferred work markers
- When the Tech Lead scans code areas
- Then it identifies areas with high concentration of deferred work

**Scenario: Tech Lead monitors test health**
- Given test results and coverage data exist
- When the Tech Lead reads test metrics
- Then it identifies areas with declining coverage or increasing test failures

**Scenario: Tech Lead monitors dependency risks**
- Given the project has external package dependencies
- When the Tech Lead checks dependency health
- Then it identifies outdated packages and known security advisories

### Finding Triage

**Scenario: Tech Lead triages new review findings**
- Given the proactive reviewer has created findings as GitHub issues with `review-finding` label
- When untriaged findings exist (no `tl-triaged` label)
- Then the Tech Lead evaluates each finding for validity, proportionality, and impact
- And produces a triage decision for each: approve, reject, promote, or defer

**Scenario: Tech Lead approves a finding for fixing**
- Given a finding is valid and the fix is proportional to the effort
- When the Tech Lead decides to approve
- Then it labels the issue `tl-approved` and `tl-triaged`
- And adds a comment explaining why the fix is justified
- And the finding enters the PO approval queue

**Scenario: Tech Lead rejects a finding as invalid**
- Given a finding is a false positive, already resolved, or not worth fixing
- When the Tech Lead decides to reject
- Then it closes the issue with a comment explaining the rejection reason
- And labels it `tl-triaged` before closing

**Scenario: Tech Lead promotes finding severity**
- Given a P3 finding has higher impact than its severity suggests (e.g., it affects a critical path, or multiple P3 findings in the same area compound into a real problem)
- When the Tech Lead decides to promote
- Then it changes the severity label (e.g., P3 → P2) with a comment explaining the promotion reason
- And approves the finding (applies `tl-approved` and `tl-triaged`)

**Scenario: Tech Lead defers a finding**
- Given a finding is valid but not appropriate to fix now (e.g., area is being refactored, or higher-priority work is in progress)
- When the Tech Lead decides to defer
- Then it labels the issue `deferred` and `tl-triaged` with a comment explaining when it should be revisited

**Scenario: Tech Lead triage respects daily cap**
- Given a configurable daily cap exists for triage approvals (default: 5)
- When the Tech Lead has approved the maximum number of findings in the current day
- Then it defers remaining findings to the next cycle
- And this prevents capacity runaway from a large batch of findings

### Proposal Generation

**Scenario: Tech Lead proposes technical debt reduction**
- Given an area has accumulated deferred work and recurring findings
- When the Tech Lead identifies the pattern
- Then it generates a proposal for targeted refactoring of that area

**Scenario: Tech Lead proposes quality improvement**
- Given test coverage in an area has dropped below a threshold
- When the Tech Lead detects the regression
- Then it generates a proposal for coverage hardening

**Scenario: Tech Lead raises architecture concern**
- Given spec-code drift has been detected
- When the drift affects system correctness or maintainability
- Then it generates a proposal to realign implementation with the spec

**Scenario: Tech Lead proposes dependency update**
- Given packages have known vulnerabilities
- When the Tech Lead identifies the risk
- Then it generates a proposal for an update batch

**Scenario: Tech Lead proposes failure pattern investigation**
- Given multiple recent runs in a repository failed at the same phase
- When the Tech Lead detects the pattern
- Then it generates a proposal to investigate the root cause

### Proposal Lifecycle

**Scenario: Tech Lead proposal flows through PO**
- Given the Tech Lead has generated a technical proposal
- When it submits the proposal for enrichment
- Then the PO evaluates business priority and either forwards to operator with context or rejects with reason

**Scenario: PO rejects Tech Lead proposal**
- Given the PO has rejected a Tech Lead proposal
- When the rejection is recorded
- Then the PO records the rejection reason
- And the Tech Lead may re-propose with stronger evidence on any subsequent cycle

**Scenario: Tech Lead re-proposes with stronger evidence**
- Given a previous proposal was rejected by the PO
- When the Tech Lead has gathered additional evidence supporting the proposal
- Then it generates a new proposal with the stronger evidence and a reference to the prior rejection

### Interaction Protocols (Tech Lead Side)

**Scenario: Tech Lead enriches PO business proposal**
- Given the PO has generated a raw business proposal
- When the Tech Lead receives it for enrichment
- Then it adds effort estimate, dependency analysis, technical risks, and prerequisite work
- And returns the enrichment to the PO

**Scenario: Tech Lead initiates technical proposal**
- Given the Tech Lead has generated a technical proposal
- When it enters the Proposal Enrichment protocol
- Then the PO evaluates business priority
- And the PO has veto power — it decides whether the proposal reaches the operator

**Scenario: Tech Lead participates in batch planning**
- Given it is time to select the next batch of work
- When the Tech Lead enters the Batch Planning protocol
- Then it brings the dependency graph, capacity assessment, and current system health
- And identifies hard constraints (dependencies, parallelism limits, capacity)
- And determines how many items, in what order, and what can parallelize

**Scenario: Tech Lead participates in backlog grooming**
- Given the PO has initiated backlog grooming
- When the Tech Lead joins the protocol
- Then it brings the updated technical landscape (new findings, resolved debt, changed dependencies)
- And flags items as blocked or risky

**Scenario: Tech Lead reports in status sync**
- Given a status sync cycle triggers
- When the Tech Lead reports
- Then it shares active work status, stuck items, completed items, and resource utilization

**Scenario: Tech Lead participates in retrospective**
- Given a batch has completed
- When the Tech Lead enters the Retrospective protocol
- Then it brings failure analysis, recurring patterns, resource utilization, and finding trends
- And actionable items become technical debt proposals

**Scenario: Tech Lead escalates technical blocker**
- Given a work item has failed or encountered a blocker
- When the Tech Lead determines it requires PO input
- Then it escalates through the Escalation protocol with options (retry, skip, fix spec first)

**Scenario: Tech Lead receives PO priority escalation**
- Given the PO escalates a priority shift
- When the Tech Lead receives the escalation
- Then it evaluates capacity impact and jointly decides with the PO whether to re-plan or queue

### Degraded Paths

**Scenario: Tech Lead cannot assess effort**
- Given the Tech Lead receives a proposal for enrichment in an unfamiliar area
- When it cannot produce a reliable effort estimate
- Then it returns an "unassessed" flag so the proposal reaches the operator with incomplete technical review

**Scenario: Escalation to unavailable PO**
- Given the Tech Lead raises an escalation but the PO is mid-analysis
- When the escalation cannot be processed immediately
- Then it queues and processes on the next tick
- And time-critical escalations (budget exceeded, system down) bypass the protocol and go directly to the operator

### Self-Improvement Connection

**Scenario: Tech Lead distills retrospective lessons**
- Given the Retrospective protocol has produced lessons learned
- When the Tech Lead distills a technical lesson
- Then it proposes a pitfall to the knowledge store with severity, affected area, and root cause
- And the pitfall becomes available for injection into future sessions after Operator approval

**Scenario: Tech Lead detects recurring pitfall pattern**
- Given the same root cause appears in pitfalls exceeding a configurable threshold (default: 3)
- When the Tech Lead detects the pattern
- Then it generates a technical debt proposal to address the root cause systemically

### Interactive Sessions

**Scenario: Operator opens interactive session with Tech Lead**
- Given the operator starts an interactive session with the Tech Lead
- When the session initializes
- Then the Tech Lead loads its current state: recent findings, triage decisions, active proposals, system health signals, and failure patterns
- And proactively surfaces technical concerns requiring operator input

**Scenario: Operator discusses architecture with Tech Lead**
- Given the operator has questions about implementation approach or technical debt
- When they discuss during an interactive session
- Then the Tech Lead provides analysis grounded in current codebase state, findings, and spec-code drift data
- And any resulting decisions are recorded as proposals or triage actions

### Protocol Composition

**Scenario: Batch completion triggers protocol chain**
- Given a Status Sync detects that a batch has completed
- When the system processes the event
- Then it triggers Retrospective, then Backlog Grooming, then Batch Planning for the next batch

**Scenario: Failure triggers escalation chain**
- Given a Status Sync detects a stuck work item or repeated failure
- When the Tech Lead evaluates the situation
- Then it triggers Escalation to the PO, which may trigger re-Batch Planning

## Success Criteria

- Review findings translate to actionable proposals at a measurable rate
- Spec-code drift is detected and proposed for resolution within configured cycles
- Failure patterns are identified and proposed before the operator notices
- All technical proposals flow through PO priority assessment before reaching operator
- Review findings are triaged within one Tech Lead cycle of creation
- False positives are closed with explanation rather than accumulating silently
- P3 findings with compounding impact are promoted rather than permanently ignored

## Constraints

- Never proposes features or business priorities (PO territory)
- Never modifies specs directly
- Operates at L2-L3 — no business-level decisions
- Technical proposals always flow through PO for priority assessment before reaching operator
- Scheduled analysis default: 2 hours; event-driven on failures and findings
- Proposal expiry default: 7 days
- Recurring finding threshold: configurable, default 3
- Finding triage daily cap: configurable, default 5 approvals per day
- Triage decisions are always recorded as GitHub issue comments (audit trail)
- Triage does not bypass the PO approval gate — approved findings still require PO sign-off before becoming work
