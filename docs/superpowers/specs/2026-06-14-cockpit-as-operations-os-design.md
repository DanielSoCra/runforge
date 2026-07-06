---
date: 2026-06-14
status: PROPOSAL — design doc; feeds L0 Delta H (Operator-gated) + writing-plans
decision_status: HARDENED, not validated — sparring-driven-decision, codex GPT-5.5 xhigh adversary; Operator ratified the shape 2026-06-14 (no oracle exists for this bet)
type: direction-design
topic: Widen the cockpit from software-dev platform to the Operator's single operations-OS, narrow-first, gated by verifier-gated autonomy
reads_down_from:
  - .specify/L0-ac-vision.md            # v5, Operator-approved — NOT edited by this doc
  - docs/superpowers/specs/2026-06-11-l0-delta-proposal.md   # deltas A–G, pending Operator decision
related:
  - docs/superpowers/specs/2026-06-03-company-os-vision-and-roadmap-design.md  # "company-os" north-star input (not execution-canonical)
  - .specify/functional/operator-surface.md     # FUNC-AC-OPERATOR-SURFACE — the inbox this generalizes
  - .specify/functional/plugins.md              # FUNC-AC-PLUGINS — config packs
  - .specify/functional/runtime-adapters.md     # FUNC-AC-RUNTIME-ADAPTERS — the executor contract
  - .specify/architecture/lane-engine.md        # ARCH-AC-LANE-ENGINE — lanes
vault_decision_record: "knowledge-vault: 10-Projects/side-project/decisions/2026-06-14-cockpit-convergence-decision.md"
---

# Cockpit as Operations-OS — Direction Design + L0 Delta H Proposal

> **This document edits nothing canonical.** L0 is Operator-owned; the vision is never authored autonomously. This is a design doc + a proposal of one new L0 delta (H) and one new hard boundary, surfaced for the Operator. It records a decision the Operator ratified on 2026-06-14 after adversarial sparring. The actual L0 edit remains the Operator's hand.

## TL;DR

runforge's L0 widens from *"autonomous **software-development** platform"* to *"the Operator's single **operations** cockpit — one steering surface over all his AI-assisted work across his ventures; software is one lane-type among ops, knowledge-work, client-delivery, biz-dev."* Adopted as the **north-star**, executed **narrow-first**. The widening is gated by one new non-configurable invariant — **verifier-gated autonomy** — which resolves the core risk surfaced in sparring: most non-software work has no oracle, while the platform's entire trust machinery assumes one.

## The new invariant: verifier-gated autonomy

A **lane** declares a **verifier** — an oracle that can falsify "this work is correct" (tests/CI/a deployable diff, or any deterministic or independent check).

- **Verifier present** → the lane may earn autonomous *execution* on the existing earned-trust ramp.
- **Verifier absent** → the lane is **assist-and-escalate only**: it may draft, surface decisions, and act *on Operator approval*, but never auto-executes.

This is *"no verification = no merge"* generalized to *"no verifier = no autonomous action."* It is a **hard boundary** that sits beside Delta C's scope-tripwire: **non-configurable, not learnable-past, not overridable by a config-pack.** It prevents both failure poles at once — fake-confidence autonomy and escalation-flooding — and keeps trust machinery as engine code, never editable data.

## The four direction forks, resolved

1. **Mandate → operations-org *north-star* (new Delta H).** The *surface* unifies across all domains; *execution* stays gated by the verifier invariant. Software is one lane-type, not the point.
2. **side-project/hermes → absorb the *surface*, federate the *execution*.** side-project's decisions flow into the one inbox (the single pane is real); side-project keeps running as a *no-oracle domain executor behind* the cockpit (assist-only). It is **not** fused into the oracle-gated factory — that would be a category error (degrades both: factory loses rigor, secretary drowns in governance).
3. **Surface → surface-agnostic core as a *boundary*, one front-end as the *deliverable*.** Build the decision/state core with a clean seam so a second front-end is *possible* later; ship **one** front-end first. (YAGNI on web+Slack+mobile peers before the core is proven.)
4. **First proving ground → runforge itself, instrumented.** The software lane proves the stability bar; the first no-oracle lane is the Operator's own personal-ops (side-project), assist-only, with attention measured against a baseline.

## Delta F guard (personal leverage, not a product)

The L0 framing stays *"my personal operating system,"* explicitly **not** a horizontal product. The AI-consulting venture sells *outcomes built with the leverage*, never the platform itself. The word "cockpit"/"operations-OS" must not drift into product positioning — that collision was flagged in sparring.

## Sparring summary (codex GPT-5.5 xhigh — different model family)

The adversary's only job was to *kill* the lean against the rubric, not to validate it. It did **not** overturn the vision; it overturned the literal *"autonomous execution across all domains"* reading.

- **Oracle problem (the load-bearing hit):** trust machinery assumes a verifiable oracle; non-software work mostly lacks one → without the verifier invariant, "earned trust" collapses into fake confidence or review-everything. → resolved by verifier-gated autonomy.
- **"side-project as a lane" = category error** → resolved by surface-absorb / execution-federate.
- **"A single control plane reduces attention" is not automatic** → must be *measured*, not assumed (kill-condition #2).
- **Surface-agnostic core is premature as a deliverable** → one front-end first.
- **Config-packs must not encode trust** → verifier invariant is non-configurable.

**Epistemic status: hardened, not validated.** There is no oracle for this bet; it survived a different-family attack and the shape moved. Agreement was never sought.

## Kill-conditions (carried out loud)

1. **No no-oracle lane earns autonomous execution** until runforge shows **30–60 days of software-lane stability**: declining human interventions + reliable verification gates + *measured* attention reduction.
2. **After 30 days of the first assist-only personal-ops lane:** if escalations/day are *rising* (not flat/declining) or measured attention-load *exceeds* the pre-cockpit baseline → halt expansion, fall back to federation-only.
3. **If Delta H + the first slice becomes a config/spec project eating >2 weeks** before any lane runs → setup-as-procrastination; ship the thinnest dogfood slice instead.

## Relationship to the existing chain (extends, does not fork)

- Extends **L0 v5**; **adds Delta H** to the pending A–G proposal; **sharpens A** (composability — trust stays non-configurable) and is a **sibling of C** (the scope-tripwire — verifier-gate is the autonomy analogue).
- The first slice is mostly **generalization** of specs already in PR #720: `FUNC-AC-OPERATOR-SURFACE` (the inbox), `ARCH-AC-LANE-ENGINE` (lanes), `FUNC-AC-RUNTIME-ADAPTERS` / `ARCH-AC-SESSION-PROVIDERS` (the executor contract). Not greenfield.
- Sits alongside `2026-06-03-company-os-vision-and-roadmap` as its **execution-disciplined successor** (that doc is north-star *input*, not execution-canonical).

## Decomposition roadmap

- **P0 (now):** Operator authors **L0 Delta H + the verifier-gate boundary**; Operator decides pending deltas A–G; clear #720 CI blocker (#723 — in flight).
- **P1 — first slice (dogfood, → writing-plans next):** generalize the lane/executor/inbox contract to accept a **no-oracle domain executor**; enforce the verifier-gate (assist-only when no verifier is declared); wire **side-project as the first** such executor, surfaced into the one inbox; build **attention instrumentation** (escalations/day, decision-weight mix, time-to-decide, vs. a captured pre-cockpit baseline). Small, reversible, proves the multi-domain surface without fusing execution or risking a client.
- **P2:** prove kill-condition #1 on the software lane; add a second no-oracle lane only after.
- **P3+:** client/revenue domains (product intake → build → delivery; consulting) — only past the kill-conditions; each must declare its verifier or stay assist-only.

## Open questions for the Operator

1. **One front-end first:** start with the already-specced **web cockpit** (richer decision inbox; Slack becomes a notification edge), or invert to **Slack-first** (you live in Slack for side-project today)? Recommendation: web cockpit for the decision inbox, Slack as the edge — but this is your call.
2. **side-project `_overview` (vault):** update its project status to *"surface absorbed / execution federated, assist-only"*? I'll do it on your nod.
3. **First ops-lane verifier:** is there *any* cheap oracle for a personal-ops task (e.g. "calendar event created == checkable", "draft saved == checkable")? If yes, that lane could earn limited autonomy sooner; if no, it stays assist-only by design.
