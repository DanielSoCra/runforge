> **⛔ SUPERSEDED (2026-06-02).** This design doc's still-valid content has been folded into the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. Retained for history; the canonical specs in `.specify/` govern — do not act on it as a live instruction. See the Spec Reconciliation Ledger (`docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). <!-- RECONCILIATION-LEDGER-BANNER -->

# Claude-Skills Pattern Adoption Backlog

**Date:** 2026-03-22
**Status:** Approved
**Related:** 2026-03-22-spec-driven-pipeline-design.md
**Source:** Analysis of [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) (205 skills, v2.1.2)
**Goal:** Capture adoptable patterns from the claude-skills repository as structured backlog items for auto-claude's Phase 1/2/3 evolution.

## Context

A comprehensive review of the claude-skills repository identified 16 HIGH-value and 18 MEDIUM-value skills across 205 total. The most impactful patterns come from 5 skills studied in depth:

| Skill | Key Pattern | Target Component |
|-------|-------------|------------------|
| **autoresearch-agent** | Retry-with-escalation, evaluator immutability, circuit breakers | Control Plane, Session Runtime |
| **agenthub** | Tournament execution via worktrees, hybrid evaluation, append-only message board | Session Runtime, Validation Service |
| **self-improving-agent** | 3-tier memory with scoring/promotion, staleness detection, error capture hooks | Knowledge Service |
| **pr-review-expert** | 30-item structured review checklist, blast radius classification, 4-tier findings | Validation Service |
| **agent-workflow-designer** | Handoff contracts, workflow pattern selection, budget/timeout enforcement | Control Plane |

## Design Decisions

1. **Phase 2/3 issues, not Phase 1 spec modifications.** Phase 1 validates the workflow; these patterns require the native control plane.
2. **Grouped by auto-claude component.** Each issue maps to one L1 spec owner and one L2 architecture spec, keeping work coherent.
3. **One Phase 1 exception.** Lightweight prompt-level improvements (evaluator immutability rule, structured review checklist) go into a separate Phase 1 issue since they require no architectural changes.

## Backlog Issues

### Issue 1: Phase 1 — Skill prompt hardening from claude-skills patterns

**Labels:** `feature-pipeline`, `phase-1`
**L1 ref:** FUNC-AC-QUALITY, FUNC-AC-LEARNING
**Scope:** Prompt-level improvements only, no architectural changes

**Acceptance criteria:**
- `spec-implement` skill prompt includes evaluator immutability rule: "Never weaken, delete, or bypass existing tests to force a pass. New tests and spec-justified test updates are expected. Tests are ground truth."
- `spec-implement` skill prompt includes the pr-review-expert's structured review checklist (30 items across 7 categories: scope, blast radius, security, testing, breaking changes, performance, code quality)
- `spec-implement` review output uses 4-tier finding format: MUST FIX (blocking) / SHOULD FIX / SUGGESTIONS / LOOKS GOOD

**Inspiration:** pr-review-expert, autoresearch-agent

---

### Issue 2: Phase 2 — Control Plane: Retry-with-escalation and handoff contracts

**Labels:** `feature-pipeline`, `phase-2`
**L1 ref:** FUNC-AC-PIPELINE, FUNC-AC-IMPLEMENTATION
**L2 ref:** ARCH-AC-CONTROL-PLANE

**Acceptance criteria:**
- Implementation phase supports retry attempts with escalating strategy tiers: minimal-fix (attempts 1-2) → systematic (attempts 3-4) → structural (attempt 5). Max 5 attempts total
- Each retry includes previous failure reasons in the Claude session prompt
- Circuit breaker: 5 consecutive crashes = transition to `stuck` + notify operator
- Plateau detection: if no improvement in gate pass rate across 2 consecutive retries at the same tier, escalate to next tier
- FSM phase transitions carry structured handoff contracts: `workflow_id`, `step_id`, `upstream_artifacts`, `decisions`, `open_questions`, `budget_remaining`, `timeout_seconds`
- Previous attempt outcomes stored in RunState for cross-retry learning

**Inspiration:** autoresearch-agent strategy escalation, agent-workflow-designer handoff contracts

**Note:** agent-workflow-designer's "workflow pattern selection" and "budget/timeout enforcement" patterns are not adopted here — auto-claude already covers these via pipeline variants in ARCH-AC-CONTROL-PLANE and cost tracking in ARCH-AC-SESSION-RUNTIME.

---

### Issue 3: Phase 2 — Session Runtime: Worktree isolation and tournament execution

**Labels:** `feature-pipeline`, `phase-2`
**L1 ref:** FUNC-AC-IMPLEMENTATION, FUNC-AC-QUALITY
**L2 ref:** ARCH-AC-SESSION-RUNTIME

**Acceptance criteria:**
- Each implementation session runs in its own isolated workspace provisioned by the WorkspacePool (per ARCH-AC-SESSION-RUNTIME), with branch naming `feature/{issueNumber}/agent-{N}/attempt-{M}`
- For complex-classified issues, spawn 2-3 parallel agents with different implementation strategies
- Agents work in shared-nothing isolation — no access to each other's work
- Results evaluated via hybrid scoring: 70% metric (test pass rate, coverage delta) / 30% LLM judge (diff quality review)
- Winner merged with `--no-ff`; losers archived as tags for post-mortem learning
- Workspace cleanup protocol: remove after merge/archive, detect and clean orphans
- All-agents-fail handling: archive session, transition to `stuck`, notify operator with failure summary
- Tie-breaking: prefer simpler diff (fewer lines changed); if still tied, LLM judge decides
- Tournament timeout: max wall-clock time per tournament round (configurable, default 30min per agent)
- Parallel implementation sessions use separate workspaces; integration merge to `dev` remains serialized via lock

**Inspiration:** agenthub tournament execution, git-worktree-manager isolation

**Note:** If the WorkspacePool model in ARCH-AC-SESSION-RUNTIME needs amendment to support the tournament pattern efficiently (e.g., lightweight worktree-based pools vs full clones), this should be routed as an `l2-suggestion` during implementation.

---

### Issue 4: Phase 2 — Validation Service: Structured gates with metric tracking

**Labels:** `feature-pipeline`, `phase-2`
**L1 ref:** FUNC-AC-QUALITY
**L2 ref:** ARCH-AC-VALIDATION

**Acceptance criteria:**
- `GateResult` extended with optional scalar metric: `{ name, value, direction, baseline? }`
- Gates track improvement across retry attempts, not just pass/fail
- Blast radius classification (CRITICAL/HIGH/MEDIUM/LOW) scales review checklist depth — all paths run baseline gates (Gate 1+2 per ARCH-AC-VALIDATION), but CRITICAL paths get full checklist rubric and LOW paths get abbreviated rubric
- Security scan patterns implemented as automated Gate 1 checks (SQL injection, hardcoded secrets, XSS, auth bypass, eval/exec, path traversal)
- Test coverage delta enforced: new function without tests = flag, coverage drop >5% = block, auth/payment paths = require 100%
- Review findings use the 4-tier format from Issue 1 (MUST FIX / SHOULD FIX / SUGGESTIONS / LOOKS GOOD), encoded as structured data in `GateResult.findings`

**Inspiration:** pr-review-expert checklist, autoresearch-agent metric tracking

**Dependency:** Issue 4 must be implemented before Issue 2 (retry-with-escalation depends on metric tracking for plateau detection).

---

### Issue 5: Phase 2 — Knowledge Service: Gotcha scoring, staleness, and capacity management

**Labels:** `feature-pipeline`, `phase-2`
**L1 ref:** FUNC-AC-LEARNING
**L2 ref:** ARCH-AC-KNOWLEDGE

**Acceptance criteria:**
- Gotcha entries scored on 3 dimensions: durability (0-3), impact (0-3), scope (0-3). Promotion requires total ≥ 6 AND proven (2+ sessions) AND actionable AND durable (valid 30+ days)
- Staleness detection: validate artifact patterns against filesystem, flag entries referencing deleted files
- Two-layer memory: raw gotcha capture (Layer 1) vs curated/promoted knowledge (Layer 2). Only Layer 2 injected by default. `DO_NOT_RESURFACE` markers for resolved issues
- Capacity management: max 10 gotchas injected per session, max 500 tokens of gotcha context, sorted by priority then hit count
- Distillation on promotion: descriptive → prescriptive transformation ("I noticed X" → "Always do X")
- Health dashboard endpoint: total/active/promoted/stale counts, capacity status (healthy/warning/critical)
- Error pattern detection in session output beyond explicit `<!-- PITFALL: -->` markers (30+ error patterns)
- Fuzzy deduplication via Jaccard similarity (>70% word overlap = duplicate)

**Inspiration:** self-improving-agent 3-tier memory, decision-logger two-layer architecture

---

### Issue 6: Phase 2 — Control Plane: Append-only audit board for inter-phase communication

**Labels:** `feature-pipeline`, `phase-2`
**L1 ref:** FUNC-AC-PIPELINE, FUNC-AC-IMPLEMENTATION
**L2 ref:** ARCH-AC-CONTROL-PLANE

**Acceptance criteria:**
- Replace mutable RunState passing with append-only board posts: `{ sequence, author, channel, timestamp, parent, body }`
- Three channels: `dispatch` (coordinator → agents), `progress` (agents → coordinator), `results` (bidirectional)
- Posts stored as `{stateDir}/board/{channel}/{seq}-{author}-{timestamp}.json`
- Threading via `parent` field for conversation-style debugging
- RunState still exists as a computed view over the board (derived, not primary)
- Crash recovery: RunState can be reconstructed from the board via sequential replay; periodic snapshot checkpoints for runs exceeding 100 posts
- Board is durable audit trail for bug diagnosis — every phase transition, decision, and artifact is traceable
- Immutable: no edits, no deletes, append-only with supersede semantics

**Inspiration:** agenthub message board protocol, decision-logger append-only architecture

**Ordering note:** Issue 6 should be implemented before Issue 2 (retry-with-escalation), so retry/handoff data is designed as board-native posts rather than RunState extensions that later need migration.

---

### Issue 7: Phase 3 — Dashboard: Multi-dimensional health scoring and run analytics

**Labels:** `feature-pipeline`, `phase-3`
**L1 ref:** FUNC-AC-DASHBOARD
**L2 ref:** ARCH-AC-DASHBOARD

**Acceptance criteria:**
- Run health scoring across weighted dimensions: spec adherence (25%), test pass rate (25%), cost efficiency (20%), review pass rate (20%), cycle time (10%)
- RAG thresholds per dimension (green/yellow/red with concrete cutoff values)
- Retry attempt visualization: show metric progression across attempts within a run
- Tournament results view: compare parallel agent outputs side-by-side with diff stats and metric deltas
- Knowledge service health panel: gotcha counts, promotion candidates, stale entries, capacity status
- DORA-style pipeline metrics: deployment frequency, change failure rate, MTTR, lead time from issue to merge

**Inspiration:** senior-pm portfolio health dashboard, agenthub evaluation display, self-improving-agent health scoring

## Phase Assignment Rationale

| Phase | Issues | Why |
|-------|--------|-----|
| Phase 1 | #1 (prompt hardening) | Prompt-level only — no code architecture changes needed |
| Phase 2 | #2-6 (control plane, session runtime, validation, knowledge, audit board) | Require native Node.js control plane, FSM, and session runtime |
| Phase 3 | #7 (dashboard analytics) | Depends on Phase 2 infrastructure being operational |

### Phase 2 Implementation Order

Issues within Phase 2 have ordering dependencies:

1. **Issue 6** (audit board) — foundational; retry and handoff data should be board-native
2. **Issue 4** (validation gates with metrics) — required by retry plateau detection
3. **Issue 2** (retry-with-escalation) — depends on Issues 4 and 6
4. **Issue 5** (knowledge service) — independent, can run in parallel with 4/6
5. **Issue 3** (tournament execution) — depends on Issue 4 (hybrid evaluation uses gate metrics)

## Relationship to Existing Specs

These issues extend existing L1 specs — they do not create new functional areas. Each issue references its governing L1 and L2 specs. The pipeline will generate L3 specs and implement code through the normal L1→L2→L3→implement flow.

The patterns adopted here are informed by external prior art (claude-skills repository) but implemented within auto-claude's own spec-driven architecture. No external code is imported — only design patterns and acceptance criteria.
