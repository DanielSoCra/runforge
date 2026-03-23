# Design: PO and Tech Lead Agent Roles

**Date:** 2026-03-23
**Status:** Draft
**Scope:** L1 spec changes to define Product Owner and Tech Lead agents, update L0 vision for Wide PO north star, narrow FUNC-AC-COORDINATION

## Definitions

- **Medium PO** — Phase 1 of the Product Owner capability. Synthesizes existing signals (spec pipeline gaps, delivery health, backlog staleness, operator ideas) to propose the next most valuable work. Reactive intelligence: sees what exists and what is stuck.
- **Wide PO** — Phase 2 (future). Develops domain understanding from L0 vision and project history to proactively identify strategic gaps. Captured in L0 as a north star, not an implementation target.

## Problem

The auto-claude system can execute work but cannot decide what to work on next. Work detection finds labeled issues, but nobody creates those issues proactively. The coordination spec (FUNC-AC-COORDINATION) lumps product ownership, technical health, and coordination mechanics into one spec — blurring responsibilities and leaving agent behavior underspecified.

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

**Proposal lifecycle:** Same as PO: generated → pending → approved (creates GitHub issue) | rejected (archived) | expired (default: 7 days). The PO may reject a Tech Lead proposal before it reaches the operator if business priority does not justify it; the PO records the rejection reason, and the Tech Lead may re-propose with stronger evidence.

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

**Decision authority:** The initiating agent owns whether to propose. The enriching agent's assessment is advisory but always attached to proposals that reach the operator.

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

### 4. L0-AC-VISION update: Wide PO north star

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

### 5. FUNC-AC-COORDINATION changes

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

Add a precondition to the Batch Planning scenarios: "Given the PO and Tech Lead have agreed on a batch through the Batch Planning protocol (see FUNC-AC-PRODUCT-OWNER, FUNC-AC-TECH-LEAD)..."

Everything else in FUNC-AC-COORDINATION stays as-is.

### 6. Traceability updates

Add to `traceability.yml`:
- FUNC-AC-PRODUCT-OWNER (child of L0-AC-VISION)
- FUNC-AC-TECH-LEAD (child of L0-AC-VISION)

### 7. L2/L3 scope hints

For downstream spec authors:

**L2 (architecture) concerns:**
- Communication mechanism between PO and Tech Lead (shared state store? message queue? orchestrator calls each in sequence?)
- Protocol scheduling (how ticks map to protocol triggers)
- Proposal storage and state management
- Signal aggregation services (how each agent gathers its inputs)

**L3 (stack-specific) concerns:**
- Concrete prompt templates for PO and Tech Lead analysis sessions
- Data structures for proposals, enrichments, protocol outputs
- Integration with existing daemon tick loop and coordinator
- Terminal server tool additions or modifications

## Implementation Order

1. Update L0-AC-VISION with Wide PO phase (establishes the north star both L1 specs reference)
2. Write FUNC-AC-PRODUCT-OWNER L1 spec
3. Write FUNC-AC-TECH-LEAD L1 spec
4. Narrow FUNC-AC-COORDINATION (remove Product Ownership section, add references)
5. Update traceability.yml
6. Feature pipeline picks up new specs for L2/L3 generation → implementation

The PO spec is the priority — it unblocks the PO prompt template, which unblocks wiring the coordinator into daemon startup, which unblocks the end-to-end daemon test.
