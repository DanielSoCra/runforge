> **🗄 HISTORICAL (2026-06-02).** Completed/superseded record, kept for provenance — superseded by the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. The canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# PO & Tech Lead Specs + Pipeline Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write the FUNC-AC-PRODUCT-OWNER and FUNC-AC-TECH-LEAD L1 specs, update L0/coordination/quality/learning specs, update traceability, and create pipeline issues so the feature pipeline can autonomously generate L2/L3 specs and implement them.

**Architecture:** All changes are spec documents (`.specify/` markdown files) and `traceability.yml`. The design spec at `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md` is the source of truth for all content. Each task creates or modifies one spec file, commits, then moves on.

**Tech Stack:** Markdown, YAML, GitHub CLI (`gh`)

**Design spec:** `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md`

**Spec guardian skills:** Use `personal:l1-spec-guardian` when writing FUNC-AC-* specs. The guardian validates format, forbidden fields, and L1 guardrails. If the guardian flags technology references in constraints, rephrase to be technology-agnostic — do not remove the constraint.

**Terminology:** Use "gotcha" (not "observation") and "GotchaStore" (not "knowledge layer") consistently to match the existing codebase and design spec. Exception: when referring to business-level PO records that are a distinct record type, use "business observation" and note this requires a separate store or extended schema (L2 decision).

**Deferred to L2/L3:**
- **Metrics** (design spec Section 9) — metric definitions are captured in the design spec. The L1 specs do not define metrics; they define behaviors that produce measurable outcomes. Metric collection and ground-truth mechanisms (operator override records, re-review outcomes, finding dismissal tracking) are L2/L3 concerns.
- **Memory interaction map** (design spec Section 10) — the read/write flows are captured in the design spec. How agents physically interact with GotchaStore (query patterns, record types, consumer routing) is an L2 architecture decision.
- **L2/L3 scope hints** (design spec Section 12) — the pipeline issues in Task 8 reference the design spec as source of truth for downstream authors. The hints live in the design spec, not the L1 specs.

---

### Task 1: Update L0-AC-VISION with Wide PO phase

**Files:**
- Modify: `.specify/L0-vision.md` (the "Product co-ownership" bullet in "What the harness provides")

- [ ] **Step 1: Read current L0-AC-VISION**

Read `.specify/L0-vision.md` and locate the "Product co-ownership" bullet on line 23.

- [ ] **Step 2: Replace the Product co-ownership bullet**

Replace:
```
- **Product co-ownership** — analyzes the codebase and system health to propose features and improvements, always requiring Operator approval before any work begins
```

With:
```
- **Product co-ownership** (evolutionary) —
  - **Phase 1 (Medium PO):** Synthesizes existing signals — spec pipeline gaps, delivery health, backlog staleness, operator ideas — to propose the next most valuable work. Reactive intelligence: sees what exists and what is stuck.
  - **Phase 2 (Wide PO):** Develops domain understanding by reading L0 vision, project history, and operator patterns over time. Proactive intelligence: identifies strategic gaps, proposes new capabilities aligned with project vision, anticipates roadmap direction. Requires elevated operator trust, gated by demonstrated proposal quality.
  - Both phases require Operator approval before any work begins.
```

- [ ] **Step 3: Bump version**

Change `version: 2` to `version: 3` in the frontmatter.

- [ ] **Step 4: Commit**

```bash
git add .specify/L0-vision.md
git commit -m "spec(L0): add Wide PO evolutionary phases to product co-ownership"
```

---

### Task 2: Write FUNC-AC-PRODUCT-OWNER L1 spec

**Files:**
- Create: `.specify/functional/product-owner.md`

**Reference:** Design spec Sections 1 and 3 (interaction protocols — PO side)

**Skill:** Invoke `personal:l1-spec-guardian` after writing to validate format.

- [ ] **Step 1: Read design spec and existing specs for reference**

Read these files before writing:
- `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md` — Sections 1, 3 (all protocols, PO side)
- `.specify/functional/coordination.md` — for Given/When/Then style reference
- `.specify/templates/l1-functional.md` — for structure template

- [ ] **Step 2: Write the spec file**

Create `.specify/functional/product-owner.md`. Write each scenario in full Given/When/Then format matching the style in `coordination.md`. The design spec provides all content — translate it into scenarios.

Frontmatter:
```yaml
---
id: FUNC-AC-PRODUCT-OWNER
type: functional
domain: runforge
status: draft
version: 1
layer: 1
---
```

**Problem Statement:** The system can execute work but cannot decide what to work on next. Work detection finds labeled issues but nobody creates them proactively. Without a dedicated product ownership function, the operator must manually monitor spec pipeline state, delivery patterns, and backlog health to decide what to build next.

**Actors:**
- **Operator** — approves/rejects proposals, submits ideas, sets priorities
- **PO Agent** — analyzes signals, generates proposals, refines operator ideas
- **Tech Lead Agent** — participates in shared protocols (enrichment, planning, grooming, standups, retrospectives, escalation)

**Behavior — write full Given/When/Then for ALL of these scenarios:**

### Signal Analysis
```
Scenario: PO analyzes spec pipeline state
- Given the PO's scheduled cycle triggers
- When it reads the specification directory
- Then it identifies which L1 specs have L2 architecture specs, which L2s have L3 stack specs, and which L3s have been implemented
- And it flags gaps where the pipeline is stuck or incomplete

Scenario: PO reads aggregate delivery outcomes
- Given recent runs have completed
- When the PO reads delivery metrics
- Then it reads aggregate pass/fail rates and completion counts per repository
- And it does not read detailed failure reasons, error categories, or phase breakdowns (those belong to the Tech Lead)

Scenario: PO reads proposal history
- Given past proposals exist in the proposal store
- When the PO prepares for a new cycle
- Then it reads what was previously approved, rejected, and why
- And it avoids re-proposing work that was recently rejected without new justification
```

### Proposal Generation
```
Scenario: PO proposes spec advancement
- Given a spec exists at one layer but the next layer is missing
- When the PO identifies the gap
- Then it generates a proposal to advance the spec (e.g., "FUNC-AC-LEARNING has no L2 — propose generating L2 architecture spec")

Scenario: PO escalates stale work
- Given an issue has been in-progress for longer than a configurable threshold with no recent activity
- When the PO detects the staleness
- Then it generates a proposal to investigate the stale item

Scenario: PO proposes backlog prioritization
- Given multiple issues are ready for work
- When the PO evaluates the backlog
- Then it proposes an ordering based on dependency analysis, spec completeness, and business value

Scenario: PO refines operator idea
- Given the operator has submitted a rough idea through the terminal or dashboard
- When the PO processes the idea
- Then it refines it into a scoped proposal with rationale and estimated impact
- And it runs the Proposal Enrichment protocol with the Tech Lead before presenting the enriched proposal to the operator
```

### Proposal Lifecycle
```
Scenario: Proposal approval creates work request
- Given the operator approves a proposal
- When the system processes the approval
- Then it creates a work request (GitHub issue with executable labels) that work detection can pick up

Scenario: Proposal rejection is archived
- Given the operator rejects a proposal
- When the system processes the rejection
- Then it archives the proposal with the operator's reason

Scenario: Proposal expiry
- Given a proposal has been pending longer than a configurable window (default: 7 days)
- When the expiry time is reached
- Then the proposal is marked expired and removed from the active queue

Scenario: Proposal guardrails
- Given the PO generates any proposal
- When it enters the proposal queue
- Then it always requires operator approval — the system never acts on PO proposals autonomously
```

### Interaction Protocols (PO side)
```
Scenario: PO initiates proposal enrichment with Tech Lead
- Given the PO has generated a raw proposal
- When it sends the proposal to the Tech Lead for enrichment
- Then the Tech Lead adds effort estimate, dependency analysis, technical risks, and prerequisite work
- And the PO reviews the Tech Lead's input and may adjust priority or scope
- And the PO presents the enriched proposal to the operator

Scenario: PO receives Tech Lead technical proposal
- Given the Tech Lead has generated a technical proposal
- When the PO receives it for priority assessment
- Then the PO evaluates whether the proposal is worth doing now versus other backlog items
- And either forwards it to the operator with priority context, or rejects it with reason
- And the PO has veto power — it decides whether the proposal reaches the operator

Scenario: PO participates in batch planning
- Given it is time to select the next batch of work
- When the PO enters the Batch Planning protocol
- Then it brings the top N items from the backlog ordered by business priority
- And participates in a single round-trip negotiation with the Tech Lead
- And adjusts selection based on the Tech Lead's hard constraints

Scenario: PO initiates backlog grooming
- Given the PO's grooming cycle triggers or a significant backlog change occurs
- When the PO enters the Backlog Grooming protocol
- Then it brings the current prioritized backlog plus new signals
- And the Tech Lead brings updated technical landscape
- And they produce a re-prioritized backlog

Scenario: PO participates in status sync
- Given a status sync cycle triggers
- When the PO reports
- Then it shares priority changes, new operator ideas, and proposal outcomes

Scenario: PO participates in retrospective
- Given a batch has completed
- When the PO enters the Retrospective protocol
- Then it brings delivery expectations versus actuals
- And actionable items become proposals (PO) or technical debt items (Tech Lead)

Scenario: PO escalates priority shift
- Given the operator submits an urgent idea or priority change
- When the PO determines current batch items should be superseded
- Then it escalates through the Escalation protocol to the Tech Lead
- And they jointly decide whether to re-plan the batch or queue for the next cycle

Scenario: PO receives Tech Lead escalation
- Given the Tech Lead raises a technical blocker
- When the PO receives the escalation with options
- Then the PO evaluates the options against business priority and decides
```

### Degraded Paths
```
Scenario: Proposal enrichment without Tech Lead assessment
- Given the Tech Lead cannot assess effort for a proposal (e.g., unfamiliar area, insufficient data)
- When the proposal enrichment cannot complete normally
- Then the proposal goes to the operator with an "unassessed" flag indicating technical review is incomplete

Scenario: Empty batch from planning
- Given no viable batch can be formed during Batch Planning
- When all items are blocked or capacity is insufficient
- Then the protocol produces an empty batch and triggers an Escalation to the operator explaining why

Scenario: PO-only backlog grooming
- Given the Tech Lead has no new technical input during grooming
- When the PO grooms the backlog alone
- Then it records that the grooming was PO-only

Scenario: Protocol convergence failure
- Given the PO and Tech Lead cannot converge in one round during Batch Planning
- When no agreement is reached
- Then both positions go to the operator for resolution
```

### Protocol Composition
```
Scenario: Batch completion triggers protocol chain
- Given a Status Sync detects that a batch has completed
- When the system processes the event
- Then it triggers Retrospective, then Backlog Grooming, then Batch Planning for the next batch

Scenario: Stuck item triggers escalation chain
- Given a Status Sync detects a stuck work item
- When the system processes the event
- Then it triggers Escalation from Tech Lead to PO, which may trigger re-Batch Planning

Scenario: Operator idea triggers proposal chain
- Given the operator submits an idea
- When the PO refines it
- Then it runs Proposal Enrichment with the Tech Lead, and upon operator approval, triggers Backlog Grooming and Batch Planning
```

### Operator Idea Flow
```
Scenario: Operator submits idea through terminal or dashboard
- Given the operator has an idea for a feature or improvement
- When they submit it through the dashboard or terminal interface
- Then the PO receives the idea and refines it into a scoped proposal on its next cycle (debounced, default 5-minute window)
```

**Success Criteria:**
- Spec pipeline gaps are identified and proposed for advancement without operator prompting
- Stale work items are escalated before the operator notices them
- Operator ideas are refined into actionable proposals with business rationale and technical assessment
- All proposals require operator approval — no autonomous work creation

**Constraints:**
- Never proposes implementation details (Tech Lead territory)
- Never creates work without operator approval (L0 boundary)
- Never modifies specs directly
- Operates at L0-L2 only — no code-level analysis
- Scheduled cycle default: 30 minutes; event-driven debounce: 5 minutes
- Proposal expiry default: 7 days

- [ ] **Step 2: Run L1 spec guardian**

Invoke `personal:l1-spec-guardian` skill to validate the spec format. Fix any issues.

- [ ] **Step 3: Commit**

```bash
git add .specify/functional/product-owner.md
git commit -m "spec(L1): add FUNC-AC-PRODUCT-OWNER — product owner agent role"
```

---

### Task 3: Write FUNC-AC-TECH-LEAD L1 spec

**Files:**
- Create: `.specify/functional/tech-lead.md`

**Reference:** Design spec Sections 2 and 3 (interaction protocols — Tech Lead side)

**Skill:** Invoke `personal:l1-spec-guardian` after writing to validate format.

- [ ] **Step 1: Read design spec and existing specs for reference**

Read these files before writing:
- `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md` — Sections 2, 3 (all protocols, Tech Lead side), 8 (self-improvement)
- `.specify/functional/coordination.md` — for Given/When/Then style reference
- `.specify/functional/product-owner.md` — for consistency with the PO spec just written

- [ ] **Step 2: Write the spec file**

Create `.specify/functional/tech-lead.md`. Write each scenario in full Given/When/Then format matching the style used in the PO spec and `coordination.md`.

Frontmatter:
```yaml
---
id: FUNC-AC-TECH-LEAD
type: functional
domain: runforge
status: draft
version: 1
layer: 1
---
```

**Problem Statement:** The system has no agent responsible for code-level health. Review findings accumulate, deferred work grows, test coverage drifts, and dependency risks go unnoticed unless the operator manually inspects. Without a dedicated technical leadership function, the gap between specification and implementation widens silently.

**Actors:**
- **Operator** — approves technical proposals, resolves PO/Tech Lead disagreements
- **Tech Lead Agent** — analyzes code health, estimates effort, manages technical quality
- **PO Agent** — receives Tech Lead input during shared protocols, has veto power on Tech Lead proposals reaching the operator

**Behavior — write full Given/When/Then for ALL of these scenarios:**

### Signal Analysis
```
Scenario: Tech Lead reads review findings
- Given the GotchaStore contains unaddressed findings with severity ratings
- When the Tech Lead's analysis cycle triggers
- Then it reads accumulated findings and identifies areas with high finding density or severity

Scenario: Tech Lead analyzes detailed run outcomes
- Given recent runs have completed or failed
- When the Tech Lead reads run data
- Then it analyzes failure reasons, error categories, phase-level breakdowns, and retry counts
- And it identifies systemic patterns across multiple runs

Scenario: Tech Lead detects spec-code drift
- Given L3 stack specs define expected implementation patterns
- When the Tech Lead compares specs against actual implementation
- Then it identifies areas where implementation has diverged from the spec

Scenario: Tech Lead monitors TODO/FIXME density
- Given the codebase contains deferred work markers
- When the Tech Lead scans code areas
- Then it identifies areas with high TODO/FIXME concentration

Scenario: Tech Lead monitors test health
- Given CI results and coverage data exist
- When the Tech Lead reads test metrics
- Then it identifies areas with declining coverage or increasing test failures

Scenario: Tech Lead monitors dependency risks
- Given the project has external package dependencies
- When the Tech Lead checks dependency health
- Then it identifies outdated packages and known security advisories
```

### Proposal Generation
```
Scenario: Tech Lead proposes technical debt reduction
- Given an area has accumulated TODOs and recurring gotchas
- When the Tech Lead identifies the pattern
- Then it generates a proposal for targeted refactoring of that area

Scenario: Tech Lead proposes quality improvement
- Given test coverage in an area has dropped below a threshold
- When the Tech Lead detects the regression
- Then it generates a proposal for coverage hardening

Scenario: Tech Lead raises architecture concern
- Given spec-code drift has been detected
- When the drift affects system correctness or maintainability
- Then it generates a proposal to realign implementation with the spec

Scenario: Tech Lead proposes dependency update
- Given packages have known vulnerabilities
- When the Tech Lead identifies the risk
- Then it generates a proposal for an update batch

Scenario: Tech Lead proposes failure pattern investigation
- Given multiple recent runs in a repository failed at the same phase
- When the Tech Lead detects the pattern
- Then it generates a proposal to investigate the root cause
```

### Proposal Lifecycle
```
Scenario: Tech Lead proposal flows through PO
- Given the Tech Lead has generated a technical proposal
- When it submits the proposal for enrichment
- Then the PO evaluates business priority and either forwards to operator with context or rejects with reason

Scenario: PO rejects Tech Lead proposal
- Given the PO has rejected a Tech Lead proposal
- When the rejection is recorded
- Then the PO records the rejection reason
- And the Tech Lead may re-propose with stronger evidence on any subsequent cycle (scheduled or event-driven)

Scenario: Tech Lead re-proposes with stronger evidence
- Given a previous proposal was rejected by the PO
- When the Tech Lead has gathered additional evidence supporting the proposal
- Then it generates a new proposal with the stronger evidence and a reference to the prior rejection
```

### Interaction Protocols (Tech Lead side)
```
Scenario: Tech Lead enriches PO business proposal
- Given the PO has generated a raw business proposal
- When the Tech Lead receives it for enrichment
- Then it adds effort estimate, dependency analysis, technical risks, and prerequisite work
- And returns the enrichment to the PO

Scenario: Tech Lead initiates technical proposal
- Given the Tech Lead has generated a technical proposal
- When it enters the Proposal Enrichment protocol
- Then the PO evaluates business priority
- And the PO has veto power — it decides whether the proposal reaches the operator

Scenario: Tech Lead participates in batch planning
- Given it is time to select the next batch of work
- When the Tech Lead enters the Batch Planning protocol
- Then it brings the dependency graph, capacity assessment, and current system health
- And identifies hard constraints (dependencies, parallelism limits, capacity)
- And determines how many items, in what order, and what can parallelize

Scenario: Tech Lead participates in backlog grooming
- Given the PO has initiated backlog grooming
- When the Tech Lead joins the protocol
- Then it brings the updated technical landscape (new findings, resolved debt, changed dependencies)
- And flags items as blocked or risky

Scenario: Tech Lead reports in status sync
- Given a status sync cycle triggers
- When the Tech Lead reports
- Then it shares active work status, stuck items, completed items, and resource utilization

Scenario: Tech Lead participates in retrospective
- Given a batch has completed
- When the Tech Lead enters the Retrospective protocol
- Then it brings failure analysis, recurring patterns, resource utilization, and gotcha trends
- And actionable items become technical debt proposals

Scenario: Tech Lead escalates technical blocker
- Given a work item has failed or encountered a blocker
- When the Tech Lead determines it requires PO input
- Then it escalates through the Escalation protocol with options (retry, skip, fix spec first)

Scenario: Tech Lead receives PO priority escalation
- Given the PO escalates a priority shift
- When the Tech Lead receives the escalation
- Then it evaluates capacity impact and jointly decides with the PO whether to re-plan or queue
```

### Degraded Paths
```
Scenario: Tech Lead cannot assess effort
- Given the Tech Lead receives a proposal for enrichment in an unfamiliar area
- When it cannot produce a reliable effort estimate
- Then it returns an "unassessed" flag so the proposal reaches the operator with incomplete technical review

Scenario: Escalation to unavailable PO
- Given the Tech Lead raises an escalation but the PO is mid-analysis
- When the escalation cannot be processed immediately
- Then it queues and processes on the next tick
- And time-critical escalations (budget exceeded, system down) bypass the protocol and go directly to the operator
```

### Self-Improvement Connection
```
Scenario: Tech Lead distills retrospective lessons into gotchas
- Given the Retrospective protocol has produced lessons learned
- When the Tech Lead distills a technical lesson
- Then it deposits the gotcha into GotchaStore with severity, affected area, and root cause
- And the gotcha becomes available for injection into future sessions

Scenario: Tech Lead detects recurring gotcha pattern
- Given the same root cause appears in gotchas exceeding a configurable threshold (default: 3)
- When the Tech Lead detects the pattern
- Then it generates a technical debt proposal to address the root cause systemically
```

### Protocol Composition
```
Scenario: Batch completion triggers protocol chain
- Given a Status Sync detects that a batch has completed
- When the system processes the event
- Then it triggers Retrospective, then Backlog Grooming, then Batch Planning for the next batch

Scenario: Failure triggers escalation chain
- Given a Status Sync detects a stuck work item or repeated failure
- When the Tech Lead evaluates the situation
- Then it triggers Escalation to the PO, which may trigger re-Batch Planning
```

**Success Criteria:**
- Review findings translate to actionable proposals at a measurable rate
- Spec-code drift is detected and proposed for resolution within configured cycles
- Failure patterns are identified and proposed before the operator notices
- All technical proposals flow through PO priority assessment before reaching operator

**Constraints:**
- Never proposes features or business priorities (PO territory)
- Never modifies specs directly
- Operates at L2-L3 — no business-level decisions
- Technical proposals always flow through PO for priority assessment before reaching operator
- Scheduled analysis default: 2 hours; event-driven on failures and findings
- Proposal expiry default: 7 days
- Recurring gotcha threshold: configurable, default 3

- [ ] **Step 2: Run L1 spec guardian**

Invoke `personal:l1-spec-guardian` skill to validate the spec format. Fix any issues.

- [ ] **Step 3: Commit**

```bash
git add .specify/functional/tech-lead.md
git commit -m "spec(L1): add FUNC-AC-TECH-LEAD — tech lead agent role"
```

---

### Task 4: Narrow FUNC-AC-COORDINATION

**Files:**
- Modify: `.specify/functional/coordination.md`

**Reference:** Design spec Sections 5 and 7.

- [ ] **Step 1: Read the current spec**

Read `.specify/functional/coordination.md` fully.

- [ ] **Step 2: Replace the Product Ownership section**

Remove lines 26-51 (the five Product Ownership scenarios: "System proposes a feature," "Operator approves a proposal," "Operator submits an idea," "Proposal expiry," "Proposal guardrails").

Replace with:
```markdown
### Product Ownership

Product ownership behavior — proposal generation, signal analysis, operator idea refinement — is defined in FUNC-AC-PRODUCT-OWNER. Technical health analysis and effort estimation is defined in FUNC-AC-TECH-LEAD. This spec covers the coordination mechanics that both roles participate in: batch planning execution, merge sequencing, concurrency management, and failure recovery.
```

- [ ] **Step 3: Add preconditions to batch scenarios**

Find and update each scenario by replacing its Given/When/Then lines:

**"System creates a batch from related work"** — replace the Given line:
- Old: `- Given multiple related issues are ready for work`
- New: `- Given the PO and Tech Lead have agreed on a batch through the Batch Planning protocol and multiple related issues are ready for work`

**"Independent work dispatches immediately"** — replace the Given line:
- Old: `- Given an issue is ready for work and has no dependencies on other pending issues`
- New: `- Given the PO has approved an issue for immediate dispatch and it has no dependencies on other pending issues`

**"Higher-priority work arrives"** — replace the When line:
- Old: `- When new work arrives that the system judges to be higher priority`
- New: `- When the PO escalates new work as higher priority through the Escalation protocol`

**"Work item gets stuck"** — replace the Then line:
- Old: `- Then it decides whether to retry the issue, skip it, or re-plan the batch around the failure`
- New: `- Then the coordination engine uses an LLM-augmented decision point to determine the response (retry, skip, or re-plan) and routes the impediment through the Escalation protocol to PO or Tech Lead as appropriate`

- [ ] **Step 4: Add LLM-Augmented Decision Points section**

Add immediately before the line `### Concurrency Management`:
```markdown
### LLM-Augmented Decision Points

The coordination engine uses lightweight LLM inference at specific decision junctures where deterministic rules are insufficient. These calls receive narrow context (current work item state, recent activity, failure reason) and return a single routing decision. They do not generate proposals, modify specs, or initiate protocols — they inform the state machine's next transition.
```

- [ ] **Step 5: Update relationship note**

Update the "Relationship to Other Specs" section to reference FUNC-AC-PRODUCT-OWNER and FUNC-AC-TECH-LEAD.

- [ ] **Step 6: Bump version**

Change `version: 2` to `version: 3` in the frontmatter.

- [ ] **Step 7: Commit**

```bash
git add .specify/functional/coordination.md
git commit -m "spec(L1): narrow FUNC-AC-COORDINATION — extract PO/TL, add LLM decision points"
```

---

### Task 5: Clarify FUNC-AC-QUALITY (QA vs. proactive review)

**Files:**
- Modify: `.specify/functional/quality-assurance.md`

**Reference:** Design spec Section 4.

- [ ] **Step 1: Read the current spec**

Read `.specify/functional/quality-assurance.md` fully.

- [ ] **Step 2: Add two new scenarios**

Add after the existing review scenarios:

```markdown
### Review Modes

**Scenario: Assigned QA review**
- Given a work item has completed implementation
- When the pipeline submits it for quality review
- Then the QA agent receives relevant gotchas for the reviewed area (injected from the knowledge layer)
- And reviews the specific implementation against its spec, acceptance criteria, and quality standards
- And produces a pass/fail verdict with structured feedback
- And writes discovered issues to the knowledge layer

**Scenario: Proactive codebase review**
- Given the proactive review agent's scheduled cycle triggers
- When it scans a codebase area
- Then it identifies issues independently of any active work item
- And records findings as issues labeled for review that feed the Tech Lead's signal analysis
- And the system never dispatches proactive review work through the pipeline gate — the two modes are independent

**Scenario: Proactive review work detection boundary**
- Given the proactive review agent has created a finding
- When the work detection system scans for executable work
- Then it excludes review findings from the executable scan
- And findings only become executable work when the Tech Lead proposes remediation, the PO approves, the operator approves, and a new work request is created with executable labels
```

- [ ] **Step 3: Bump version**

Change `version: 2` to `version: 3`.

- [ ] **Step 4: Commit**

```bash
git add .specify/functional/quality-assurance.md
git commit -m "spec(L1): add QA vs proactive review distinction to FUNC-AC-QUALITY"
```

---

### Task 6: Connect FUNC-AC-LEARNING (retrospective and prospective scenarios)

**Files:**
- Modify: `.specify/functional/institutional-learning.md`

**Reference:** Design spec Section 8.

- [ ] **Step 1: Read the current spec**

Read `.specify/functional/institutional-learning.md` fully.

- [ ] **Step 2: Add three new scenarios**

Add a new section "### Retrospective Learning" after the last existing section (likely "Knowledge from Implementation Records" or similar). Find the last scenario in the file and add after it:

```markdown
### Retrospective Learning

**Scenario: Retrospective feeds institutional knowledge**
- Given the Retrospective protocol produces lessons learned
- When the Tech Lead distills a technical lesson into a gotcha
- Then the gotcha enters GotchaStore and becomes available for injection into future sessions

**Scenario: Business-level retrospective lessons**
- Given the Retrospective protocol produces business-level lessons
- When the PO records a business observation (e.g., "this type of proposal consistently gets rejected")
- Then the business observation is stored as a distinct record type from technical gotchas
- And it is available to the PO for future proposal generation

**Scenario: Recurring gotcha triggers systemic proposal**
- Given the same root cause appears in gotchas exceeding a configurable threshold (default: 3)
- When the Tech Lead detects the pattern
- Then it generates a technical debt proposal to address the root cause

### Prospective Checks

**Scenario: Prospective gotcha check at batch planning**
- Given the coordination engine is preparing a batch for the Batch Planning protocol
- When it queries GotchaStore for gotchas related to the planned work areas
- Then high-severity gotchas are flagged and included in the Tech Lead's input to Batch Planning
- And the Tech Lead factors historical failures into effort estimates and risk assessments
```

- [ ] **Step 3: Bump version**

Change `version: 2` to `version: 3`.

- [ ] **Step 4: Commit**

```bash
git add .specify/functional/institutional-learning.md
git commit -m "spec(L1): add retrospective/prospective learning scenarios to FUNC-AC-LEARNING"
```

---

### Task 7: Update traceability.yml

**Files:**
- Modify: `.specify/traceability.yml`

- [ ] **Step 1: Add FUNC-AC-PRODUCT-OWNER and FUNC-AC-TECH-LEAD to L0-AC-VISION children**

Update the L0-AC-VISION entry (line 54-56). Add the two new spec IDs to the children list:

```yaml
L0-AC-VISION:
  children: [FUNC-AC-PIPELINE, FUNC-AC-IMPLEMENTATION, FUNC-AC-QUALITY, FUNC-AC-SAFETY, FUNC-AC-BUG-TRIAGE, FUNC-AC-LEARNING, FUNC-AC-HANDOFF, FUNC-AC-DASHBOARD, FUNC-AC-COORDINATION, FUNC-AC-PLUGINS, FUNC-AC-PRODUCT-OWNER, FUNC-AC-TECH-LEAD, STACK-AC-CONVENTIONS]
  status: draft
```

- [ ] **Step 2: Add new L1 spec entries**

Add after the existing L1 specs (after FUNC-AC-PLUGINS block, before L2 specs):

```yaml
FUNC-AC-PRODUCT-OWNER:
  children: []
  status: draft

FUNC-AC-TECH-LEAD:
  children: []
  status: draft
```

- [ ] **Step 3: Commit**

```bash
git add .specify/traceability.yml
git commit -m "spec: add FUNC-AC-PRODUCT-OWNER and FUNC-AC-TECH-LEAD to traceability"
```

---

### Task 8: Create feature pipeline GitHub issues

**Files:** None (GitHub API only)

- [ ] **Step 1: Create FUNC-AC-PRODUCT-OWNER pipeline issue**

```bash
gh issue create --repo DANIELSOCRAHANDLEZZ/runforge \
  --title "FUNC-AC-PRODUCT-OWNER: Product Owner agent L1 spec ready for L2 generation" \
  --body "$(cat <<'EOF'
## Spec Reference
- L1: `.specify/functional/product-owner.md` (FUNC-AC-PRODUCT-OWNER)
- Design: `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md`

## Summary
The Product Owner agent synthesizes spec pipeline state, delivery health, backlog staleness, operator ideas, and proposal history to propose the next most valuable work. Interacts with Tech Lead through six structured protocols.

## Pipeline Action
Generate L2 architecture spec for the PO agent — covering communication mechanism, protocol scheduling, proposal storage, and signal aggregation.
EOF
)" \
  --label "feature-pipeline" --label "l1-approved"
```

- [ ] **Step 2: Create FUNC-AC-TECH-LEAD pipeline issue**

```bash
gh issue create --repo DANIELSOCRAHANDLEZZ/runforge \
  --title "FUNC-AC-TECH-LEAD: Tech Lead agent L1 spec ready for L2 generation" \
  --body "$(cat <<'EOF'
## Spec Reference
- L1: `.specify/functional/tech-lead.md` (FUNC-AC-TECH-LEAD)
- Design: `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md`

## Summary
The Tech Lead agent synthesizes review findings, run outcomes, spec-code drift, TODO density, test health, and dependency risks to propose technical improvements. Interacts with PO through six structured protocols.

## Pipeline Action
Generate L2 architecture spec for the Tech Lead agent — covering signal aggregation, proposal flow through PO, knowledge layer interaction, and coordination engine integration.
EOF
)" \
  --label "feature-pipeline" --label "l1-approved"
```

- [ ] **Step 3: Create coordination update pipeline issue**

```bash
gh issue create --repo DANIELSOCRAHANDLEZZ/runforge \
  --title "FUNC-AC-COORDINATION v3: Narrowed scope + LLM-augmented decision points" \
  --body "$(cat <<'EOF'
## Spec Reference
- L1: `.specify/functional/coordination.md` (FUNC-AC-COORDINATION v3)
- Design: `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md` Sections 5, 7

## Summary
Product Ownership extracted to FUNC-AC-PRODUCT-OWNER/FUNC-AC-TECH-LEAD. Batch scenarios now route through PO/TL protocols. New LLM-Augmented Decision Points section added.

## Pipeline Action
Update existing L2 ARCH-AC-COORDINATION to reflect narrowed scope and new LLM decision points.
EOF
)" \
  --label "feature-pipeline" --label "l1-approved"
```

- [ ] **Step 4: Create quality update pipeline issue**

```bash
gh issue create --repo DANIELSOCRAHANDLEZZ/runforge \
  --title "FUNC-AC-QUALITY v3: QA agent vs proactive review agent distinction" \
  --body "$(cat <<'EOF'
## Spec Reference
- L1: `.specify/functional/quality-assurance.md` (FUNC-AC-QUALITY v3)
- Design: `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md` Section 4

## Summary
Adds explicit distinction between assigned QA review (pipeline gate) and proactive codebase review (self-directed). Clarifies work detection boundary: review findings are excluded from executable work scan.

## Pipeline Action
Update existing L2 ARCH-AC-VALIDATION to reflect the two review modes and work detection boundary.
EOF
)" \
  --label "feature-pipeline" --label "l1-approved"
```

- [ ] **Step 5: Create learning update pipeline issue**

```bash
gh issue create --repo DANIELSOCRAHANDLEZZ/runforge \
  --title "FUNC-AC-LEARNING v3: Retrospective/prospective learning scenarios" \
  --body "$(cat <<'EOF'
## Spec Reference
- L1: `.specify/functional/institutional-learning.md` (FUNC-AC-LEARNING v3)
- Design: `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md` Section 8

## Summary
Adds retrospective → knowledge pipeline (Tech Lead distills lessons, PO records business observations as distinct record type). Adds prospective gotcha check at batch planning. Adds recurring gotcha → systemic proposal trigger.

## Pipeline Action
Update existing L2 ARCH-AC-KNOWLEDGE to reflect new record types, retrospective pipeline, and prospective checks.
EOF
)" \
  --label "feature-pipeline" --label "l1-approved"
```

- [ ] **Step 6: Verify issues created**

```bash
gh issue list --repo DANIELSOCRAHANDLEZZ/runforge --label "feature-pipeline" --label "l1-approved" --state open
```

Verify all 5 issues appear.
