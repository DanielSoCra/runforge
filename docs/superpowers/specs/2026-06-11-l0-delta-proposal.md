---
date: 2026-06-11
status: PROPOSAL — AWAITING OPERATOR DECISION
type: l0-delta-proposal
topic: Three proposed amendments to L0-AC-VISION (v5 → v6)
authors: Claude (spec-chain goal run), per masterplan v2.1 §2.1
reads_down_from:
  - .specify/L0-ac-vision.md  # v5, Operator-approved — NOT edited by this proposal
related:
  - docs/superpowers/specs/2026-06-11-auto-claude-vnext-masterplan-design.md  # D5, D9–D11, §2.2
---

# ⚠️ L0 Delta Proposal — Operator Decision Required

> **This document edits nothing.** L0 is Operator-owned; per the platform's own boundaries the vision is never authored or edited autonomously. This is a *proposal* of exactly three deltas to `L0-AC-VISION` v5, surfaced for the Operator's decision per masterplan v2.1 §2.1. Accepting, reshaping, or rejecting any of the three blocks nothing else in the v-next spec chain: the L1 specs written alongside this proposal are consistent with v5 as it stands, and these deltas only *name in the vision* what those specs already keep within v5's boundaries.

## How to act on this

For each delta: **accept** (the wording below, or your own), **amend**, or **reject**. On acceptance, L0-AC-VISION goes to version 6 with the chosen wording — edited by you or by a run you explicitly direct, never silently.

---

## Delta A — The platform thesis: a system that lets you build systems on top

**Where:** A new paragraph after "Project-agnostic by construction", and one sentence added to **Success**.

**Why:** v5 frames auto-claude as a software-development platform with deployments. The v-next decisions (D9 two-layer model, D10 mechanism-vs-policy, D11 agents-as-data/config-packs) commit to something stronger: the platform's durable value is its *composability* — roles, lanes, workflows, and whole pipeline behaviors are data that an operator composes, so new systems are built **on top of** auto-claude rather than **into** it. Evidence basis: every shipped comparable (the opencode-based review system at scale, the heartbeat-agent orchestrator) put all its value in the configurable layer above a commodity runtime. The vision should claim the moat: trust machinery + governance + composability, not orchestration plumbing.

**Proposed wording (new paragraph):**

> **A system for building systems:** The platform's deepest property is that its behavior is composed, not coded. Roles, steering agents, lanes, gates, workflows, and whole pipeline configurations are declared data — versioned, swappable, auditable — bound by the platform's non-negotiable trust machinery. What the platform ultimately offers is therefore not one pipeline but the ability to assemble new autonomous systems — a development organization, a steering office, a review house — out of governed parts, on top of the same engine, without engineering the engine. The platform's value concentrates in what cannot be swapped: the gates, the earned-trust ramp, the decision protocol, the spec governance, and the audit trail under everything.

**Proposed Success addition:** "A new kind of autonomous system is assembled from declared parts on the existing engine — without changing the engine."

---

## Delta B — The single interface: replace the operator's tool zoo

**Where:** Amend the opening of **The steering surface** ("One pane.") and add one Success sentence.

**Why:** v5 already says "one pane", but as a description of the dashboard among other tools. The v-next goal is materially stronger: the platform's surface *replaces* the operator's working toolset for steering autonomous work — the separate cockpit, the watch-the-run terminal sessions, the ad-hoc status tools. v5's wording permits the zoo to persist; the goal is that it ends. The minimal-inbox shape (decisions + daily briefing and nothing else by default, drill-down on demand, phase-boundary intervention) is specified in FUNC-AC-OPERATOR-SURFACE; the vision should state the *intent* that this surface is the only steering tool the Operator needs.

**Proposed wording (replacing the "One pane." bullet's first sentences):**

> - **One pane — and the only pane.** The Operator steers from a single surface that is deliberately minimal: by default it shows only the decisions waiting on him and a daily briefing — nothing else. Depth is pulled, never pushed: any run can be opened to see what it has actually produced, what it has cost, and where it stands, and steered from right there — guidance and course-corrections land at the run's next natural boundary. This surface is intended to *replace* the operator's steering toolset, not join it: when it succeeds, watching terminals, separate cockpits, and ad-hoc status tools are not part of steering autonomous work. Deep-work conversational sessions remain the escape hatch for decisions that need discussion.

**Proposed Success addition:** "Steering the fleet requires exactly one surface; a week of normal operation needs no other steering tool."

---

## Delta C — Lanes as configurable policy, bounded by the tripwire invariant

**Where:** Amend the **Earned-trust delivery** bullet and add one boundary to **Boundaries**.

**Why:** v5 fixes the *shape* of the delivery policy in the vision (a risk-class ramp with specific behaviors per class). The lane decision (D5, Operator-ratified 2026-06-11) makes the policy *configurable data* — each deployment declares lanes (qualification → routing → gates → merge treatment → optional post-merge batch review) — while making one safeguard explicitly **non-configurable**: the platform verifies every change's actual content against what its lane declares it may touch, and per-deployment risk maps can only escalate, never mute. The vision should hold the invariant and release the policy. This delta is reflected in FUNC-AC-MERGE-DECISION v2, which remains within v5's boundaries (orange/red and compliance still always reach the Operator; autonomy still earned per deployment by explicit grant) — the delta names the configurability in the vision rather than changing any boundary.

**Proposed wording (amending the Earned-trust delivery bullet):**

> - **Earned-trust delivery through configurable lanes.** How a deployment's changes travel — how they qualify, who works on them at what capability level, which checks gate them, how they may merge, whether they are batch-reviewed after — is declared per deployment as lane policy, not fixed by the platform. The risk-class ramp remains the floor under every lane: low-risk changes can earn autonomous merge; higher-risk changes and anything touching authentication, sensitive data, migrations, or regulated paths reach a human by construction; trust is earned per risk class and per lane on each deployment, never granted at switch-on. One safeguard stands outside all configuration: the platform always verifies what a change *actually touched* against what its lane permits, and a deployment's risk markings can only force more caution, never less — a protection against the platform's own classification errors that no policy can switch off.

**Proposed Boundaries addition:**

> - The scope verification of changes against their declared lane, and the escalate-only nature of risk markings, are never configurable — no deployment profile, lane declaration, or learned behavior can weaken them.

---

## Record

| Delta | Decision (accept / amend / reject) | Date | Note |
|---|---|---|---|
| A — platform thesis | _pending_ | | |
| B — single interface | _pending_ | | |
| C — lanes + tripwire | _pending_ | | |
