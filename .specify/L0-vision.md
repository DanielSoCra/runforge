---
id: L0-AC-VISION
type: vision
domain: auto-claude
status: draft
version: 1
layer: 0
---

# L0-AC-VISION — Auto-Claude

**Auto-Claude** is an agent harness that turns a reasoning engine into a reliable, autonomous spec implementer.

**Why:** A language model can reason about code, but it cannot — on its own — run tests, enforce budgets, isolate workspaces, review its own output independently, or learn from past mistakes. The harness provides all of that. Without it, the model is a copilot that needs constant supervision. With it, the model becomes a worker that operates unattended overnight.

**For:** An Operator who writes specifications and creates work requests. The Operator defines what gets built. The harness executes. The Operator reviews results and approves production releases. The system earns the Operator's trust through a warmup period before gaining autonomy.

**What the harness provides:**
- **Orchestration** — detects work, classifies complexity, decomposes into parallel units, drives an FSM pipeline through implementation, review, integration, and deployment; coordinates batches of concurrent work across repositories with dependency-aware merge ordering
- **Containment** — isolated environments, structural access controls, cost circuit breakers, credential isolation from intelligent sessions
- **Quality gates** — independent heterogeneous review (not self-certification), holdout validation with scenarios the agent never sees, static analysis enforcement
- **Learning** — captures pitfalls, injects them into future sessions, promotes recurring patterns to permanent documentation, proposes instruction improvements — all with Operator approval
- **Product co-ownership** — analyzes the codebase and system health to propose features and improvements, always requiring Operator approval before any work begins

**What the model provides:** Reasoning within the boundaries the harness sets — decomposition, implementation, code review, conflict resolution, bug diagnosis.

**Boundaries:**
- Never deploys to production without Operator approval
- Never acts on self-generated proposals without Operator approval
- Never writes or modifies specifications
- Never modifies its own implementation or evaluation criteria
- All permanent knowledge changes require Operator approval

**Success:** The Operator creates an Issue before bed and wakes up to a working, reviewed implementation on a dev URL — with confidence that cost, safety, and quality were maintained overnight.
