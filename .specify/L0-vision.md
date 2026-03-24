---
id: L0-AC-VISION
type: vision
domain: auto-claude
status: draft
version: 4
layer: 0
---

# L0-AC-VISION — Auto-Claude

**Auto-Claude** is an agent harness that turns a reasoning engine into a reliable, autonomous spec implementer.

**Why:** A language model can reason about code, but it cannot — on its own — run tests, enforce budgets, isolate workspaces, review its own output independently, or learn from past mistakes. The harness provides all of that. Without it, the model is a copilot that needs constant supervision. With it, the model becomes a worker that operates unattended overnight.

**For:** An Operator who writes specifications, creates work requests, and collaborates with agents through interactive sessions when decisions require discussion. The Operator defines what gets built. The harness executes. The Operator reviews results and approves production releases. The system earns the Operator's trust through a warmup period before gaining autonomy.

**What the harness provides:**
- **Orchestration** — detects work, classifies complexity, decomposes into parallel units, drives an FSM pipeline through implementation, review, integration, and deployment; coordinates batches of concurrent work across repositories with dependency-aware merge ordering
- **Containment** — isolated environments, structural access controls, cost circuit breakers, credential isolation from intelligent sessions
- **Quality gates** — independent heterogeneous review (not self-certification), holdout validation with scenarios the agent never sees, static analysis enforcement
- **Technical leadership** — monitors code health, detects spec-code drift, identifies failure patterns and dependency risks, proposes technical improvements — always flowing through product ownership for priority assessment before reaching the Operator
- **Learning** — captures pitfalls, injects them into future sessions, promotes recurring patterns to permanent documentation, proposes instruction improvements — all with Operator approval
- **Interactive sessions** — any agent that operates autonomously in the daemon is also available as an interactive collaborator. The Operator can open a conversation with the PO to discuss priorities, with the Tech Lead to explore technical decisions, or with any other agent. The agent brings its current state (proposals, findings, health signals) into the conversation and can execute decisions on the spot. Same agent identity, same tools, same shared state — just a different execution mode.
- **Product co-ownership** (evolutionary) —
  - **Phase 1 (Medium PO):** Synthesizes existing signals — spec pipeline gaps, delivery health, backlog staleness, operator ideas — to propose the next most valuable work. Reactive intelligence: sees what exists and what is stuck.
  - **Phase 2 (Wide PO):** Develops domain understanding by reading L0 vision, project history, and operator patterns over time. Proactive intelligence: identifies strategic gaps, proposes new capabilities aligned with project vision, anticipates roadmap direction. Requires elevated operator trust, gated by demonstrated proposal quality.
  - Both phases require Operator approval before any work begins.

**What the model provides:** Reasoning within the boundaries the harness sets — decomposition, implementation, code review, conflict resolution, bug diagnosis.

**Boundaries:**
- Never deploys to production without Operator approval
- Never acts on self-generated proposals without Operator approval
- Never writes or modifies specifications
- Never modifies its own implementation or evaluation criteria
- All permanent knowledge changes require Operator approval

**Success:** The Operator creates an Issue before bed and wakes up to a working, reviewed implementation on a dev URL — with confidence that cost, safety, and quality were maintained overnight.
