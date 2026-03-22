---
id: FUNC-AC-LEARNING
type: functional
domain: auto-claude
status: draft
version: 2
layer: 1
---

# FUNC-AC-LEARNING — Institutional Learning and Self-Improvement

## Problem Statement

Each new piece of implementation work starts with limited project memory. When a subtle pitfall is discovered during one change, the next similar change should not have to rediscover it from scratch. Without a structured learning system, the organization's accumulated implementation knowledge exists only in human heads.

## Actors

- **Operator** — reviews and approves proposed knowledge promotions and instruction improvements

## Behavior

### Knowledge Capture

**Scenario: Pitfall observation**
- Given implementation work encounters a non-obvious pitfall about the project
- When it recognizes the pitfall
- Then it emits a structured observation with: affected artifact patterns, description, and the current work request as source

**Scenario: Observation persistence**
- Given a piece of work has completed
- When the system reviews the resulting activity
- Then it extracts structured observations and stores them with: affected artifact patterns, description, source work request, confidence score, creation date, and hit count

### Knowledge Injection

**Scenario: Relevant pitfall injection**
- Given implementation work is about to begin
- When the system prepares the working context
- Then it matches the unit's expected artifact locations against stored observations and injects matching pitfalls into the context

**Scenario: Irrelevant pitfall filtering**
- Given stored observations exist for unrelated artifact locations
- When the system prepares working context for a new unit
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
- Then the observation stops being injected case by case — it is now available automatically to future work

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
- Then the Operator can approve or reject each proposal — rejected proposals can be revised externally and resubmitted as new proposals

**Scenario: Instruction rollback**
- Given approved instruction changes cause degraded performance
- When the Operator decides to revert
- Then previous instruction versions are available for immediate rollback

### Exemplars

**Scenario: Exemplar creation**
- Given a first successful implementation of a deliverable type
- When the system records the completed work
- Then the implementation becomes a reference standard that future reviews compare against

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
- Then patterns inform proposed updates to project-specific convention documentation, creating a feedback loop without changing permanent guidance automatically

### Operator Corrections

**Scenario: Operator correction capture**
- Given the Operator reviews and corrects a completed work request (during warmup approval, random sampling, or manual review)
- When the Operator provides corrections
- Then the system captures the correction as a high-priority observation with elevated weight

**Scenario: Operator correction priority**
- Given a correction originates from the Operator (not from an autonomous session)
- When the system evaluates it for promotion
- Then it is eligible for fast-track promotion with a lower hit-count threshold than regular observations — Operator corrections carry more authority than autonomous observations

**Scenario: Operator correction injection**
- Given Operator corrections exist for relevant artifact locations
- When the system prepares working context for a new unit
- Then Operator corrections are injected with higher prominence than regular observations — ensuring they are not lost among lower-priority context

### Knowledge from Implementation Records

**Scenario: Implementation record captures reasoning**
- Given an implementation assignment completes
- When the work is committed to the record
- Then the record captures what changed, why the approach was chosen, what was discovered, and what approaches failed

**Scenario: Completed run contributes to institutional knowledge**
- Given a run completes successfully
- When the system processes the completion
- Then it extracts knowledge from the implementation records and adds it to the knowledge store using the standard deduplication and storage flow

**Scenario: Future work benefits from past implementations**
- Given future work touches similar areas of the codebase
- When the system prepares context for that work
- Then knowledge extracted from past implementation records on those same areas is included alongside other matched observations

## Success Criteria

- New implementation work receives relevant institutional knowledge before starting — it does not rediscover known pitfalls
- Recurring patterns are promoted to permanent documentation, reducing repeated ad hoc context injection
- Proposed operating instruction improvements are grounded in empirical outcomes
- All knowledge changes require Operator approval — the system proposes, the human disposes
- Successful implementation runs produce records containing sufficient reasoning for knowledge extraction

## Constraints

- Knowledge promotion and instruction improvement always require Operator approval
- Observations older than a configurable age with low hit counts are archived to prevent unbounded growth
- The system may temporarily enrich future work context from approved knowledge stores, but permanent changes to instructions, documentation, or evaluation standards always require Operator approval
- Learned patterns are structured data (key, description, confidence score, source), not unstructured prose
- Operator corrections always carry more weight than autonomous observations — the human's judgment takes priority
- Only successfully completed runs contribute knowledge from their implementation records — stuck or escalated runs do not
- Knowledge extracted from implementation records enters the same store and follows the same lifecycle (deduplication, injection, promotion, archival) as all other observations
