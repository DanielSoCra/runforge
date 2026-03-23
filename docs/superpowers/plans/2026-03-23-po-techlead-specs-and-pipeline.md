# PO & Tech Lead Specs + Pipeline Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write the FUNC-AC-PRODUCT-OWNER and FUNC-AC-TECH-LEAD L1 specs, update L0/coordination/quality/learning specs, update traceability, and create pipeline issues so the feature pipeline can autonomously generate L2/L3 specs and implement them.

**Architecture:** All changes are spec documents (`.specify/` markdown files) and `traceability.yml`. The design spec at `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md` is the source of truth for all content. Each task creates or modifies one spec file, commits, then moves on.

**Tech Stack:** Markdown, YAML, GitHub CLI (`gh`)

**Design spec:** `docs/superpowers/specs/2026-03-23-po-techlead-roles-design.md`

**Spec guardian skills:** Use `personal:l1-spec-guardian` when writing FUNC-AC-* specs. The guardian validates format, forbidden fields, and L1 guardrails.

---

### Task 1: Update L0-AC-VISION with Wide PO phase

**Files:**
- Modify: `.specify/L0-vision.md:22-23`

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

- [ ] **Step 1: Write the spec file**

Create `.specify/functional/product-owner.md` with the following content. Use the L1 template format (`---` frontmatter, Problem Statement, Actors, Behavior with Given/When/Then scenarios, Success Criteria, Constraints).

Frontmatter:
```yaml
---
id: FUNC-AC-PRODUCT-OWNER
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---
```

**Problem Statement:** From design spec Section 1 — the system can execute work but cannot decide what to work on next. Work detection finds labeled issues but nobody creates them proactively. The PO synthesizes spec pipeline state, delivery health, backlog age, operator ideas, and proposal history to propose the next most valuable work.

**Actors:**
- **Operator** — approves/rejects proposals, submits ideas, sets priorities
- **PO Agent** — analyzes signals, generates proposals, refines operator ideas

**Behavior sections to include (each as Given/When/Then scenarios):**

Signal Analysis:
- Scenario: PO analyzes spec pipeline state
- Scenario: PO reads aggregate delivery outcomes
- Scenario: PO reads proposal history

Proposal Generation:
- Scenario: PO proposes spec advancement
- Scenario: PO escalates stale work
- Scenario: PO proposes backlog prioritization
- Scenario: PO refines operator idea

Proposal Lifecycle:
- Scenario: Proposal approval creates work request
- Scenario: Proposal rejection is archived
- Scenario: Proposal expiry
- Scenario: Proposal guardrails (always requires operator approval)

Interaction Protocols (PO side):
- Scenario: PO initiates proposal enrichment with Tech Lead
- Scenario: PO receives Tech Lead technical proposal for priority assessment
- Scenario: PO participates in batch planning
- Scenario: PO initiates backlog grooming
- Scenario: PO participates in status sync
- Scenario: PO participates in retrospective
- Scenario: PO escalates priority shift
- Scenario: PO receives Tech Lead escalation

Operator Idea Flow:
- Scenario: Operator submits idea through terminal or dashboard

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

- [ ] **Step 1: Write the spec file**

Create `.specify/functional/tech-lead.md` with L1 template format.

Frontmatter:
```yaml
---
id: FUNC-AC-TECH-LEAD
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---
```

**Problem Statement:** From design spec Section 2 — the system has no agent responsible for code-level health. Review findings accumulate, TODOs grow, test coverage drifts, and dependency risks go unnoticed unless the operator manually inspects. The Tech Lead synthesizes technical signals and proposes improvements.

**Actors:**
- **Operator** — approves technical proposals, resolves PO/Tech Lead disagreements
- **Tech Lead Agent** — analyzes code health, estimates effort, manages technical quality
- **PO Agent** — receives Tech Lead input during shared protocols

**Behavior sections (Given/When/Then):**

Signal Analysis:
- Scenario: Tech Lead reads review findings from GotchaStore
- Scenario: Tech Lead analyzes detailed run outcomes
- Scenario: Tech Lead detects spec-code drift
- Scenario: Tech Lead monitors TODO/FIXME density
- Scenario: Tech Lead monitors test health
- Scenario: Tech Lead monitors dependency risks

Proposal Generation:
- Scenario: Tech Lead proposes technical debt reduction
- Scenario: Tech Lead proposes quality improvement
- Scenario: Tech Lead raises architecture concern
- Scenario: Tech Lead proposes dependency update
- Scenario: Tech Lead proposes failure pattern investigation

Proposal Lifecycle:
- Scenario: Tech Lead proposal flows through PO for priority assessment
- Scenario: PO rejects Tech Lead proposal with reason
- Scenario: Tech Lead re-proposes with stronger evidence

Interaction Protocols (Tech Lead side):
- Scenario: Tech Lead enriches PO business proposal
- Scenario: Tech Lead initiates technical proposal enrichment
- Scenario: Tech Lead participates in batch planning (dependency graph, capacity)
- Scenario: Tech Lead participates in backlog grooming (technical landscape)
- Scenario: Tech Lead reports in status sync
- Scenario: Tech Lead participates in retrospective (failure analysis, gotcha trends)
- Scenario: Tech Lead escalates technical blocker
- Scenario: Tech Lead receives PO priority escalation

Self-Improvement Connection:
- Scenario: Tech Lead distills retrospective lessons into gotchas
- Scenario: Tech Lead detects recurring gotcha pattern and proposes systemic fix

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

Update these scenarios with preconditions:

- "System creates a batch from related work" — add: "Given the PO and Tech Lead have agreed on a batch through the Batch Planning protocol..."
- "Independent work dispatches immediately" — add: "Given the PO has approved the issue for immediate dispatch..."
- "Higher-priority work arrives" — rewrite trigger: "When the PO escalates new work as higher priority through the Escalation protocol..."
- "Work item gets stuck" — add: "Then the coordination engine uses an LLM-augmented decision point to determine the response (retry, skip, or re-plan) and routes the impediment through the Escalation protocol to PO or Tech Lead as appropriate"

- [ ] **Step 4: Add LLM-Augmented Decision Points section**

Add before "Concurrency Management":
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

Add a new section "### Retrospective Learning" after the existing sections:

```markdown
### Retrospective Learning

**Scenario: Retrospective feeds institutional knowledge**
- Given the Retrospective protocol produces lessons learned
- When the Tech Lead distills a lesson into a structured observation
- Then the observation enters the knowledge store and becomes available for injection into future sessions

**Scenario: Business-level retrospective lessons**
- Given the Retrospective protocol produces business-level lessons
- When the PO records a business observation (e.g., "this type of proposal consistently gets rejected")
- Then the observation is stored as a distinct record type from technical observations and is available to the PO for future proposal generation

**Scenario: Recurring observation triggers systemic proposal**
- Given the same root cause appears in observations exceeding a configurable threshold (default: 3)
- When the Tech Lead detects the pattern
- Then it generates a technical debt proposal to address the root cause

### Prospective Checks

**Scenario: Prospective observation check at batch planning**
- Given the coordination engine is preparing a batch for the Batch Planning protocol
- When it queries the knowledge store for observations related to the planned work areas
- Then high-severity observations are flagged and included in the Tech Lead's input to Batch Planning
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
gh issue create --repo DANIELSOCRAHANDLEZZ/auto-claude \
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
gh issue create --repo DANIELSOCRAHANDLEZZ/auto-claude \
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
gh issue create --repo DANIELSOCRAHANDLEZZ/auto-claude \
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
gh issue create --repo DANIELSOCRAHANDLEZZ/auto-claude \
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
gh issue create --repo DANIELSOCRAHANDLEZZ/auto-claude \
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
gh issue list --repo DANIELSOCRAHANDLEZZ/auto-claude --label "feature-pipeline" --label "l1-approved" --state open
```

Verify all 5 issues appear.
