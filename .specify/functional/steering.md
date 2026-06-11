---
id: FUNC-AC-STEERING
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-STEERING — Intelligent Steering Layer

> **Spec history (v1, 2026-06-11):** Written for the v-next masterplan (decision D9, two-layer model). The existing scheduled product-owner and tech-lead capabilities (FUNC-AC-PRODUCT-OWNER, FUNC-AC-TECH-LEAD; implemented today as the platform's product-owner agent and tech-lead scheduler — `po-agent.ts` and `tech-lead-scheduler.ts` are the migration ancestors) become the first two steering agents, redefined as data under this mechanism. Those specs keep defining *what* each role judges; this spec defines the mechanism by which such roles are declared, scheduled, bounded, and allowed to route work. Which steering agents a deployment runs, on what rhythm, with what budgets, are configuration values illustrated in the non-normative default configuration pack example.

## Problem Statement

The platform's orchestration layer is deliberately deterministic: ready work flows through phases, gates, budgets, and decisions by rules, with no judgment in the machinery itself. That is its strength — and its blind spot. Everything that is not yet *ready work* has no owner: a half-formed idea the Operator jots down, an issue filed without shape, a signal that something deserves investigation. Today these inputs wait for the Operator to notice them, think about them, and hand-shape them into work — which means the scarcest resource in the system spends itself on triage.

What is missing is a thin layer of judgment above the deterministic machinery: standing roles that wake on a rhythm, scan the system's inputs, and use judgment to route fuzzy things into the right structured path — an idea sent to be researched, the findings put before a technical judgment, the shaped result returned to the Operator as a proposal he can approve in one glance. Two such roles already exist in embryonic, hard-coded form (the product-ownership and technical-leadership functions); each new role today means platform code. The roles must instead be **data**: a role's definition — what it is, what it may use, what it knows, how it speaks, what it may spend — declared in configuration, so that adding or reshaping a steering role is an act of configuration, not engineering. And because judgment layered on judgment breeds untraceable behavior, steering agents must leave durable tracks: they speak to each other and to the machinery only through recorded work items and artifacts, never through private side-channels, and they route and propose — they never execute, merge, or start implementation on their own say-so.

## Actors

- **Operator** — declares which steering roles exist and their definitions, submits raw ideas, receives shaped proposals in the inbox, and remains the only one on whose word implementation work begins
- **Steering Agent** — a standing role (such as a product-ownership, technical-leadership, or program-management function) defined entirely as data; wakes on its rhythm, scans its inputs, and routes fuzzy work into structured paths within its budget
- **Control Plane** — schedules each steering agent's rhythm, enforces its definition and budget, carries everything steering agents produce as recorded work items and artifacts, and runs the structured workflows that steering agents dispatch into

## Behavior

### Roles as data

**Scenario: A steering role is declared, not coded**
- Given the Operator wants a standing steering role
- When they declare it in configuration as a complete bundle — the role's charter and instructions, the capabilities and reference knowledge it may use, the voice and disposition it speaks with, the rhythm it wakes on, and the budget each waking may spend
- Then the role exists and operates from that declaration alone, and no change to the platform itself is required

**Scenario: Changing a role is an edit to its declaration**
- Given a steering role is running from its declaration
- When the Operator edits the declaration — tightening its charter, changing its rhythm, adjusting its budget
- Then the role's next waking operates under the edited declaration, and the change is recorded with what changed and when

**Scenario: Every waking is attributable to a declared version**
- Given a steering agent acted
- When its actions are examined later
- Then the record shows which version of its declaration it was operating under at the time

### The heartbeat

**Scenario: A steering agent wakes on its rhythm**
- Given a steering role's declaration states its waking rhythm
- When the rhythm comes due
- Then the agent wakes, scans its declared inputs, acts within its budget, and goes back to sleep — leaving a record of what it scanned, what it concluded, and what it routed

**Scenario: A waking is bounded by its budget**
- Given a steering agent's waking has a declared budget
- When the work of that waking approaches the budget
- Then the agent concludes with what it has rather than overspending, and an over-budget need becomes a recorded item for a later waking or a decision for the Operator — never silent overspend

**Scenario: Inputs are scanned, not polled by the Operator**
- Given the deployment's inputs accumulate — newly filed work items, items in the Operator's inbox awaiting shaping, raw ideas the Operator has submitted
- When a steering agent whose charter covers those inputs wakes
- Then it reads what is new since its last waking and triages it, so that no input waits for the Operator to notice it before anything happens

### Judgment-based dispatch

**Scenario: A fuzzy input is routed into a structured path**
- Given an input that is not yet ready work — an unshaped idea, an unclear issue, a signal worth investigating
- When a steering agent judges what it needs
- Then it dispatches the input into an appropriate configured workflow — for example: an idea sent to a research task, the research result put before the technical-leadership role for a consult, and the shaped outcome returned to the Operator's inbox as a self-contained proposal — and each hop is a recorded item

**Scenario: Steering routes, the machinery executes**
- Given a steering agent has dispatched work into a structured workflow
- When that workflow runs
- Then it runs under the deterministic layer's ordinary rules — its phases, gates, budgets, and decisions — exactly as if the Operator had dispatched it; steering confers no exemption from any rule

**Scenario: Shaped proposals return to the Operator**
- Given a steering path has produced a shaped outcome — a proposal, a recommendation, a researched answer
- When it is ready
- Then it lands in the Operator's inbox as a self-contained item he can approve, decline, or redirect, and implementation begins only on his recorded word

**Scenario: Steering agents consult each other through artifacts**
- Given one steering agent wants another's judgment
- When it asks
- Then the question and the answer travel as recorded work items or artifacts that either agent — and the Operator — can later read, and the exchange is part of the durable record

## Success Criteria

- A new steering role is added, reshaped, or retired purely by editing declarations; the platform itself never changes, and every waking is attributable to the declaration version it ran under
- Raw inputs — ideas, unshaped issues, signals — are triaged by the steering layer within their owning agent's rhythm, instead of waiting for the Operator to notice them; the Operator receives shaped, decidable proposals rather than raw material
- No steering agent ever starts implementation, merges, deploys, alters a pipeline phase, or edits a specification or the vision on its own judgment; everything it routes runs under the deterministic layer's full ordinary rules
- Every steering action — scan, conclusion, dispatch, consult, proposal — exists as a recorded item or artifact; the chain from raw input to shaped proposal can be reconstructed end to end with no invisible hops
- No waking exceeds its declared budget; over-budget needs surface as recorded items or decisions, never as silent overspend

## Constraints

- A steering role is **defined entirely as data** — charter, capabilities, knowledge, voice, rhythm, budget — and the platform runs it from that declaration; no steering role's identity or behavior is fixed in platform code
- Steering agents are **coordinators in the L0 sense**: they create, shape, route, and propose; they never merge, never deploy, never alter a pipeline phase, never edit specifications or the vision, and never start implementation work without the Operator's recorded approval — all work still begins on the human's word
- **All communication is artifact-mediated**: steering agents exchange judgment with each other and with the machinery exclusively through recorded work items and artifacts; direct agent-to-agent messaging outside the durable record is excluded by design and is not configurable
- Whatever a steering agent dispatches runs under the **deterministic layer's unmodified rules** — gates, budgets, scope verification, compliance, decisions; the steering layer can add work into the system but can never relax how the system treats work
- Each waking is **budget-bounded** by declaration, and steering spend is recorded and attributed like any other spend
- Steering judgments are advisory until a human or a configured rule acts on them; a steering agent's confidence, however high, is never itself an approval
- The steering layer must degrade gracefully: a steering agent that fails, overruns, or produces nothing leaves the deterministic layer fully operational — steering is above the machinery, never load-bearing inside it
