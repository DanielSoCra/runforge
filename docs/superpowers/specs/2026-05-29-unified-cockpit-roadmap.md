---
date: 2026-05-29
status: superseded
superseded_by: .specify/L0-ac-vision.md  # unified L0-AC-VISION v5 + its L1 children (FUNC-AC-OPERATOR-LEARNING, -COMPLIANCE-GATE, -FLEET)
superseded_date: 2026-06-02
type: roadmap-design
topic: Unified auto-claude × cockpit — self-improving closed-loop SDLC where the human steers
authors: the Operator (lead) + Claude (synthesis) + Codex (sparring)
candidate_supersedes:  # NOT yet superseded. Supersession is ENACTED by the Phase-1 ledger (§7) after content migration + back-pointers — never by this frontmatter. This roadmap retires nothing itself.
  - acme-platform archive/2026-05-20-parallel-session-raw:docs/superpowers/specs/2026-05-20-100x-solo-dev-architecture.md (system-architecture portions, incl. its §7 "90-Tage Sequencing" — Phase-1 ledger migrates, then marks)
  # RESOLVED by the Spec Reconciliation Ledger (2026-05-29): the "2026-05-21 consolidation roadmap (Steps 0–4)" is NOT a separate artifact — it = the 100x doc's §7 sequencing (above) + acme issue #451 ("AI Dev Workflow Consolidation" planning thread, re-anchored to this roadmap, NOT superseded).
related:
  - knowledge-vault docs/superpowers/specs/2026-05-23-pm-cockpit-design.md (cockpit decision-lifecycle v1)
  - auto-claude .specify/functional/decision-escalation.md (FUNC-AC-DECISION-ESCALATION, L1, on dev)
  - auto-claude issues #677–684 (PVS-ready execution track) + #685–689 (cockpit steering track)
---

# Unified Cockpit Roadmap

> **⛔ SUPERSEDED (2026-06-02).** The unified L0/L1 specs this roadmap called for now exist and are **Operator-approved** in `.specify/`: **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children **FUNC-AC-OPERATOR-LEARNING**, **FUNC-AC-COMPLIANCE-GATE**, **FUNC-AC-FLEET** (PR #697, merged to `main`). Per §7, this doc is now superseded by them. It is retained for history and for its phased-roadmap / governance narrative; **the canonical specs in `.specify/` govern — do not act on this doc as a live instruction.** Supersession of this roadmap's own `candidate_supersedes` inputs is enacted by the Spec Reconciliation Ledger (`docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`).
>
> *(Original status note, for history: a roadmap design doc, not a spec; it defined the path and governance and was to be superseded by the unified L0/L1 once authored — which has now happened.)*

## 1. Goal

One system: **auto-claude as a self-improving, closed-loop software-development platform** — all SDLC roles (PO → architecture → dev → review → QA → security → compliance → DevOps → SRE) running as an honest, agile, verifiable loop — with the **PM/PO Cockpit dashboard as the primary surface** through which the Operator *steers* rather than *executes*. The system **learns from updated skills and from the Operator's own behavior**, gets smarter over time, and asks him less about what it can predict. **The human is the scarce resource; the system's job is to protect his attention** and surface only what genuinely needs him.

The platform is **project-agnostic**. Targets, in order: acme-platform (deployment #1) → auto-claude itself → other projects — all as configured *deployments* of one platform, not bespoke builds.

## 2. Honest diagnosis (where we actually are)

**Design-complete, wiring-sparse.** The architecture for nearly all of this already exists in specs (auto-claude's `.specify` tree is the most complete autonomous-SDLC design we have, and the 2026-05-20 "100x" doc is ~80% of this exact vision). The gap is **plumbing**: most compounding/learning loops are *spec-complete but runtime-orphaned*, and the "learn from the operator" capability does not exist at all. **The work is reconciliation + wiring + one new layer, not invention.**

Inherited from the 100x doc — **acme's deployment profile** (deployment #1, the highest-ROT one). This is a *per-deployment* honest-boundary, **not the platform's** — every deployment carries its own (a product project: almost no ROT; content-site: none). For acme specifically:
- **GRÜN (thesis holds):** code-bound work — spec, implementation, tests, docs, multi-lens review, deterministic engines.
- **GELB (strains):** ISO 27001 ISMS controls, DSGVO paper-chain (code yes, the document/signature chain no).
- **ROT (breaks — irreducibly human):** the regulator quarterly module cert cycles, the compliance authority re-cert, the confidentiality statute sub-processor signature chains, auditor/Benannte-Stelle interactions, software-liability as a the confidentiality statute processor.

Implication (generalizes per deployment): **the learn-from-operator loop exists to claw back each deployment's GRÜN/GELB from the Operator's plate so his scarce attention concentrates on its ROT.** For acme, "100x" is honest only on the engineering-bound part; end-to-end incl. compliance is ~2–3x. The roadmap optimizes for *attention concentration on the irreducibly-human work*, per deployment — not a fictional 100x.

## 3. Locked design decisions (from the brainstorm)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Two surfaces:** dashboard = calm glance-and-steer (inbox-core + on-demand panels); Claude Code + pm-skill = deep-work driver | Two headspaces; minimize attention surface |
| D2 | **Local-first, mini-as-server, one pane, Tailscale + phone** | The mini already runs 24/7; no Hetzner cost for the control plane (Hetzner is for *deploying acme the product*) |
| D3 | **PHI is a acme-runtime/ops concern, NOT the dev-control plane's** | Dev artifacts (code, issues, decisions) carry no patient data; the cockpit's sensitivity machinery stays as cheap defense-in-depth, not architecture-defining → no split-brain |
| D4 | **Unify: pm-cockpit folds INTO auto-claude** (Option A, vendored monorepo) | One repo, one dashboard; persistence is now a merge-engineering choice (not a PHI mandate) |
| D5 | **Sequencing: unify-spec-first** | Author one unified spec that resolves the residual forks, then wire |
| D6 | **Proactivity = the PO engine, bounded:** suggests L1 only, never edits L0; durable re-ranked idea-backlog; **pull (global + contextual), not push**; pluggable signals (the Operator first → others → user feedback, maps to #687) | Matches the existing PO design + the steer-not-execute boundary |
| D7 | **Learn-from-operator: spec it L1→L3 first**, then build capture as the first slice; hard L0 guardrails (never auto-decide safety/PHI/L1-content/prod) | The novel core; provenance matters; never cross the autonomy boundary |
| D8 | **Spec governance: never-delete-always-supersede**, unified across repos + non-`.specify` docs; one canonical head; enforced by guardians + drift-audit; framed as part of L5 Compounding | A stale doc is a repeated-mistake vector because agents read docs to act |
| D9 | **Reconciliation sweep: initiative-scoped now + recurring cross-repo drift-audit later** | Clean the unification artifacts fast; let the system keep the rest honest over time |
| D10 | **Platform is project-agnostic; everything domain-specific lives in a per-deployment *profile*** (its `repos[]`, risk-class rules, compliance persona-set, its own GRÜN/GELB/ROT, budget, canary slot, focus) held in the fleet/deployment registry. acme is deployment #1, not the platform's shape. | Multi-project by construction; the inbox is the only cross-deployment surface (focus-gated, §6.6) |

## 4. Current state — three threads + in-flight

The vision was built in parallel halves plus a master doc:

- **Master blueprint (parked):** `2026-05-20-100x-solo-dev-architecture.md` (5-layer: Strategy→Spec→Execution→Verification→Compounding + cross-cutting Compliance Lane + ~40 agent personas + the GREEN/YELLOW/ORANGE/RED auto-merge mechanism) + the 2026-05-21 consolidation roadmap (Steps 0–4). Lives on a acme **archive branch, in German** — wrong home for a canonical *system* spec.
- **Execution track (dormant):** auto-claude #677 epic + #678 (H3 compound-from-merge harness), #679 (risk-classification), #680 (acme deploy pipeline), #681 (E2E smoke), #684 (H2 adversarial-mandate). H1 Batch-Classifier merged (PR #543). References stale `dev`/archive refs.
- **Steering track (active — this is what's been built):** pm-cockpit slices 1/2/4 merged (protocol + index + watcher + dashboard, decision-lifecycle, PHI boundary, intent socket); the `pm-cockpit` agent-skills plugin shipped (router + orient/shape-ticket/close); cockpit cluster #685–689 (`backlog-only`).

In-flight risks the roadmap must absorb:
- **Branch model is broken (blocks branch-based work):** auto-claude `dev` ~27 behind `main`; production work (Postgres cutover, #691) lands on `main`; CLAUDE.md says push-to-`dev`. **The #685 L1 lives on `dev`, not `main`** (confirmed: absent from this branch's traceability). → §11 prerequisite.
- **Canary doctrine violated *today*:** agent-skills syncs fleet-wide-instant (≤5 min to every Mac) — opposite of "content-site canary, never acme first." Live exposure now.
- **acme mid-conflict:** 6 P1 ship-stops, queued release train, PR #496 (32-file calendar-core) dirty. Runs on its own GOAL.md loop, parallel — not blocking, but not quiet.
- **Three-to-four attention surfaces to reconcile:** auto-claude's `concierge` (SQLite event-bus + board UI + SSE) + auto-claude dashboard + pm-cockpit inbox + a vestigial HTML dashboard.
- **Next.js major split:** auto-claude dashboard on 16.x, pm-cockpit on 15.x.

## 5. Target architecture

The 100x 5-layer model, updated and unified:

- **L1 Strategy/Research** — the Operator + AI sparring. (Largely unchanged.)
- **L2 Spec+Plan** — `sparring-driven-development` + the spec pipeline (L0→L3, guardians).
- **L3 Execution** — the auto-claude daemon **on the mini** (not Hetzner — D2). GitHub Issues remain the work queue; the bug/simple pipeline needs no `.specify` tree on the target.
- **L4 Verification** — unit/integration + E2E (Playwright via the `qa-reviewer` capability) + post-deploy smoke. Hard rule (kept): **no verification ⇒ no auto-merge eligibility.**
- **L5 Compounding** — the learning loops (compound-from-merge, enriched-commits, recurrence→promote) **+ spec-governance (§7)** as a compounding concern.
- **Cross-cutting Compliance Lane** — a **deployment-configurable** persona-set (acme: the confidentiality statute/DSGVO/the regulator/the compliance authority/MDR; other deployments: GDPR-only or none), **wired as enforced gates** (today they only advise).

**Two layers new vs. the 100x doc:**
1. **The steering surface (the cockpit):** the decision inbox + on-demand panels as auto-claude's *primary* UI, mini-hosted single-pane (D1/D2). The 100x doc was repo-file-based (`STRATEGY.md`, `personas/*.md`); this replaces that with a live dashboard + the `pm` skillset.
2. **The learn-from-operator loop (D7):** behavioral-signal capture → operator-preference model → adaptive escalation + pull-time relevance (global + contextual), inside hard L0 guardrails.

**Platform vs. deployment — multi-project by construction (D10):** the platform (auto-claude + cockpit) is **project-agnostic**. Everything domain-specific lives in a **per-deployment profile** in the fleet/deployment registry (`~/.agents/pm/registry.yaml` → `deployments[]`): its `repos[]`, risk-class rules, compliance persona-set, **its own GRÜN/GELB/ROT** (§2 is acme's, not the platform's), budget, canary slot, focus. **acme is deployment #1, not the platform's shape.** Partly built already: pm-cockpit's registry + the watcher's multi-repo polling + auto-claude's multi-repo `RepoManager`. The **unified inbox is cross-deployment** (§6.6 focus-gating): while focused on one deployment, only items at/above a threshold from *others* break through — acme + content-site + a product project in one ranked surface, **bounded isolation** by default. The mini hosts N deployments via the registry; adding a project is a registry entry, not a fork.

**Persistence/PHI (reframed per D3/D4):** PHI is not a dev-control-plane constraint, so the Postgres-vs-local-SQLite choice is a **merge-engineering decision deferred to the Phase-1 spec** — not forced by patient data. The cockpit's sensitivity-classification stays as defense-in-depth. The one real network guardrail is non-PHI: the control plane holds GitHub tokens and can steer/merge, so it stays **Tailscale-only** (the built auth covers it).

**Boundary (unchanged, load-bearing):** the cockpit/PO **coordinates** — creates/shapes work, sets focus, answers decisions, suggests L1. It **never** merges/deploys, alters a pipeline phase, edits L0, or auto-decides safety/PHI/L1-content/production.

## 6. The auto-merge / trust mechanism (from the 100x doc, adopted)

GREEN/YELLOW/ORANGE/RED risk-classes drive the 80/20 split and double as the compliance gate:
- **GREEN** (docs/format/dep-patch) → auto-merge on green CI.
- **YELLOW** (<100 LOC, **no auth/PHI/migration paths**, no security keywords) → auto-merge after a reviewer-session passes.
- **ORANGE/RED** → surfaced to the Operator as a decision (the inbox). Auth/PHI/migration paths force review by construction → this *is* the compliance gate's first line.
This answers the trust-ramp and is the **target** merge policy for acme — **not the day-1 setting.** On a regulated repo, acme enters fully **human-gated even on GREEN** (the Phase-5a pilot); the GREEN/YELLOW auto-merge above is entered only after the gates (verification, risk-class, compliance) are proven green on the pilot. Trust is *earned*, not granted at cutover.

## 7. Spec governance & reconciliation (the new discipline — D8/D9)

**Principle (yours, unified):** never delete; always supersede with a machine-readable back-pointer + reason + date, applied across all repos and to non-`.specify` planning docs. Reuses the existing mechanisms: `.specify` `status: draft→approved→deprecated` + `deprecated_by`/`deprecation_reason` (`spec-lifecycle.md`); acme "newer-dated wins"; vault `superseded_by`.

**Phase-1 first act — the Spec Reconciliation Ledger (initiative-scoped, D9):**
1. Inventory every planning/spec/decision artifact touching this initiative across auto-claude, pm-cockpit, agent-skills, acme, and the vault.
2. Assign each a disposition: `canonical` · `merge→supersede` · `historical` · `active-sub-spec`.
3. The ledger (committed in auto-claude `docs/`) is the map; it doubles as decision-provenance for acme's the confidentiality statute/ISO lane.

**Canonical head:** the unified L0/L1 lives in **auto-claude `.specify`** (it has the lifecycle machinery, traceability, and guardians; the vault keeps strategic/decision context per CLAUDE.md; acme docs stay product-local). It carries a `Supersedes:` list; each retired doc gets the frontmatter **plus a visible top-of-file banner** (agents read the body) + a back-pointer.

**Mis-homed fix:** migrate the 100x doc's *system-architecture* content → unified `.specify`; its acme *product* content (BEMA/the regulator/cert) stays in acme docs; mark the archived doc superseded-by-unified, content-migrated.

**Self-sustaining (ongoing):** extend the spec-guardian skills to reject an unmarked replacement; add a recurring doc-drift audit (rides `verified-codebase-review` + the `learnings-reviewer`); entry-point docs (AGENTS.md/README/traceability/vault overview) always point to the canonical current spec.

## 8. The phased roadmap

Dependency-ordered. Each phase: **goal · produces · depends-on · maps-to**.

### Phase 0 — Clear the ground (prereq)
- **Goal:** remove the blockers that make branch-based work ambiguous.
- **Produces:** branch-model decision executed (§11); the canary-violated-now exposure made conscious (interim: stop treating agent-skills `main` push as safe for acme-driving sessions); acme's GOAL.md loop confirmed running in parallel (not blocked).
- **Depends-on:** §11 ruling.
- **Maps-to:** in-flight risks in §4.

### Phase 1 — Unify-spec-first (the heart)
- **Goal:** one current unified spec that reconciles all threads and resolves the residual forks.
- **Produces:** (a) the **Spec Reconciliation Ledger** (§7); (b) the unified **L0/L1** in `.specify` (ingesting 100x §5–7 + the consolidation roadmap + the cockpit design + #677–689 as inputs), with superseded docs marked; (c) sub-spec chains queued: **#685** DecisionRequest L2/L3 · behavioral-learning L1→L3 (D7) · skills-ingress/fleet-registry L1→L3 · compliance-gate L1→L3. The unified L0/L1 is where §9's forks are decided.
- **Depends-on:** Phase 0.
- **Maps-to:** the ledger dispositions the 100x doc (migrate→supersede) and, once located, the 2026-05-21 roadmap — supersession enacted here, never in this doc's frontmatter.

### Phase 2 — Fold cockpit in + build the seam
- **Goal:** one repo, one mini-hosted single-pane surface, working escalation→answer→resume.
- **Produces:** pm-cockpit vendored into the auto-claude monorepo (persistence decided in Phase 1); **#685 emitter** implemented (auto-claude pauses → structured DecisionRequest → inbox → answer → resume); the 3–4 attention surfaces reconciled into one (concierge + inbox + dashboard).
- **Depends-on:** Phase 1 (#685 L2/L3, attention-surface decision).
- **Maps-to:** #685–689; pm-cockpit slices.

### Phase 3 — Wire the orphaned loops
- **Goal:** turn the design-complete loops into running loops.
- **Produces:** learning-loop **producer** side (worker emits markers · enriched-commits · the recurrence→promote scheduler · turn on vault KnowledgeSync); **behavioral capture + operator-model + adaptive escalation** (per the Phase-1 spec); **skills→worker ingress + fleet-registry versioning + canary-as-a-coded-gate** (fixes the §4 violation). The fleet-registry also binds a **per-deployment budget** (caps LLM spend as autonomy widens) and a **demote-on-red rollback path** (fleet-wide revert of a bad skill-pack/prompt version + auto-revert of a bad learned behavioral bias).
- **Depends-on:** Phase 1 (behavioral-learning + skills-ingress specs); Phase 2 (the inbox as the surface).
- **Maps-to:** #678 (compound harness), FUNC-AC-LEARNING, #687.

### Phase 4 — Close the SDLC role gaps
- **Goal:** all roles enforced, not just designed.
- **Produces:** wire the already-designed personas as **enforced gates**; the **compliance gate** (nothing blocks a the confidentiality statute PR today → something does) — via a 5th auto-claude gate and/or acme's `auto-merge-gate.yml`/`risk-classify.yml`; **holdout mandatory post-warmup**; browser/E2E via the `qa-reviewer` capability; **SRE/observability** (the weakest role) with unified telemetry across the two daemons + stores.
- **Depends-on:** Phase 1 (compliance-gate spec); the skills-ingress from Phase 3 (the persona→gate bridge is the shared blocker).
- **Maps-to:** #679 (risk-class), #684 (adversarial mandate), #680/#681 (deploy + smoke), the 100x persona team + Compliance Lane.

### Phase 5a — acme bug pilot (can start once Phase 2's seam exists)
- **Goal:** prove the filter-and-steer loop on low-risk acme work, fully human-gated.
- **Produces:** **canary on a low-stakes repo BEFORE acme** (auto-claude itself or a throwaway); then acme registered in the `repos` table; **bugs only** (uses acme's existing `review-finding`/`P0-P3`/`auto-fix-approved` labels — no `.specify` tree needed); **every merge human-gated, even GREEN** (trust earned, not granted). Pauses flow to the inbox via #685 (delivered in Phase 2).
- **Depends-on:** Phase 2 (the escalation seam) — the only blocker. **#679 risk-class is NOT required for 5a:** every 5a merge is human-gated, so nothing auto-merges and the risk-class gate isn't gating anything yet (it may still *label* for triage). Runs in parallel with Phases 3–4. **A proving ground whose findings feed Phase 3–4 hardening and later spec revisions** (Phase 1 is already complete before 5a runs).
- **Maps-to:** #677 epic, #681 (E2E smoke).

### Phase 5b — full scale
- **Goal:** spec-driven features on acme + multi-project.
- **Produces:** graduate acme from human-gated to GREEN/YELLOW auto-merge (per §6) **once gates are proven green on the 5a pilot**; spec-driven features; then auto-claude on itself; then other projects. Bounded isolation per deployment; the inbox the only cross-deployment surface.
- **Depends-on:** Phases 3–4 (the loops + gates) + a green 5a pilot.
- **Maps-to:** #677 epic, #680 (deploy pipeline), #679 (risk-class gate — enables the auto-merge graduation).

## 9. Forks deferred into the Phase-1 spec (decided there, not now)
Per unify-spec-first, these are resolved *in* the unified L0/L1 authoring:
1. **Persistence:** unify on one store or keep dual (engine Postgres + cockpit SQLite)? Now a pure engineering choice (D3 removed the PHI mandate).
2. **Attention-surface reconciliation:** which of concierge / inbox / dashboard becomes the one primary; what the others become.
3. **Canary topology + enforcement primitive:** content-site-gates-acme is structurally weak (content-site has no PHI paths); options — coded ordering gate, a acme shadow/staging canary, or per-change-class routing. Must also fix the *current* fleet-instant sync.
4. **Compliance enforcement shape:** 5th auto-claude gate vs. ship acme's CI gates vs. both — sharing the same blocker (the agent-skills→worker ingress bridge).
5. **Promote-a-mistake → prose or guard:** advise (docs) vs. prevent (auto-propose a test/lint/CI-guard on ≥N recurrence).
6. **Behavioral-learning guardrails:** the exact never-auto-decide set + the graduated-autonomy rungs.

## 10. Risks
- **Touching the round-1..10-hardened cores** (cockpit outbox/state-machine; auto-claude control-plane). Mitigation: additive, spec-gated, full invariant suites stay green.
- **Scope:** this is a multi-quarter program. Mitigation: each phase ships independently and is independently valuable; bugs-on-acme (Phase 5a) can start once Phase 2's seam exists, in parallel with later phases.
- **Two autonomous systems on acme** (auto-claude + its GOAL.md loop): must never claim the same issue (label discipline) and their worktree systems must not collide.
- **Cost under a larger fleet:** more autonomy multiplies LLM spend → **owned by Phase 3** (per-deployment budget binding in the fleet-registry).
- **Meta-system rollback:** a bad skill-pack/prompt change must be demotable fleet-wide (demote-on-red) and a bad learned bias auto-revertable → **owned by Phase 3** (fleet-registry rollback path).

## 11. Open prerequisite (needs the Operator's ruling)
**Branch model.** `dev` is ~27 behind `main`; production lands on `main`; CLAUDE.md says push-to-`dev`; the #685 L1 is stranded on `dev`. **Recommendation: retire `dev`, autonomous loop targets `main` with PR-gated merges, update CLAUDE.md + the autonomous-operating-mode section, and cherry-pick/forward the #685 L1 onto `main`.** Changes the autonomous model → the Operator's call. Blocks Phase 0.

## 12. Success criteria
- the Operator interacts primarily through the dashboard; routine pipeline churn never reaches him; only genuine decisions (ORANGE/RED, L1 suggestions, ambiguous findings) surface.
- auto-claude autonomously lands GREEN/YELLOW PRs on acme; the Operator reviews ORANGE/RED only.
- A recurring mistake is structurally prevented from recurring (promoted to a guard) within bounded time.
- The system asks the Operator measurably less over time for predictable decision-classes, with the L0 guardrails never crossed.
- Every superseded planning artifact is explicitly marked; the canonical spec has no live contradictor.
- the Operator's attention concentrates on each deployment's ROT (the irreducibly-human work).
- **Multi-project:** adding a project is a deployment-registry entry, not a fork; the inbox surfaces decisions across deployments with bounded isolation (focus-gated), and each deployment carries its own profile (risk-rules, compliance set, budget, canary slot).
