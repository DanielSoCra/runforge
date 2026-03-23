---
id: FUNC-AC-PRODUCT-OWNER
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-PRODUCT-OWNER — Product Owner Agent

## Problem Statement

The system can execute work but cannot decide what to work on next. Work detection finds labeled issues but nobody creates them proactively. Without a dedicated product ownership function, the operator must manually monitor spec pipeline state, delivery patterns, and backlog health to decide what to build next.

## Relationship to Other Specs

This spec defines the product ownership role extracted from FUNC-AC-COORDINATION. The PO operates at the L0-L2 layer, deciding what to build and why. For technical health analysis, see FUNC-AC-TECH-LEAD. For coordination mechanics (batch execution, merge sequencing, concurrency), see FUNC-AC-COORDINATION. For the pipeline that executes approved work, see FUNC-AC-PIPELINE.

## Actors

- **Operator** — approves/rejects proposals, submits ideas, sets priorities
- **PO Agent** — analyzes signals, generates proposals, refines operator ideas
- **Tech Lead Agent** — participates in shared protocols (enrichment, planning, grooming, standups, retrospectives, escalation)

## Behavior

### Signal Analysis

**Scenario: PO analyzes spec pipeline state**
- Given the PO's scheduled cycle triggers
- When it reads the specification directory
- Then it identifies which L1 specs have L2 architecture specs, which L2s have L3 stack specs, and which L3s have been implemented
- And it flags gaps where the pipeline is stuck or incomplete

**Scenario: PO reads aggregate delivery outcomes**
- Given recent runs have completed
- When the PO reads delivery metrics
- Then it reads aggregate pass/fail rates and completion counts per repository
- And it does not read detailed failure reasons, error categories, or phase breakdowns (those belong to the Tech Lead)

**Scenario: PO reads proposal history**
- Given past proposals exist in the proposal store
- When the PO prepares for a new cycle
- Then it reads what was previously approved, rejected, and why
- And it avoids re-proposing work that was recently rejected without new justification

### Proposal Generation

**Scenario: PO proposes spec advancement**
- Given a spec exists at one layer but the next layer is missing
- When the PO identifies the gap
- Then it generates a proposal to advance the spec (e.g., "FUNC-AC-LEARNING has no L2 — propose generating L2 architecture spec")

**Scenario: PO escalates stale work**
- Given an issue has been in-progress for longer than a configurable threshold with no recent activity
- When the PO detects the staleness
- Then it generates a proposal to investigate the stale item

**Scenario: PO proposes backlog prioritization**
- Given multiple issues are ready for work
- When the PO evaluates the backlog
- Then it proposes an ordering based on dependency analysis, spec completeness, and business value

**Scenario: PO refines operator idea**
- Given the operator has submitted a rough idea through the terminal or dashboard
- When the PO processes the idea
- Then it refines it into a scoped proposal with rationale and estimated impact
- And it runs the Proposal Enrichment protocol with the Tech Lead before presenting the enriched proposal to the operator

### Proposal Lifecycle

**Scenario: Proposal approval creates work request**
- Given the operator approves a proposal
- When the system processes the approval
- Then it creates a work request (with executable labels) that work detection can pick up

**Scenario: Proposal rejection is archived**
- Given the operator rejects a proposal
- When the system processes the rejection
- Then it archives the proposal with the operator's reason

**Scenario: Proposal expiry**
- Given a proposal has been pending longer than a configurable window (default: 7 days)
- When the expiry time is reached
- Then the proposal is marked expired and removed from the active queue

**Scenario: Proposal guardrails**
- Given the PO generates any proposal
- When it enters the proposal queue
- Then it always requires operator approval — the system never acts on PO proposals autonomously

### Interaction Protocols (PO Side)

**Scenario: PO initiates proposal enrichment with Tech Lead**
- Given the PO has generated a raw proposal
- When it sends the proposal to the Tech Lead for enrichment
- Then the Tech Lead adds effort estimate, dependency analysis, technical risks, and prerequisite work
- And the PO reviews the Tech Lead's input and may adjust priority or scope
- And the PO presents the enriched proposal to the operator

**Scenario: PO receives Tech Lead technical proposal**
- Given the Tech Lead has generated a technical proposal
- When the PO receives it for priority assessment
- Then the PO evaluates whether the proposal is worth doing now versus other backlog items
- And either forwards it to the operator with priority context, or rejects it with reason
- And the PO has veto power — it decides whether the proposal reaches the operator

**Scenario: PO participates in batch planning**
- Given it is time to select the next batch of work
- When the PO enters the Batch Planning protocol
- Then it brings the top N items from the backlog ordered by business priority
- And participates in a single round-trip negotiation with the Tech Lead
- And adjusts selection based on the Tech Lead's hard constraints

**Scenario: PO initiates backlog grooming**
- Given the PO's grooming cycle triggers or a significant backlog change occurs
- When the PO enters the Backlog Grooming protocol
- Then it brings the current prioritized backlog plus new signals
- And the Tech Lead brings updated technical landscape
- And they produce a re-prioritized backlog

**Scenario: PO participates in status sync**
- Given a status sync cycle triggers
- When the PO reports
- Then it shares priority changes, new operator ideas, and proposal outcomes

**Scenario: PO participates in retrospective**
- Given a batch has completed
- When the PO enters the Retrospective protocol
- Then it brings delivery expectations versus actuals
- And actionable items become proposals (PO) or technical debt items (Tech Lead)

**Scenario: PO escalates priority shift**
- Given the operator submits an urgent idea or priority change
- When the PO determines current batch items should be superseded
- Then it escalates through the Escalation protocol to the Tech Lead
- And they jointly decide whether to re-plan the batch or queue for the next cycle

**Scenario: PO receives Tech Lead escalation**
- Given the Tech Lead raises a technical blocker
- When the PO receives the escalation with options
- Then the PO evaluates the options against business priority and decides

### Degraded Paths

**Scenario: Proposal enrichment without Tech Lead assessment**
- Given the Tech Lead cannot assess effort for a proposal
- When the proposal enrichment cannot complete normally
- Then the proposal goes to the operator with an "unassessed" flag indicating technical review is incomplete

**Scenario: Empty batch from planning**
- Given no viable batch can be formed during Batch Planning
- When all items are blocked or capacity is insufficient
- Then the protocol produces an empty batch and triggers an Escalation to the operator explaining why

**Scenario: PO-only backlog grooming**
- Given the Tech Lead has no new technical input during grooming
- When the PO grooms the backlog alone
- Then it records that the grooming was PO-only

**Scenario: Protocol convergence failure**
- Given the PO and Tech Lead cannot converge in one round during Batch Planning
- When no agreement is reached
- Then both positions go to the operator for resolution

### Protocol Composition

**Scenario: Batch completion triggers protocol chain**
- Given a Status Sync detects that a batch has completed
- When the system processes the event
- Then it triggers Retrospective, then Backlog Grooming, then Batch Planning for the next batch

**Scenario: Stuck item triggers escalation chain**
- Given a Status Sync detects a stuck work item
- When the system processes the event
- Then it triggers Escalation from Tech Lead to PO, which may trigger re-Batch Planning

**Scenario: Operator idea triggers proposal chain**
- Given the operator submits an idea
- When the PO refines it
- Then it runs Proposal Enrichment with the Tech Lead, and upon operator approval, triggers Backlog Grooming and Batch Planning

### Operator Idea Flow

**Scenario: Operator submits idea through terminal or dashboard**
- Given the operator has an idea for a feature or improvement
- When they submit it through the dashboard or terminal interface
- Then the PO receives the idea and refines it into a scoped proposal on its next cycle (debounced, default 5-minute window)

## Success Criteria

- Spec pipeline gaps are identified and proposed for advancement without operator prompting
- Stale work items are escalated before the operator notices them
- Operator ideas are refined into actionable proposals with business rationale and technical assessment
- All proposals require operator approval — no autonomous work creation

## Constraints

- Never proposes implementation details (Tech Lead territory)
- Never creates work without operator approval (L0 boundary)
- Never modifies specs directly
- Operates at L0-L2 only — no code-level analysis
- Scheduled cycle default: 30 minutes; event-driven debounce: 5 minutes
- Proposal expiry default: 7 days
