---
date: 2026-06-11
status: RESOLVED 2026-06-14 — all 8 deltas accepted, enacted in L0-AC-VISION v6 (historical record)
type: l0-delta-proposal
topic: Eight proposed amendments to L0-AC-VISION (v5 → v6)
authors: Claude (spec-chain goal run), per masterplan v2.1 §2.1; Deltas D–E salvaged from branch spec/l0-steering-surface (its draft v6, 2026-06-02); Deltas F–G from the Operator alignment interview (2026-06-11); Delta H from the sparring-driven-decision session (2026-06-14)
reads_down_from:
  - .specify/L0-ac-vision.md  # v5, Operator-approved — NOT edited by this proposal
related:
  - docs/superpowers/specs/2026-06-11-runforge-vnext-masterplan-design.md  # D5, D9–D11, §2.2
  - docs/superpowers/specs/2026-06-11-branch-salvage-checklist.md  # provenance of Deltas D–E
---

# ⚠️ L0 Delta Proposal — Operator Decision Required

> **This document edits nothing.** L0 is Operator-owned; per the platform's own boundaries the vision is never authored or edited autonomously. This is a *proposal* of eight deltas to `L0-AC-VISION` v5, surfaced for the Operator's decision per masterplan v2.1 §2.1. Deltas A–C originate from the v-next spec-chain run; Deltas D–E are salvaged from the stale branch `spec/l0-steering-surface` (which had drafted them directly into L0 as a v6 — content preserved here, the direct edit discarded); Deltas F–G capture the Operator's own vision corrections from the alignment interview (2026-06-11); Delta H (operations-org thesis + verifier-gated autonomy) was added 2026-06-14 from an adversarial sparring session and ratified the same day (full design: PR #724). Accepting, reshaping, or rejecting any of the eight blocks nothing else in the v-next spec chain: the L1 specs written alongside this proposal are consistent with v5 as it stands, and these deltas only *name in the vision* what those specs already keep within v5's boundaries.

## How to act on this

For each delta: **accept** (the wording below, or your own), **amend**, or **reject**. On acceptance, L0-AC-VISION goes to version 6 with the chosen wording — edited by you or by a run you explicitly direct, never silently.

---

## Delta A — The platform thesis: a system that lets you build systems on top

**Where:** A new paragraph after "Project-agnostic by construction", and one sentence added to **Success**.

**Why:** v5 frames runforge as a software-development platform with deployments. The v-next decisions (D9 two-layer model, D10 mechanism-vs-policy, D11 agents-as-data/config-packs) commit to something stronger: the platform's durable value is its *composability* — roles, lanes, workflows, and whole pipeline behaviors are data that an operator composes, so new systems are built **on top of** runforge rather than **into** it. Evidence basis: every shipped comparable (the opencode-based review system at scale, the heartbeat-agent orchestrator) put all its value in the configurable layer above a commodity runtime. The vision should claim the moat: trust machinery + governance + composability, not orchestration plumbing.

**Proposed wording (new paragraph):**

> **A system for building systems:** The platform's deepest property is that its behavior is composed, not coded — it is more a plugin system than a hardcoded piece of software. Roles, steering agents, lanes, gates, workflows, and whole pipeline configurations are declared data — versioned, swappable, auditable config packs — bound by the platform's non-negotiable trust machinery. What the platform ultimately offers is therefore not one pipeline but the ability to assemble new autonomous systems — a development organization, a steering office, a review house — out of governed parts, on top of the same engine, without engineering the engine. The platform's value concentrates in what cannot be swapped: the gates, the earned-trust ramp, the decision protocol, the spec governance, and the audit trail under everything.

*(Alignment interview, 2026-06-11: the Operator reinforced this framing in the Operator's own words — the platform should be "a plugin system, less a hardcoded piece of software". The wording above reflects that.)*

**Proposed Success addition:** "A new kind of autonomous system is assembled from declared parts on the existing engine — without changing the engine."

---

## Delta B — The single interface: replace the operator's tool zoo

**Where:** Amend the opening of **The steering surface** ("One pane.") and add one Success sentence.

**Why:** v5 already says "one pane", but as a description of the dashboard among other tools. The v-next goal is materially stronger: the platform's surface *replaces* the operator's working toolset for steering autonomous work — the separate cockpit, the watch-the-run terminal sessions, the ad-hoc status tools. v5's wording permits the zoo to persist; the goal is that it ends. The minimal-inbox shape (decisions + daily briefing and nothing else by default, drill-down on demand, phase-boundary intervention) is specified in FUNC-AC-OPERATOR-SURFACE; the vision should state the *intent* that this surface is the only steering tool the Operator needs.

**Proposed wording (replacing the "One pane." bullet's first sentences):**

> - **One pane — and the only pane.** The Operator steers from a single surface that is deliberately minimal: by default it shows only the decisions waiting on the Operator and a daily briefing — nothing else. Depth is pulled, never pushed: any run can be opened to see what it has actually produced, what it has cost, and where it stands, and steered from right there — guidance and course-corrections land at the run's next natural boundary. This surface is intended to *replace* the operator's steering toolset, not join it: when it succeeds, watching terminals, separate cockpits, and ad-hoc status tools are not part of steering autonomous work. Deep-work conversational sessions remain the escape hatch for decisions that need discussion.

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

## Delta D — The levers the Operator turns: a named Set/Decide/Inspect inventory

**Where:** A new bullet in **The steering surface**, after the "Coordinator, not executor." bullet. Salvaged from `spec/l0-steering-surface` (draft v6, 2026-06-02), updated for the lane decision (D5, ratified 2026-06-11) which post-dates it.

**Why:** v5 describes the steering surface by *examples* of what the Operator does; it never inventories the levers. Without a named inventory, every new dial added by an L1 spec silently widens the Operator's surface, and there is no vision-level test for "does this belong in front of the human at all?". Grouping every dial under three verbs — SET (intents declared), DECIDE (the only things that reach the human), INSPECT/OVERRIDE (look beneath, reach in) — gives that test. The salvaged inventory predates the lane decision, so the SET list below adds the deployment's lane policy (consistent with Delta C); everything else is the salvaged wording.

**Proposed wording (new bullet):**

> - **The levers the Operator turns.** Every dial the Operator reaches for groups under three verbs — each phrased as an intent the Operator *sets*, never a mechanism the platform runs:
>   - **SET** (intents and setpoints the Operator declares): the direction and what-is-worth-building; per deployment, the profile dials — its budget, its lane policy, its risk-classification rules, its compliance-reviewer set, its honest-automation map, its rollout slot, and its release path; and, across the fleet, the interruption threshold that decides which of one deployment's items break through while the Operator is focused on another.
>   - **DECIDE** (the only things that ever reach the human): specification content; production releases; widening a deployment's autonomy, per deployment and per risk class; any escalated or compliance-blocked change; and a fleet-wide rollback.
>   - **INSPECT / OVERRIDE** (the Operator can always look beneath and reach in): see *why* any item is ranked or learned the way it is; reset or revert a learned bias; and order a fleet-wide demote-on-red.
>   The Operator sees decisions and a calm glance-state; everything below a decision is delegated to the platform and asked-about less over time, never crossing the boundaries below.

**Interaction with Delta B:** independent — B reshapes the "One pane." bullet (the *surface*), D names the *levers* the surface carries. Accepting either alone is coherent.

---

## Delta E — Boundary ownership: each hard invariant names its enforcing L1

**Where:** Amend the **Boundaries (hard, load-bearing)** section — one introductory sentence, plus a parenthetical ownership attribution on each invariant that has an enforcing L1 spec. Salvaged from `spec/l0-steering-surface` (draft v6; keep-distributed ratified there 2026-06-02).

**Why:** v5 states the hard boundaries but not who enforces them, leaving open whether a central "boundary service" should exist. The ratified answer is keep-distributed: the vision centralizes the *principle*, each L1 spec owns and enforces the *mechanism* for its domain. Naming the owner on each invariant makes drift detectable (an invariant with no owning L1 is a gap) and blocks re-centralization by accident. All named owners exist in the current chain: FUNC-AC-COMPLIANCE-GATE, FUNC-AC-DECISION-ESCALATION, FUNC-AC-OPERATOR-LEARNING, FUNC-AC-FLEET, FUNC-AC-MERGE-DECISION, FUNC-AC-SAFETY.

**Proposed wording (introductory sentence, inserted directly under the Boundaries heading):**

> These are vision-level invariants; each is owned and enforced by the L1 spec for its domain — the platform centralizes the principle, not the mechanism.

**Proposed attributions (appended to the existing v5 bullets, which are otherwise unchanged):**

> - Never decides safety-critical, sensitive-data, specification-content, or production-release questions autonomously — […] *(Compliance and regulated-sensitive paths are owned and enforced by FUNC-AC-COMPLIANCE-GATE; fail-safe routing of every such decision to the human is owned by FUNC-AC-DECISION-ESCALATION.)*
> - The learn-from-the-operator loop may reduce how often it asks the Operator **only** for decision-classes outside that always-escalate set […] *(The always-escalate set and the learning-can't-cross-a-boundary invariant are owned by FUNC-AC-OPERATOR-LEARNING.)*
> - Never deploys to production, and never graduates a deployment to wider autonomy, without the Operator's approval […] *(Earned trust, the risk-class merge ramp, and per-deployment autonomy are owned by FUNC-AC-FLEET; the merge decision itself is owned by FUNC-AC-MERGE-DECISION.)*
> - Never proceeds past a deployment's cost circuit breaker or budget ceiling without escalating to the Operator […] *(The cost circuit breaker, workspace containment, and credential isolation are owned and enforced by FUNC-AC-SAFETY.)*

**Interaction with Delta C:** if Delta C's new boundary (scope verification + escalate-only risk markings, never configurable) is accepted, it receives the same treatment — its owner is FUNC-AC-MERGE-DECISION (v2, which defines the lane tripwire).

---

## Delta F — Purpose: personal leverage, not a product

**Where:** A new sentence-pair in the **For:** framing (the Operator paragraph), and one line under whatever horizon/out-of-scope list v6 carries. From the alignment interview (2026-06-11).

**Why:** Nothing in v5 states what the platform is ultimately *for* beyond serving "a human Operator" — which leaves room for product-shaped drift: generalizing for hypothetical other users, multi-tenant hardening, sellability trade-offs. The Operator's correction closes that room: the platform's purpose is **personal leverage** — it pays rent to its Operator and is deeply customizable to that one person's way of working. Selling it is an explicitly low-priority horizon option, never a goal that may shape design.

**Proposed wording (added to the For: framing):**

> The platform exists to pay rent to its Operator: it multiplies one person's reach and is deeply customizable to that person's way of working. It is not built to be sold. Making it sellable or multi-tenant is at most a low-priority horizon option — and never one that trades away operator-fit, customizability, or the speed of serving its one Operator.

**Proposed Boundaries/horizon line:** "Generalizing for hypothetical other users at the expense of the Operator's fit is a vision violation, not a roadmap item."

---

## Delta G — Free of reasoning-vendor lock-in

**Where:** A new bullet under the platform-properties section (beside "Project-agnostic by construction"). From the alignment interview (2026-06-11).

**Why:** v5 is silent on vendor posture, while the runtime today is culturally anchored to one vendor's tooling. The v-next chain already builds the mechanism (provider-agnostic adapters, multi-provider registry, config-pack model routing — FUNC-AC-RUNTIME-ADAPTERS / ARCH-AC-SESSION-PROVIDERS v2); the vision should state the *property* the mechanism guarantees, so future work cannot quietly re-anchor the platform to a single vendor.

**Proposed wording (new bullet):**

> - **Free of vendor lock-in:** The platform is bound to no reasoning-model vendor. Provider-agnostic adapters are the structural guarantee: every role and lane can be re-pointed at a different vendor's models by configuration alone, and the platform's durable value — trust machinery, governance, composability — survives any vendor swap. Were an open-source baseline to serve the platform's needs, it would be adopted; as of 2026-06 none did — a finding to revisit, never a commitment to any vendor.

---

## Delta H — From software-org to operations-org (one operating system for all the Operator's work)

**Where:** A new paragraph in the platform-properties region (beside Delta A's "A system for building systems"); a new bullet in **Boundaries** (verifier-gated autonomy); and one sentence added to **Success**.

**Provenance:** Hardened via adversarial sparring (codex GPT-5.5 xhigh, different model family) on 2026-06-14 and ratified by the Operator the same day. Full design + reasoning: `docs/superpowers/specs/2026-06-14-cockpit-as-operations-os-design.md` (PR #724). Strategic record: the knowledge vault, decision note `2026-06-14-cockpit-convergence-decision.md`.

**Why:** v5 and Deltas A–G still scope the platform to autonomous *software development* — even Delta B's "one pane" is the only steering tool for autonomous *work*, where "work" means software pipelines. The Operator's actual need is broader: a single steering surface over **all** the Operator's AI-assisted work across multiple parallel workstreams (the platform itself, a regulated pilot deployment, and other deployments), with software delivery as one *lane-type* among operations, knowledge-work, client-delivery, and business-development. Adopted as a **north-star executed narrow-first**. Sparring established the widening is only safe under a new invariant — the verifier-gate below: the trust machinery (risk-class gates, earned-trust merge, "no verification, no merge", spec governance) assumes a verifiable **oracle** that most non-software work lacks; without the gate, no-oracle lanes force a choice between fake-confidence autonomy and escalation-flooding, and fusing a no-oracle assistant (the Operator's existing personal agent) into the oracle-gated factory degrades both. Resolution: absorb such systems at the **surface** (their decisions enter the one inbox), federate their **execution** (they run as assist-only domain executors behind the cockpit).

**Proposed wording (new paragraph):**

> **One operating system for all the Operator's work.** The platform's mandate is not limited to building software; it is the Operator's single operations layer — one steering surface over every kind of AI-assisted work the Operator runs across multiple parallel workstreams: software delivery, operations, knowledge-work, client delivery, and business development. Software development is one *lane-type*, not the platform's purpose. What unifies the domains is the surface and the trust machinery, not the work itself: each domain is a lane with its own executor, surfaced and steered from the one pane. This is a destination reached incrementally — the platform proves each new domain on the Operator himself, instrumented and measured, before it carries another's, and never widens a lane's autonomy ahead of its earned trust.

**Proposed Boundaries addition (verifier-gated autonomy):**

> - **Verifier-gated autonomy.** A lane may earn autonomous *execution* only if it declares a verifier — an oracle that can falsify "this work is correct" (tests, CI, a deployable diff, or any deterministic or independent check). A lane with no verifier is **assist-and-escalate only**: it may draft, surface decisions, and act on the Operator's approval, but never executes autonomously. This generalizes the platform's "no verification, no merge" rule to all work — *no verifier, no autonomous action*. Like the scope tripwire (Delta C), it is never configurable: no deployment profile, lane declaration, or learned behavior can grant a no-verifier lane autonomous execution.

**Proposed Success addition:** "A non-software domain is steered from the same one pane as code; and no lane — in any domain — acts autonomously without a declared verifier."

**Interaction with other deltas:** builds on **A** (a domain is a config-pack-shaped lane) and is the autonomy sibling of **C** (the scope tripwire); consistent with **B** (the one pane now spans domains), **D** (the SET/DECIDE/INSPECT levers gain non-software lanes), and **F** (the widening is personal leverage, never a horizontal product — "operations cockpit" must not drift into product positioning). Per **E**'s keep-distributed model, the new boundary's owning L1 is an Operator call: extend `FUNC-AC-MERGE-DECISION` or stand up a new FUNC for the verifier-gate.

---

## Record

| Delta | Decision (accept / amend / reject) | Date | Note |
|---|---|---|---|
| A — platform thesis | **accept** (as-worded) | 2026-06-14 | enacted in L0 v6 |
| B — single interface | **accept** (as-worded) | 2026-06-14 | enacted in L0 v6 |
| C — lanes + tripwire | **accept** (as-worded) | 2026-06-14 | enacted in L0 v6; new non-configurable scope-tripwire boundary |
| D — operator lever inventory | **accept** (as-worded) | 2026-06-14 | enacted in L0 v6; salvaged from spec/l0-steering-surface |
| E — boundary ownership map | **accept** (as-worded) | 2026-06-14 | enacted in L0 v6; salvaged from spec/l0-steering-surface |
| F — personal leverage, not a product | **accept** (as-worded) | 2026-06-14 | enacted in L0 v6; alignment interview 2026-06-11 |
| G — vendor lock-in freedom | **accept** (as-worded) | 2026-06-14 | enacted in L0 v6; alignment interview 2026-06-11 |
| H — operations-org thesis + verifier-gated autonomy | **accept** (as-worded) | 2026-06-14 | enacted in L0 v6; verifier-gate enforcing L1 authored as **FUNC-AC-VERIFIER-GATE** (new cross-cutting boundary spec, 2026-06-14; L2/L3 deferred to impl); sparring-hardened 2026-06-14, full design PR #724 |
| Earn-in semantics (Operator ruling alongside the deltas) | **pre-approved auto-promote** | 2026-06-14 | enacted in L0 v6 + FUNC-AC-MERGE-DECISION v2.2 / FUNC-AC-FLEET v2.2; bounded to verifier-gated, autonomous-eligible lanes; recorded + reversible |

> **Resolved 2026-06-14.** All eight deltas accepted as-worded and enacted in `L0-AC-VISION` v6; the earn-in ruling enacted in the merge-decision and fleet L1s. This proposal is now a historical record — `L0-AC-VISION` v6 is canonical.
