---
date: 2026-03-23
status: superseded
superseded_by: .specify/L0-ac-vision.md  # unified L0-AC-VISION v5 + its L1 children (per the 2026-05-29 spec-reconciliation ledger)
superseded_date: 2026-06-02
---

> **⛔ SUPERSEDED (2026-06-02).** This design doc's still-valid content has been folded into the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. Retained for history; the canonical specs in `.specify/` govern — do not act on it as a live instruction. See the Spec Reconciliation Ledger (`docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). <!-- RECONCILIATION-LEDGER-BANNER -->

# Design: PO and Tech Lead Agent Roles

**Date:** 2026-03-23
**Status:** Draft
**Scope:** L1 spec changes to define Product Owner and Tech Lead agents, update L0 vision for Wide PO north star, narrow FUNC-AC-COORDINATION, clarify QA vs. proactive review distinction, add LLM-augmented coordination, connect self-improvement and metrics

## Definitions

- **Medium PO** — Phase 1 of the Product Owner capability. Synthesizes existing signals (spec pipeline gaps, delivery health, backlog staleness, operator ideas) to propose the next most valuable work. Reactive intelligence: sees what exists and what is stuck.
- **Wide PO** — Phase 2 (future). Develops domain understanding from L0 vision and project history to proactively identify strategic gaps. Captured in L0 as a north star, not an implementation target.
- **QA Agent** — Assigned reviewer. Gets specific work products (PRs, implementations) assigned by the pipeline. Produces pass/fail verdicts with feedback. Pipeline gate — work does not merge without QA sign-off.
- **Proactive Review Agent** — Self-directed explorer. Scans the codebase on a schedule, finds issues on its own. Produces findings (GitHub issues labeled `review-finding`). Feeds the Tech Lead's signal analysis.
- **LLM-augmented coordination** — The coordination engine (FUNC-AC-COORDINATION) is a deterministic state machine augmented with lightweight LLM inference calls at specific decision junctures. Not a full agent session — targeted, narrow-context calls for routing decisions.

## Problem

The runforge system can execute work but cannot decide what to work on next. Work detection finds labeled issues, but nobody creates those issues proactively. The coordination spec (FUNC-AC-COORDINATION) lumps product ownership, technical health, and coordination mechanics into one spec — blurring responsibilities and leaving agent behavior underspecified.

Two distinct roles are missing:

1. **Product Owner** — decides *what* to build and *why*, operating at the L0-L2 layer
2. **Tech Lead** — decides *how* to build it and guards code health, operating at the L2-L3 layer

These roles interact through structured protocols, not free-form communication. The protocols define when agents exchange information, what each contributes, and who has decision authority.

## Changes

### 1. New spec: FUNC-AC-PRODUCT-OWNER (Medium PO)

**Signal sources:**

| Signal | What the PO reads | What it indicates |
|---|---|---|
| Spec pipeline state | `.specify/` — which L1s have L2s, which L2s have L3s, which are implemented | Pipeline gaps and bottlenecks |
| Delivery outcomes (aggregate) | Recent run history — success/failure rates per repo, completion counts | Whether the team is delivering or struggling |
| Operator ideas | Ideas submitted via terminal or dashboard | Explicit operator intent |
| Issue backlog | Open GitHub issues — labels, age, staleness | Forgotten or aging work |
| Proposal history | Past proposals — what was approved, rejected, and why | Avoid re-proposing rejected work; learn from acceptance patterns |

The PO reads aggregate delivery metrics (pass/fail rates, throughput). Detailed failure analysis (error categories, phase breakdowns, retry counts) belongs to the Tech Lead.

**Proposal types:**

1. **Spec advancement** — "FUNC-AC-LEARNING has no L2. Propose generating L2 architecture spec."
2. **Stale work escalation** — "Issue #47 has been in-progress for 3 days with no commits. Propose investigation."
3. **Backlog prioritization** — "5 issues are ready. Propose this ordering based on dependency analysis and spec completeness."
4. **Operator idea refinement** — Operator submits a rough idea; PO refines it into a scoped proposal with rationale and estimated impact.

**Proposal lifecycle:** generated → pending → approved (creates GitHub issue) | rejected (archived) | expired (default: 7 days)

**Cadence:** Scheduled cycle (default: 30 minutes) + event-driven on operator idea submission (debounced, 5-minute window).

**Operator idea flow:** When the operator submits an idea, the PO first refines it into a scoped proposal (proposal type 4), then runs Protocol 1 (Proposal Enrichment) with the Tech Lead before presenting the enriched proposal to the operator for approval.

**Constraints:**
- Never proposes implementation details (Tech Lead territory)
- Never creates work without operator approval (L0 boundary)
- Never modifies specs directly
- Operates at L0-L2 only — no code-level analysis

### 2. New spec: FUNC-AC-TECH-LEAD

**Signal sources:**

| Signal | What the Tech Lead reads | What it indicates |
|---|---|---|
| Review findings | GotchaStore — unaddressed findings with severity | Known issues accumulating |
| Run outcomes (detailed) | Failure reasons, error categories, phase breakdowns, retry counts | Systemic implementation problems |
| Spec-code drift | L3 specs vs actual implementation | Implementation diverging from design |
| TODO/FIXME density | Code grep per area | Deferred work accumulating |
| Test health | CI results, coverage trends | Quality regression |
| Dependency risks | Outdated packages, security advisories | Supply chain exposure |

**Proposal types:**

1. **Technical debt reduction** — "The merge-agent has 12 TODOs and 3 recurring gotchas. Propose targeted refactoring."
2. **Quality improvement** — "Test coverage in validation dropped below threshold. Propose coverage hardening."
3. **Architecture concern** — "Session-runtime adapter has spec-code drift. Propose realignment."
4. **Dependency update** — "3 packages have known vulnerabilities. Propose update batch."
5. **Failure pattern response** — "Last 4 runs in repo X failed at review phase. Propose investigation."

**Proposal lifecycle:** Same as PO: generated → pending → approved (creates GitHub issue) | rejected (archived) | expired (default: 7 days). The PO may reject a Tech Lead proposal before it reaches the operator if business priority does not justify it; the PO records the rejection reason, and the Tech Lead may re-propose with stronger evidence on any subsequent cycle (scheduled or event-driven).

**Cadence:** Scheduled analysis (default: 2 hours) + event-driven on run failures, new review findings, or batch retrospective completion.

**Constraints:**
- Never proposes features or business priorities (PO territory)
- Never modifies specs directly
- Operates at L2-L3 — no business-level decisions
- Technical proposals always flow through PO for priority assessment before reaching operator

### 3. Interaction Protocols

PO and Tech Lead interact through six structured protocols. Each has a trigger, participants, inputs, outputs, and decision authority. The protocols are defined at L1; the communication mechanism (shared state, message passing, orchestration) is an L2 concern.

#### Protocol 1: Proposal Enrichment (bidirectional)

No proposal reaches the operator without input from both agents.

**PO-initiated (business proposals):**

1. PO generates raw proposal (business rationale, spec references, estimated value)
2. Tech Lead enriches: effort estimate, dependency analysis, technical risks, prerequisite work
3. PO reviews Tech Lead input, may adjust priority or scope
4. The PO presents the enriched proposal to the operator (operator sees both business case and technical assessment)

**Tech Lead-initiated (technical proposals):**

1. Tech Lead generates raw proposal (technical evidence, affected areas, risk assessment)
2. PO evaluates business priority: worth doing now vs. other backlog items?
3. PO either forwards to operator with priority context, or rejects with reason
4. If rejected, the Tech Lead may re-propose with stronger evidence on the next cycle

**Decision authority:** For PO-initiated proposals, the PO owns whether to propose; the Tech Lead's enrichment is advisory but always attached. For Tech Lead-initiated proposals, the PO has veto power — the PO decides whether the proposal reaches the operator, consistent with the constraint that all technical proposals flow through PO for priority assessment. The Tech Lead owns whether to *generate* the proposal, but the PO controls whether it *advances*.

**Degraded path:** If the Tech Lead cannot assess effort (e.g., unfamiliar area, insufficient data), the proposal goes to the operator with an "unassessed" flag. The operator sees that technical review is incomplete.

#### Protocol 2: Batch Planning ("Sprint Planning")

When selecting the next batch of work, neither agent decides alone.

1. PO brings top N items from backlog, ordered by business priority
2. Tech Lead brings dependency graph, capacity assessment, current system health
3. Single round-trip negotiation: Tech Lead flags hard constraints (dependencies, parallelism limits, capacity); PO adjusts selection based on technical reality. If they cannot converge in one round, both positions go to the operator for resolution.
4. Output: batch with ordering, parallelism map, budget estimate

**Decision authority:** PO selects *what*. Tech Lead determines *how many*, *in what order*, and *what can parallelize*. Tech Lead vetoes on hard technical constraints. PO overrides on value tradeoffs.

**Degraded path:** If no viable batch can be formed (all items blocked, insufficient capacity), the protocol produces an empty batch and triggers an Escalation to the operator explaining why.

#### Protocol 3: Backlog Grooming (periodic, PO-initiated)

Regular check that priorities still reflect reality.

1. PO brings current prioritized backlog + new signals (ideas, stale items, completed specs)
2. Tech Lead brings updated technical landscape (new findings, resolved debt, changed dependencies)
3. Output: re-prioritized backlog — items move up (blockers cleared), down (new risks), or out (overtaken by events)

**Decision authority:** PO owns priority order. Tech Lead flags items as blocked or risky.

**Degraded path:** If the Tech Lead has no new technical input, the PO grooms the backlog solo and records that the grooming was PO-only.

#### Protocol 4: Escalation (event-driven, either party)

One agent raises a concern to the other when something changes significantly.

**Tech Lead escalation (technical blocker):**
- "Item #47 failed — spec is ambiguous about error handling. Options: (a) retry with clarification, (b) skip, (c) fix spec first."
- PO evaluates against business priority and decides.

**PO escalation (priority shift):**
- "Operator submitted an urgent idea. This supersedes batch items 3 and 5."
- Tech Lead evaluates capacity impact. Joint decision: re-plan or queue for next cycle.

**Decision authority:** Each agent decides within their domain. If domains clash (urgent feature vs. system stability), both positions go to the operator for resolution.

**Degraded path:** If the receiving agent is unavailable (e.g., mid-analysis), the escalation queues and processes on the next tick. Time-critical escalations (budget exceeded, system down) bypass the protocol and go directly to the operator.

#### Protocol 5: Status Sync ("Standup")

Lightweight, frequent, informational. Keeps both agents aligned.

1. Tech Lead reports: active work status, stuck items, completed items, resource utilization
2. PO reports: priority changes, new operator ideas, proposal outcomes
3. Output: shared state update — may trigger Escalation, Batch Planning, or Backlog Grooming

**Decision authority:** Informational only. Triggers other protocols when action is needed.

#### Protocol 6: Retrospective (after batch completion)

Both agents review what happened before planning the next batch.

1. PO brings delivery expectations vs actuals
2. Tech Lead brings failure analysis, recurring patterns, resource utilization, gotcha trends
3. Output: lessons learned (may generate proposals or technical debt items), process adjustments (batch size, concurrency, review intensity)

**Decision authority:** Joint. Actionable items become proposals (PO) or technical debt items (Tech Lead).

#### Protocol Composition

Protocols chain naturally:

- Status Sync detects batch complete → Retrospective → Backlog Grooming → Batch Planning → new batch
- Status Sync detects stuck item → Escalation (Tech Lead → PO) → may trigger re-Batch Planning
- Operator submits idea → PO refines → Proposal Enrichment (PO ↔ Tech Lead) → operator approves → Backlog Grooming → Batch Planning

### 4. QA Agent vs. Proactive Review Agent (FUNC-AC-QUALITY clarification)

FUNC-AC-QUALITY currently covers review gates but does not distinguish between two fundamentally different review modes that share the same skillset (code review, security analysis, quality checks) but differ in purpose and trigger:

| | QA Agent (assigned) | Proactive Review Agent (self-directed) |
|---|---|---|
| **Trigger** | Pipeline assigns a specific work product | Scheduled cycle (default: 20 minutes, throttled by signal ratio) |
| **Scope** | Targeted — reviews one PR/implementation | Exploratory — scans broadly across codebase areas |
| **Starting point** | Receives work from the pipeline gate | Finds its own work |
| **Output** | Pass/fail verdict + structured feedback; discovered issues written to GotchaStore | Findings → GitHub issues labeled `review-finding` AND written to GotchaStore for Tech Lead consumption |
| **Feeds into** | Pipeline progression (FUNC-AC-PIPELINE) — work does not merge without sign-off | Tech Lead's signal analysis → proposals |
| **Already exists as** | Review phases in FUNC-AC-QUALITY | ReviewScheduler in the daemon |

**Changes to FUNC-AC-QUALITY:** Add scenarios that explicitly distinguish the two modes:

**Scenario: Assigned QA review**
- Given a work item has completed implementation
- When the pipeline submits it for quality review
- Then the QA agent receives relevant gotchas for the reviewed area (injected from GotchaStore)
- And reviews the specific implementation against its spec, acceptance criteria, and quality standards
- And produces a pass/fail verdict with structured feedback
- And writes discovered issues to GotchaStore

**Scenario: Proactive codebase review**
- Given the proactive review agent's scheduled cycle triggers
- When it scans a codebase area
- Then it identifies issues (bugs, spec drift, security concerns, quality regression) independently of any active work item
- And records findings as GitHub issues labeled `review-finding` AND writes them to GotchaStore
- And the system never dispatches proactive review work through the pipeline gate — the two modes are independent

**Connection to Tech Lead:** The proactive review agent is the Tech Lead's eyes. It generates the `review-finding` issues that appear in the Tech Lead's signal sources. The Tech Lead synthesizes these findings into proposals — the proactive reviewer does not propose remediation itself.

**Work detection boundary:** Issues labeled `review-finding` are explicitly excluded from work detection's executable scan (ready work, feature pipeline). They are signal inputs for the Tech Lead, not work items. A `review-finding` only becomes executable work when the Tech Lead proposes remediation → PO approves → operator approves → a new issue with executable labels is created. This preserves the L0 boundary: the system never acts on self-generated findings without operator approval.

**Connection to pipeline:** The QA agent is a pipeline gate. FUNC-AC-PIPELINE's review phase dispatches to the QA agent. The QA agent's verdict determines whether work progresses to integration or returns to the developer for revision.

### 5. LLM-augmented coordination engine (FUNC-AC-COORDINATION addition)

The coordination engine is a deterministic state machine — it manages ticks, state transitions, deadlock detection, and cadence enforcement. But certain decision points within the state machine benefit from lightweight LLM judgment rather than rigid rules.

**Decision points that use LLM inference:**

| Decision point | Without LLM | With LLM |
|---|---|---|
| Stuck detection | Timer-based: "2 days with no progress = stuck" | Reads work item context and recent activity: "Is it stuck, or just complex?" |
| Retry vs. skip vs. re-plan | Rule-based: "retry once, then skip" | Reads failure reason: "Will a retry help, or is this a fundamental blocker?" |
| Impediment routing | Label-based: route by category | Classifies impediment: "Spec ambiguity → PO, technical blocker → Tech Lead, resource constraint → operator" |
| Batch rebalancing | Static: run batch to completion | Judges whether to pull in more work or let the batch finish based on current velocity |

**What this is NOT:**
- Not a full agent session — no long-running analysis, no proposal generation
- Not a new agent role — the coordination engine remains a state machine
- Not expensive — lightweight inference calls with narrow context (current state + immediate decision context)

**Changes to FUNC-AC-COORDINATION:** Add a section and update the existing "Work item gets stuck" scenario:

> ### LLM-Augmented Decision Points
>
> The coordination engine uses lightweight LLM inference at specific decision junctures where deterministic rules are insufficient. These calls receive narrow context (current work item state, recent activity, failure reason) and return a single routing decision. They do not generate proposals, modify specs, or initiate protocols — they inform the state machine's next transition.

Update the existing "Work item gets stuck" scenario to clarify that the time/budget limit is the trigger, and the LLM-augmented decision point determines the response (retry, skip, or re-plan) rather than a rigid rule.

### 6. L0-AC-VISION update: Wide PO north star

Modify the "Product co-ownership" bullet in the "What the harness provides" section. Current text:

> Product co-ownership — analyzes the codebase and system health to propose features and improvements, always requiring Operator approval before any work begins

Replace with:

> Product co-ownership (evolutionary) —
> - **Phase 1 (Medium PO):** Synthesizes existing signals — spec pipeline gaps, delivery health, backlog staleness, operator ideas — to propose the next most valuable work. Reactive intelligence: sees what exists and what is stuck.
> - **Phase 2 (Wide PO):** Develops domain understanding by reading L0 vision, project history, and operator patterns over time. Proactive intelligence: identifies strategic gaps, proposes new capabilities aligned with project vision, anticipates roadmap direction. Requires elevated operator trust, gated by demonstrated proposal quality.
> - Both phases require Operator approval before any work begins.

**Wide PO boundaries (unchanged from Medium):**
- Never acts without operator approval
- Never writes specs directly
- Never overrides Tech Lead on technical feasibility
- Proposals gain strategic rationale and vision alignment, but the approval flow stays identical

### 7. FUNC-AC-COORDINATION changes

Remove these five scenarios from the Product Ownership section:
1. "Scenario: System proposes a feature"
2. "Scenario: Operator approves a proposal"
3. "Scenario: Operator submits an idea"
4. "Scenario: Proposal expiry"
5. "Scenario: Proposal guardrails"

Replace the entire Product Ownership section with:

> ### Product Ownership
>
> Product ownership behavior — proposal generation, signal analysis, operator idea refinement — is defined in FUNC-AC-PRODUCT-OWNER. Technical health analysis and effort estimation is defined in FUNC-AC-TECH-LEAD. This spec covers the coordination mechanics that both roles participate in: batch planning execution, merge sequencing, concurrency management, and failure recovery.

Add preconditions to these Batch Planning scenarios to route through PO/Tech Lead protocols:

- **"System creates a batch from related work"** — add precondition: "Given the PO and Tech Lead have agreed on a batch through the Batch Planning protocol..."
- **"Independent work dispatches immediately"** — add precondition: "Given the PO has approved the issue for immediate dispatch (either via Backlog Grooming or operator directive)..." The coordination engine does not dispatch work that hasn't been prioritized by the PO.
- **"Higher-priority work arrives"** — rewrite to: "When the PO escalates new work as higher priority through the Escalation protocol, the coordination engine cancels the current batch..." The system does not independently judge priority — the PO does.
- **"Work item gets stuck"** — add: the LLM-augmented decision point determines the response (retry, skip, re-plan) and routes impediments through the Escalation protocol to PO or Tech Lead as appropriate.

Add the LLM-Augmented Decision Points section (see Section 5 above).

All other scenarios in FUNC-AC-COORDINATION stay as-is.

### 8. Self-improvement loop (FUNC-AC-LEARNING connection)

The Retrospective protocol (Protocol 6) generates lessons learned, but the design must explicitly connect those lessons to the institutional learning system (FUNC-AC-LEARNING) to close the feedback loop.

**Retrospective → Learning pipeline:**

1. Retrospective produces lessons learned (structured: what failed, root cause, what to do differently)
2. Tech Lead distills technical lessons into gotchas (artifact-scoped, as per FUNC-AC-LEARNING). PO records business-level lessons (e.g., "this type of spec advancement consistently gets rejected — adjust proposal criteria") as a distinct record type. The knowledge layer must support multiple record types — technical gotchas, business observations, QA verdicts, and review findings — each with its own schema and consumer set. The current GotchaStore handles technical gotchas; business observations and proposal history require either an extended schema or a separate store. This distinction is an L2 architecture decision.
3. GotchaStore deduplicates (Jaccard similarity) and stores with severity + affected area
4. Future sessions receive relevant gotchas via injection at session start (already implemented)
5. Recurring gotchas (same root cause exceeding a configurable threshold, default: 3) trigger a Tech Lead proposal for systemic fix

**Prospective checks at Batch Planning:**

Before committing to a batch, the coordination engine checks whether similar work has failed before:
- Query GotchaStore for gotchas related to the planned work areas
- If high-severity gotchas exist for a planned item, flag it during the Batch Planning protocol
- Tech Lead factors historical failures into effort estimates and risk assessments

**Changes to FUNC-AC-LEARNING:** Add scenarios:

**Scenario: Retrospective feeds institutional knowledge**
- Given the Retrospective protocol produces lessons learned
- When the Tech Lead distills a lesson into a gotcha
- Then the gotcha enters GotchaStore and becomes available for injection into future sessions

**Scenario: Recurring gotcha triggers systemic proposal**
- Given the same root cause appears in gotchas exceeding a configurable threshold (default: 3)
- When the Tech Lead detects the pattern
- Then it generates a technical debt proposal to address the root cause

**Scenario: Prospective gotcha check at batch planning**
- Given the coordination engine is preparing a batch for the Batch Planning protocol
- When it queries GotchaStore for gotchas related to the planned work areas
- Then high-severity gotchas are flagged and included in the Tech Lead's input to Batch Planning
- And the Tech Lead factors historical failures into effort estimates and risk assessments

### 9. Agentic metrics

Each role tracks metrics that measure its effectiveness. These metrics inform the Retrospective protocol and help the operator assess system health.

**PO metrics:**

| Metric | Definition | What it reveals |
|---|---|---|
| Proposal acceptance rate | Approved proposals / total proposals | Whether the PO proposes relevant work |
| Backlog throughput | Items proposed → approved → completed per cycle | Pipeline velocity from idea to delivery |
| Stale item detection latency | Time between item becoming stale and PO flagging it | How quickly the PO notices aging work |
| Spec pipeline coverage | Percentage of L1 specs with complete L2+L3 chain | Whether the PO is advancing the full pipeline |

**Tech Lead metrics:**

| Metric | Definition | What it reveals |
|---|---|---|
| Finding-to-fix rate | Findings that result in completed fixes / total findings | Whether findings translate to action |
| Spec-code drift reduction | Drift items resolved per cycle | Whether the Tech Lead keeps implementation aligned with specs |
| Failure pattern detection speed | Time between first failure and Tech Lead proposal | How quickly the Tech Lead responds to systemic issues |
| Repeat gotcha rate | Gotchas with same root cause / total gotchas | Whether systemic issues are being addressed |
| Dependency risk response time | Time from security advisory to Tech Lead proposal | Whether the Tech Lead responds promptly to supply chain risks |

**Coordination engine metrics:**

| Metric | Definition | What it reveals |
|---|---|---|
| Batch completion rate | Batches completed as planned / total batches | Whether planning is realistic |
| Stuck detection accuracy | Items correctly identified as stuck / total stuck flags | Whether LLM-augmented detection works |
| Re-plan frequency | Batch re-plans per cycle | Whether the system is stable or thrashing |

**QA metrics:**

| Metric | Definition | What it reveals |
|---|---|---|
| False rejection rate | Rejections overturned on re-review / total rejections | Whether QA is too strict |
| Escape rate | Bugs found post-merge / total merged items | Whether QA catches issues before integration |
| Review turnaround | Time from submission to verdict | Whether QA is a bottleneck |

**Proactive Review Agent metrics:**

| Metric | Definition | What it reveals |
|---|---|---|
| Findings per scan cycle | New findings generated per scheduled cycle | Whether the reviewer is productive |
| Finding severity distribution | Breakdown of findings by severity (P0/P1/P2/P3) | Whether the reviewer focuses on high-impact issues |
| False positive rate | Findings dismissed as invalid / total findings | Whether the reviewer generates noise |
| Codebase coverage | Percentage of codebase areas scanned over a rolling window | Whether the reviewer covers the full codebase or gets stuck in one area |

### 10. Memory interaction map

How each role reads from and writes to the knowledge layer (FUNC-AC-LEARNING / GotchaStore):

```
┌──────────────┐     reads: proposal history,        ┌──────────────────┐
│              │     delivery patterns                │                  │
│   PO Agent   │◄────────────────────────────────────│                  │
│              │                                      │                  │
│              │     writes: retrospective lessons    │                  │
│              │     (business-level)                 │                  │
│              │────────────────────────────────────►│                  │
└──────────────┘                                      │                  │
                                                      │   GotchaStore /  │
┌──────────────┐     reads: findings, failure         │   Knowledge      │
│              │     patterns, gotcha trends           │   Layer          │
│  Tech Lead   │◄────────────────────────────────────│                  │
│              │                                      │                  │
│              │     writes: distilled gotchas,       │                  │
│              │     retrospective lessons (technical)│                  │
│              │────────────────────────────────────►│                  │
└──────────────┘                                      │                  │
                                                      │                  │
┌──────────────┐     writes: review findings          │                  │
│  Proactive   │────────────────────────────────────►│                  │
│  Review Agent│                                      │                  │
└──────────────┘                                      │                  │
                                                      │                  │
┌──────────────┐     reads: relevant gotchas          │                  │
│  QA Agent    │◄────────────────────────────────────│                  │
│              │     (injected at review start)       │                  │
│              │                                      │                  │
│              │     writes: review verdicts,         │                  │
│              │     discovered issues                │                  │
│              │────────────────────────────────────►│                  │
└──────────────┘                                      └──────────────────┘
```

**Key flows:**
- Proactive Review Agent → writes findings → Tech Lead reads → proposes remediation
- Retrospective → Tech Lead distills → writes gotchas → future sessions read via injection
- QA Agent reads gotchas for reviewed area → uses them to focus review attention
- PO reads proposal history → avoids re-proposing rejected work, tracks what worked

### 11. Traceability updates

Add to `traceability.yml`:
- FUNC-AC-PRODUCT-OWNER (child of L0-AC-VISION)
- FUNC-AC-TECH-LEAD (child of L0-AC-VISION)

### 12. L2/L3 scope hints

For downstream spec authors:

**L2 (architecture) concerns:**
- Communication mechanism between PO and Tech Lead (shared state store? message queue? orchestrator calls each in sequence?)
- Protocol scheduling (how ticks map to protocol triggers)
- Proposal storage and state management
- Signal aggregation services (how each agent gathers its inputs)
- LLM-augmented decision point integration (how lightweight inference calls fit into the tick loop)
- QA vs. proactive review routing (how the pipeline dispatches to assigned QA vs. scheduled proactive review)
- Knowledge layer record types: technical gotchas, business observations, QA verdicts, review findings — separate schemas or extended GotchaStore (see Section 8 note)
- Memory interaction layer (how agents read/write across record types)
- Metric collection and aggregation architecture — includes ground-truth mechanisms for adjudication metrics (stuck detection accuracy requires operator override records; false rejection rate requires re-review outcomes; false positive rate requires finding dismissal tracking)

**L3 (stack-specific) concerns:**
- Concrete prompt templates for PO and Tech Lead analysis sessions
- Lightweight inference prompts for coordination engine decision points
- Data structures for proposals, enrichments, protocol outputs
- Integration with existing daemon tick loop and coordinator
- Terminal server tool additions or modifications
- Metric collection and storage implementation
- GotchaStore query patterns for prospective checks

## Implementation Order

1. Update L0-AC-VISION with Wide PO phase (establishes the north star both L1 specs reference)
2. Write FUNC-AC-PRODUCT-OWNER L1 spec
3. Write FUNC-AC-TECH-LEAD L1 spec
4. Narrow FUNC-AC-COORDINATION (remove Product Ownership section, add references, add LLM-augmented decision points)
5. Clarify FUNC-AC-QUALITY (add QA vs. proactive review distinction)
6. Connect FUNC-AC-LEARNING (add retrospective → gotcha pipeline scenarios)
7. Update traceability.yml (add FUNC-AC-PRODUCT-OWNER and FUNC-AC-TECH-LEAD to L0-AC-VISION's children list)
8. Define metric collection approach (may be part of L2/L3 for each spec, or a cross-cutting concern)
9. Feature pipeline picks up new/updated specs for L2/L3 generation → implementation

The PO spec is the priority — it unblocks the PO prompt template, which unblocks wiring the coordinator into daemon startup, which unblocks the end-to-end daemon test.
