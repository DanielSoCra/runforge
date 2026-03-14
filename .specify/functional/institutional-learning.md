---
id: FUNC-AC-LEARNING
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-LEARNING — Institutional Learning and Self-Improvement

## Problem Statement

Each intelligent session starts with a blank slate. A Worker that discovers a subtle project pitfall carries that knowledge only for the duration of its session. The next Worker hitting the same pitfall rediscovers it from scratch, wasting time and tokens. Without a structured learning system, the organization's accumulated implementation knowledge exists only in human heads.

## Actors

- **Worker** — discovers pitfalls and patterns during implementation, emits structured observations
- **Operator** — reviews and approves proposed knowledge promotions and instruction improvements

## Behavior

### Knowledge Capture

**Scenario: Pitfall observation**
- Given a Worker encounters a non-obvious pitfall about the project
- When it recognizes the pitfall
- Then it emits a structured observation with: affected artifact patterns, description, and the current work request as source

**Scenario: Observation persistence**
- Given a session has completed
- When the system parses the activity record
- Then it extracts structured observations and stores them with: affected artifact patterns, description, source work request, confidence score, creation date, and hit count

### Knowledge Injection

**Scenario: Relevant pitfall injection**
- Given a Worker is about to begin implementation
- When the system prepares the Worker's context
- Then it matches the unit's expected artifact locations against stored observations and injects matching pitfalls into the context

**Scenario: Irrelevant pitfall filtering**
- Given stored observations exist for unrelated artifact locations
- When the system prepares a Worker's context
- Then only observations matching the current unit's artifact locations are injected — no irrelevant noise

### Knowledge Promotion

**Scenario: Promotion candidate detection**
- Given an observation has been matched frequently (hit count and recency exceeding configurable thresholds defined by the Operator)
- When the system evaluates stored observations
- Then it flags the observation as a candidate for promotion to permanent project documentation

**Scenario: Promotion proposal**
- Given an observation is a promotion candidate
- When the system proposes the promotion
- Then it writes proposed additions to a proposal document for the Operator to review — never applies automatically

**Scenario: Promotion approval**
- Given the Operator approves a promotion
- When the promoted content is merged into permanent documentation
- Then the observation stops being injected per-session — it is now available in every session's context automatically

**Scenario: Observation archival**
- Given observations older than a configurable age with low hit counts
- When the system performs periodic maintenance
- Then it archives these observations to prevent unbounded growth

### Instruction Improvement

**Scenario: Periodic analysis**
- Given a threshold of completed work requests has been reached (or a time interval has passed)
- When the system triggers instruction improvement
- Then it analyzes accumulated observations, error patterns, and review findings to identify systematic improvements

**Scenario: Instruction proposal**
- Given the analysis identifies potential improvements to operating instructions
- When the system produces revised instructions
- Then it writes proposals alongside current instructions — never overwrites automatically

**Scenario: Operator review gate**
- Given proposed instruction improvements exist
- When the Operator reviews them
- Then the Operator can approve, reject, or modify the proposals before they take effect

**Scenario: Instruction rollback**
- Given approved instruction changes cause degraded performance
- When the Operator decides to revert
- Then previous instruction versions are available for immediate rollback

### Exemplars

**Scenario: Exemplar creation**
- Given a first successful implementation of a deliverable type
- When the system records the completed work
- Then the implementation becomes a reference standard that future Reviewers compare against

**Scenario: Exemplar evolution**
- Given a clearly superior implementation of the same deliverable type is completed
- When the system evaluates the new implementation against the existing exemplar
- Then the exemplar is updated to the superior version

### Structured Patterns

**Scenario: Pattern extraction**
- Given recurring observations share a common theme
- When the system identifies the pattern
- Then it stores the pattern as structured data: key, description, confidence score, and source specifications

**Scenario: Pattern feedback loop**
- Given extracted patterns exist
- When the system processes new work requests
- Then patterns flow back into project-specific convention documentation, creating a feedback loop where implementation knowledge improves with every issue processed

## Success Criteria

- Workers receive relevant institutional knowledge before starting — they don't rediscover known pitfalls
- Recurring patterns are promoted to permanent documentation, reducing per-session injection overhead
- Operating instructions improve over time based on empirical outcomes
- All knowledge changes require Operator approval — the system proposes, the human disposes

## Constraints

- Knowledge promotion and instruction improvement always require Operator approval
- Observations older than a configurable age with low hit counts are archived to prevent unbounded growth
- The system gets smarter with every issue it processes, but never autonomously changes its own behavior — all changes are proposed
- Learned patterns are structured data (key, description, confidence score, source), not unstructured prose
