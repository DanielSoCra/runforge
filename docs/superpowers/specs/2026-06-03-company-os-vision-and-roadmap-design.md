---
date: 2026-06-03
status: north-star-input
authority: NOT execution-canonical — docs/superpowers/specs/2026-06-11-runforge-vnext-masterplan-design.md (masterplan v2.1) is the sole execution-canonical roadmap
decision: Operator decision 2026-06-11 (sparring-hardened cleanup slate, card 5)
---

# Company OS ("Mission Control") — Vision, Architecture & Roadmap

> **⚠️ NORTH-STAR INPUT — NOT EXECUTION-CANONICAL (2026-06-11).** Masterplan v2.1 is the **sole execution-canonical roadmap**; do not generate work from this document. Reconciliation: Company-OS **Phase 0 ≈ masterplan v2.1 P0–P4**; **§§6–7 are stale/landed** (the listed PRs and blockers were resolved); the **shell / multiplayer / multi-tenant** ambitions (§§3, 5 Phase 1–3) are **deferred horizon inputs**, preserved here, re-elevated only by Operator decision. Kill-condition on this marker: if a steering agent still produces out-of-sequence shell work, escalate to full supersession.

Date: 2026-06-03 · Status: ~~design approved (brainstorm) → entering implementation~~ **north-star input (see banner)**
Visual overview: `pm-cockpit/docs/integration/2026-06-03-company-os-vision-overview.html`
Cockpit prototype: `pm-cockpit/docs/integration/2026-06-03-cockpit-redesign-prototype.html`

## 1. Context & problem
Six overlapping projects (runforge, pm-cockpit, product, local-product, plus OSS side-project & Archon) are secretly **one system sliced differently** — each reinvents agents/roles, goals, workflows, gates, specs. Months of work, no convergence. This spec converges them into **one product** and a phased roadmap, starting with a sharp first wedge.

Existing reality to reconcile: the Operator already runs a **side-project "Dental-PVS" company for the billing/ops side** (team CEO+CPO+Engineer; roadmap CLA-10, board-approved; engine M0–M4 done, only live KZV send missing). The company OS must *integrate with / grow from* that, not ignore it (see §8 integration point).

## 2. Decisions (locked in the brainstorm)
| # | Decision | Choice |
|---|---|---|
| Shape | What is it? | **(a) Autonomous COMPANY OS** — CEO over multiple orgs, agents across all functions |
| Depth | The crown jewel | **Software development at runforge's L0→L3 depth** — a first-class deep department, NOT a generic "agent does a task" |
| Wedge | First proof | **Depth-first on acme** (the hardest real case) |
| Multiplayer | Who's in the room | **(b) Humans + agents, first-class** — assign/claim, @-mention, threads, presence |
| Reach | Owner | **Internal-first, sellable eventually** → multi-tenant + polish baked in |
| Spine | Foundation | **(a) Own it — copy side-project's shape, add product + runforge** |
| Dropped | ~~PHI/PII~~ | **Out of scope** — customer data lives on customers' own servers; runforge never touches it |

## 3. Architecture — the backbone
**Org → Department → Goal → Work.**
- **Org** = tenant (acme, ava, agency) with an **org chart** of **Departments** (teams of agent roles + humans).
- **Goal** = the steering primitive a human sets (multiple, concurrent, prioritized).
- **Work** = the unit a department executes. **The unifying trick:** for **engineering**, a Work item *is* the full runforge L0→L3 pipeline (gates + deterministic resume). For other departments, a Work item is a lighter **workflow** (product recipes / Archon). Same abstraction, variable depth → SWE depth stays first-class; others stay light.
- **Gates** surface to the **shared room** (the cockpit) → humans/agents decide → Work resumes.

### Convergence map (every project → a layer)
- **runforge** → the engineering engine (keep, widen).
- **pm-cockpit** → the shared-room cockpit / front-end (keep).
- **product** → the ops + workflow layer for non-eng departments (keep).
- **local-product** → the goal-loop / goals primitive (keep).
- **side-project** → the shell we copy & own: multi-org/tenant, org chart, agents-as-employees, approvals, adapters, multiplayer auth, embedded Postgres.
- **Archon** → workflow engine + knowledge/memory + MCP patterns (borrow).

### Steering model (control loop)
`set goal(s) → prioritize/arbitrate → route to department(s) → spawn Work (eng = pipeline, others = workflow) → hit a gate → surface to the shared room → human/agent answers → Work resumes → progress rolls up to the goal → CEO sees company state.`
*(GPT-5.5 xhigh is producing a deeper steering analysis; its conclusions get folded into this section before Phase-1 design.)*

### Multiplayer
Identity + per-org tenancy from day one. Decisions assignable/claimable; @-mention humans or agents; threads per decision/run; presence. v1 = real-time-light (instant updates + presence dots); full live later.

## 4. Testing-first strategy (non-negotiable, per the directive)
**Every slice ships with automated tests + smoketests. No exceptions. Do not save effort here.**
- **Unit** — TDD via `/sparring-driven-development` (implementer ≠ tester; adversarial verification).
- **Integration** — real components (real index/socket/daemon), not mocks, at boundaries.
- **E2E** — the engine: a real pipeline run L0→L3→merged on a throwaway repo, asserted via `gh` + daemon logs. The UI: Playwright browser harness over `next start` (real build).
- **Smoke** — a one-command "is the whole loop alive?" check per surface (daemon boot+health+clone; cockpit login+inbox+answer→resume; goal→work→gate).
- **Adversarial review** — `/deep-review` between merges; workflows fan-out independent verifiers.
- **CI gates** — typecheck → lint → unit/integration → e2e/smoke on the self-hosted runners.
Acceptance for every slice includes its tests being green in CI + a documented smoke command.

## 5. Roadmap (phases)
- **Phase 0 — the wedge (prove the depth):** engineering department, on acme, autonomously ships real features end-to-end, steered by goals, gated through the v2 cockpit, multiplayer-light. ≈ what we HAVE + cockpit redesign + the goal primitive + reliability.
- **Phase 1 — the shell:** the side-project-shaped spine (Orgs/Departments/org-chart/tenancy/identity/multiplayer); engineering = the first deep department.
- **Phase 2 — widen:** non-eng departments via the product workflow layer; onboard ava + the agency; multi-goal steering.
- **Phase 3 — sellable:** multi-tenant polish, onboarding, packaging.

## 6. Phase 0 decomposition (sub-projects / slices) — each gets its own spec → plan → build
- **Slice 1 — Reliable end-to-end engine** *(this cycle)*: the daemon ships a feature **L0→L3→merged** on a real repo, reliably, fully tested. Prereq: **consolidate** the validated, unmerged work (PRs #709 workspace, #710 gate1, #711 l2-designer paths, pm-cockpit#7 answerable inbox) via `/deep-review` + merge. Fix the live blocker **#49 (approved l2-gate re-parks / duplicate handler livelock)**. Make the gap-8 git-credentials fix permanent (#43). E2E + smoke for the full loop.
- **Slice 2 — The goal primitive:** "set a goal → it creates the L0/L1 + the work item → the pipeline runs." Generalize the local-product goal-loop.
- **Slice 3 — The cockpit v2 (real):** implement the approved prototype into pm-cockpit via `/frontend-design`, wired to live data (`/api/runs/live` + the index), Playwright-tested.
- **Slice 4 — Multiplayer-light:** identity, assignment/claim, threads, presence.
- **Slice 5 — Wire to acme + full e2e/smoke + reconcile with the side-project-Dental-PVS company.**

## 7. Slice 1 — detailed scope & acceptance (this cycle)
**Goal:** prove the engineering department is *trustworthy and autonomous end-to-end*, on a real repo, with automated proof.

Scope:
1. **Consolidate:** `/deep-review` then merge #709, #710, #711, pm-cockpit#7 (resolve conflicts). One green main per repo.
2. **Fix #49 (livelock):** an approved `l2-gate` must advance (l2-approved → l3-generate → … → merged), not re-park; remove the duplicate handler/double-resume. SDD: failing test that reproduces the re-park, then the fix.
3. **Complete the pipeline past the gate:** l3-generate → l3-compliance → implement → review → integrate on the example repo, ending in a merged PR (push/credentials must work in-container — fold gap-8 #43 into the daemon boot).
4. **Tests:** unit (the resume/gate state machine), integration (driver→GitHub effect→resume), **e2e** (a real run L0→L3→merged on `runforge-example`, asserted), **smoke** (`pnpm smoke:engine` = boot daemon → seed an L1 issue → drive to merged → assert).

Acceptance:
- A single command takes a fresh L1 issue to a merged PR autonomously, and the operator can approve the l2-gate from the cockpit and watch it complete.
- All four test layers green in CI; the smoke command documented.
- #49 closed; #41/#43 closed; PRs merged.

## 8. Open items / integration points
- **GPT-5.5 steering pass** → fold into §3 before Phase 1.
- **Reconcile with the existing side-project-Dental-PVS company** (ops/billing already runs there): is Phase 1's shell a fork we own, or do we extend the running side-project and own it later? Decide before Phase 1.
- First 2–3 human teammates (for multiplayer seeding).
- Goal-arbitration rules across orgs/departments.
- Pipeline view-switcher (board / swimlane / timeline) — small UI follow-up in Slice 3.

## 9. Method
Workflows for fan-out (research, multi-dimension review, parallel verification). `/deep-research` for unknowns. `/sparring-driven-development` for every code change. `/deep-review` between merges. `/frontend-design` for UI. Tests + smoke everywhere. No token/effort budget — correctness and end-to-end proof are the goal.
