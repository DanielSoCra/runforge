---
date: 2026-06-11
status: draft-for-review
type: design-spec
topic: runforge v-next masterplan — single interface, lane engine, model ladder, the regulated pilot
authors: the Operator (lead) + Claude (synthesis)
supersedes:
  - docs/superpowers/specs/2026-06-10-regulated-deployment-autonomy-masterplan-design.md  # v1; its Layer-A/B split, regulated-domain compliance basis (App. B) and parked improvement-layer research (App. A) carry forward by reference
reads_down_from:
  - .specify/L0-ac-vision.md  # L0-AC-VISION v5 — this plan proposes L0 deltas (§2.1) via DecisionRequest, never auto-edit
  - .specify/functional/  # FUNC-AC-PIPELINE, -MERGE-DECISION, -COMPLIANCE-GATE, -OPERATOR-LEARNING, -FLEET, -DECISION-ESCALATION
evidence:
  - deep-research wf_e55a1fc6-286 (Superset + a comparable orchestration system, internals 3-0 verified)
  - deep-research wf_c74a9f55-cd4 (OSS/EU improvement layer — parked)
  - deep-research wf_34506524-809 (regulated-domain compliance basis for unrestricted model routing)
  - system map wf_e0624a2c-bdb (7-subsystem code-level state, 2026-06-11)
---

# runforge v-next Masterplan

> **One-line goal:** runforge becomes the Operator's **single development interface** — replacing the manual tool zoo (Claude Code sessions, Superset, pi, opencode, codex) with a minimal inbox + drill-down + mid-flight intervention — running **completely stable**, implementing **the regulated pilot's** tasks, and exploiting **model tiers + subscriptions** through configurable lanes.

## 0. What changed since v1 (2026-06-10)

v1 designed the-regulated-pilot-as-deployment-#1 on the engine-vs-deployment split. This v2 **extends, not replaces** that thinking with four session outcomes:

1. **The interface goal is now primary.** Not just "operate the regulated pilot" — *replace the operator's whole multi-tool workflow*. Interaction model locked: **ticket-first + mid-flight intervention** (no terminal hosting).
2. **Orchestration topology is now evidence-locked** (Superset + a comparable orchestration system source-verified): daemon + Postgres control plane + **ephemeral CLI spawns**; GUI reads Postgres + git, never CLIs; **no long-lived RPC/SDK embedding** — neither shipped system chose it. Three missing mechanisms identified: session resume, git-derived state, queue-delivered operator notes.
3. **The lane engine** (Operator decision, 2026-06-11): workflows are **fully configurable data** — classifier → routing → gates → merge policy per lane — bounded by one non-configurable tripwire (diff-vs-declared-scope; per-repo risk paths escalate-only). Subsumes #679's risk-class work.
4. **Subscription inventory confirmed:** Claude Max 20x + ChatGPT Pro + OpenRouter key (+ Cursor, parked). Dual-frontier-pool, window-aware scheduling becomes design, not aspiration.

## 1. Vision (end state)

The Operator writes ideas into a **minimal inbox** (GitHub issue or quick capture). The system shapes, classifies into a **lane**, implements with the cheapest capable model, gates per lane policy, and merges or escalates. The Operator sees: decisions needing the Operator + a daily briefing — *by default nothing else*. When the Operator wants depth: drill-down per run (live git diff, phase status, cost) and **operator notes** that redirect a run at its next phase boundary. The regulated pilot is deployment #1; runforge itself is deployment #0; the engine stays repo-agnostic (v1 Layer-A/B split unchanged).

**Operator-retained gates (unchanged):** L1 spec content · production releases · destructive ops outside the pipeline's mutation set.

## 2. Locked architecture decisions

| # | Decision | Basis |
|---|---|---|
| D1 | **Hybrid runtime (C):** Claude Code (`cli.ts`) keeps frontier roles + proven containment; **pi joins as a process adapter** (reserved `pi-cli` kind) for the cheap tier — spawn+resume model, the same way the comparable orchestration system runs pi. No RPC embedding. | Brainstorm + wf_e55a1fc6 |
| D2 | **Ephemeral spawn + session resume** replaces fresh-context-per-phase: persist CLI session IDs per run (`claude --resume`, `codex exec resume`, pi equivalent); fix-cycles and follow-on phases resume. | comparable-system-verified token mechanism |
| D3 | **Git-derived dashboard state:** drill-down diffs/status come from per-run worktrees via git plumbing + thin notify hooks — never transcript parsing. | Superset-verified |
| D4 | **Mid-flight intervention = operator notes at phase boundaries**, delivered via the existing etag-bound decision transport / wakeup queue + run verbs (pause/redirect/abort). No raw mid-token injection. | Brainstorm + both systems' revealed preference |
| D5 | **Lane engine:** lanes are declarative config (classifier → model routing → gate set → merge policy → optional post-merge batch review). **Invariant (non-configurable):** lane `allowed_paths` verified against the actual diff; per-repo risk-path map escalates only, never mutes. Protects against *classifier* error, not operator policy. | Operator decision 2026-06-11 |
| D6 | **Declarative role registry (Tier 2):** lift `DEFAULT_AGENT_DEFS` into data (role = prompt file + tools + budget + tier defaults); per-phase role assignment incl. parallel reviewers. **Tier 3 seam:** FSM transition tables stay pure data, loadable from config — node-based workflow UI (Archon-style) is a deferred UI layer, not a rewrite. | Operator requirement: define roles/workflows without code |
| D7 | **Model routing stays unrestricted** (sensitive-data-free code; regulated-domain compliance basis v1 App. B). Default ladder: frontier plan → cheap implement (Kimi K2.6 / DeepSeek V4 / Flash-tier per lane) → frontier review. Three payload guards (synthetic fixtures, no prod capture, no credentials) live in Layer B / CI. | v1, re-confirmed |
| D8 | **M6.1 correction-pair capture now; fine-tuning/serving deferred** (research parked in v1 App. A). | v1 |
| D9 | **Two-layer model.** Layer 1 = deterministic orchestration: heartbeats/wakeup queue, lanes, gates, tripwire, budgets, FSM — rules, fully data-driven, no LLM judgment. Layer 2 = **intelligent steering**: heartbeat agents (PM/PO/tech-lead) that scan inputs (GitHub, cockpit inbox, ideas) and route fuzzy work into Layer-1 workflows ("spike idea → research agent → tech-lead consult → back to operator inbox"). `po-agent.ts` + `tech-lead-scheduler.ts` are the embryos — they become the first steering agents, redefined as data. | Operator 2026-06-11; pattern validated by the comparable orchestration system; Cloudflare AI-code-review (deterministic risk tiers + coordinator judgment) |
| D10 | **Mechanism vs policy.** Anything expressible as routing, threshold, assignment, or schedule (which model reviews, pool preference, which CLIs are wired, post-merge-net defaults, earn-in thresholds) ships as **editable config in a preconfigured default pipeline** — never as code, spec decision, or operator question. Specs cover mechanisms only. Runtime config control plane allows changes without deploys (Cloudflare pattern: per-reviewer model overrides via KV). | Operator 2026-06-11 |
| D11 | **Agent = data bundle, pipelines = config packs.** An agent is role definition + tools + skills + `soul.md` + budget (composition pattern from the comparable orchestration system), in the declarative registry (extends D6). A complete pipeline configuration — lanes + agents + souls + gate sets + steering policy — is packaged as a versioned, swappable **config pack** in the existing plugin system (which already carries skills/agents/MCPs; extend to lanes + steering). Cloudflare's `ReviewPlugin` lifecycle (bootstrap/configure/postConfigure, contribute-via-context-API) is the reference shape. | Operator 2026-06-11; blog.cloudflare.com/ai-code-review |

### 2.1 L0/L1 impact (Operator gate)
"Single interface replacing the operator's tool zoo", "lanes as configurable policy", and the **platform thesis — runforge is a system that lets you build systems on top** (D9–D11) — extend L0-AC-VISION v5's framing. The spec-writing goal run (§5) must surface these as **proposed L0/L1 amendments via DecisionRequest** — never auto-edit vision.

### 2.2 Platform positioning (build vs buy)
- **pi is a component, not the system.** One agent, one session, four tools, extensions, RPC — no tickets, heartbeats, gates, multi-agent, or memory across runs. Proof point: Cloudflare's AI-review system is built **on top of opencode** — the harness was the runtime; all value lived in the layer above (plugins, config control plane, risk tiers, coordinator). pi gives runforge what opencode gave Cloudflare. Role stays D1: cheap-tier worker runtime.
- **A comparable orchestration system is the closest existing "system on top"** and validates D9 wholesale (heartbeats, souls, ticket-mediated delegation). What it lacks is everything that makes unattended *software delivery* safe: no SDLC pipeline/FSM, no validation ladder, no risk lanes/tripwire, no spec governance, no earned-trust ramp, no holdout, no window-aware multi-subscription scheduling. It is a pattern donor + watchlist item — not a control-plane dependency (3 months old, single pseudonymous maintainer; not a foundation under client work).
- **runforge's moat** = the trust machinery (gates, lanes, tripwire, earned autonomy, decision protocol) + spec-driven governance (auditable L1→L3) + composability (lanes/agents/souls/config-packs as data) + an operator surface built for one person steering many systems. The orchestration plumbing is commodity — adopt its patterns shamelessly, own the control plane.

## 3. Phases — reconciled with the open backlog

Critical path ①→⑤; parallel tracks marked ∥. Open tickets mapped in place.

**P0 — Stabilize (now, before anything else)**
Merge the 5 in-flight fix branches (decision-transport, resume-consumer, reviewer-workspace-path, daemon-creds, l2-designer-paths); guard #714 (resumeParkedRuns re-entrancy + merge stash race); resolve daemon host (the macOS host vs container; PRs #708/#709/#715 give the runtime). Begin the **stability soak** (bar = open decision Q4).
*Exit:* branches merged, flakes guarded, daemon 24/7 on its durable host, soak clock running.

**P1 — Trust: lane engine v1 + adversarial review (#679 ⊂ lane engine, #684)**
Implement the merge-decision gate as the **lane engine** (D5): lane config schema, classifier verdict + diff-vs-scope tripwire, per-repo risk-path maps, gate-set selection per lane, auto-merge for qualifying lanes. #684 adversarial-mandate injection into reviewer seeds. Initial lane set: `standard` (full ladder) + `trivial` (gate1-only, auto-merge) on runforge itself.
*Exit:* a trivial change auto-merges through a lane; an out-of-scope diff gets bounced up; ORANGE/RED still raises DecisionRequests.

**P2 — Model ladder + efficiency (Workstream M concretized)**
pi process adapter (D1) driving OpenRouter (Kimi/DeepSeek) + ChatGPT-Pro OAuth; dual-frontier-pool window-aware failover (Q1); **session resume** (D2); explicit model→tier mapping (fixes the string-match heuristic); M4 cost/iteration telemetry per lane+model; M6.1 capture.
*Exit:* a real issue runs frontier-plan → pi/Kimi-implement → frontier-review under budget telemetry; Claude-window exhaustion fails over instead of stalling.

**P3 — the regulated pilot live (v1 Layer B + #680, #681)**
∥-prepared during P1–P2: B1 onboarding (upsert-repo, token, labels), B2 the pilot's risk-path config, B3 secure-coding/security-review agents, Workstream S `.specify` seeding (L1s = Operator-approved). Then: e2e smoke #681 through the live pipeline; #680 deploy-verify; the pilot's `standard` lane GREEN/YELLOW auto-merge (fast lanes per Q6).
*Exit:* the pilot's issues flow ticket→merged-PR unattended within lane policy.

**P4 — Single interface (after stability bar; Q2)**
Fold the cockpit consumer into the runforge dashboard (kills the contract-drift class); **minimal inbox** (decisions + briefing) as default surface; drill-down per run (D3 git-derived live diffs, phases, cost); **operator notes + run verbs** (D4); #682 knowledge-approval UI. Retire Superset + manual CLI sessions for pipeline work.
*Exit:* a full week where the Operator steers exclusively from the inbox; Superset uninstalled or idle.

**P5 — Compounding & scale**
#678 compound-from-merge; #683 holdout framework; role registry completion (D6) + per-repo fast lanes earned from telemetry; PO front-door full backlog ownership (v1 Phase 3 semantics); fleet polish #696.
*Exit:* multiple repos compound autonomously; new lanes/roles added by config only.

## 4. Workstreams (revised from v1)

- **M (model economics):** M1 = pi adapter + OpenRouter binding (replaces v1's codex-cli-env-var plan — brittle, no `--api-base`). M2 = routing matrix *per lane* (lanes subsume the GREEN-vs-complex split). M3 = failover ladder + **rate-window-aware scheduler** across both frontier pools. M4 = `$/task`, `iterations-to-green`, *which pool reviewed each merge* (review-quality drift detection). M5 = token hygiene + session resume. M6.1 = capture; M6.2+ parked.
- **S (the pilot's `.specify` seeding):** unchanged from v1 — L0 two-entity vision, L1s via guardian skills, the Operator approves; L2/L3 as features land; no phantom code_paths.
- **G (the spec-writing goal run):** see §5. Specs before code for everything in P1–P4 that lacks them (lane engine, pi adapter, resume, notes, interface fold, role registry).

## 5. The /goal run — specs only, no implementation

The next concrete artifact is a **goal-command prompt** that spawns a spec-writing run on this repo: full L1 coverage for the v-next scope (amend FUNC-AC-MERGE-DECISION → lane engine; new L1s: runtime-adapters/session-resume, operator-notes/intervention, single-interface, role-registry; rate-window scheduling into FUNC-AC-FLEET or new), L2/L3 depth per decision Q3, traceability updated, L0 deltas → DecisionRequests, guardian skills mandatory, **zero implementation**. Prompt text finalized after the decision brief is read back (it encodes Q1–Q6).

## 6. Open decisions — collapsed per D10 (2026-06-11)

The original Q1–Q8 brief over-asked: most were **policy**, not design. Resolution:
- **Q1 pools, Q5 Cursor, Q8 defaults → default-pipeline config** (D10). Shipped values: dual-pool window-aware failover Claude-preferred; Cursor unwired (adapter interface is generic — wire later by config+adapter); nightly batch review ON for auto-merge lanes; the pilot's fast lanes earn in (20 clean merges + 7d zero bounces). All editable at runtime, none architectural.
- **Q3 goal depth → follows from D10**: spec mechanisms only; L2/L3 where implementation is imminent (P1+P2).
- **Q6 → lane engine directly** (supersede #679; no throwaway — Operator's standing preference). **Q7 → pi adapter directly** (no bridge plumbing). **Q2 → fold after stability bar** (sequencing default).
- **Q4 stability bar — the one remaining Operator decision**: default 7 unattended days + a canary deployment + e2e #681 ×2 + zero manual rescues before the regulated pilot's GREEN/YELLOW. Confirmed inline unless vetoed.

## 7. Out of scope (unchanged + new)

v1 list (EU/self-host as constraint; fine-tuning pipeline; Pioneer; regulated-domain logic in engine) **plus:** terminal hosting / PTY panes in the dashboard (Superset's job — explicitly not ours); long-lived RPC/SDK agent embedding (anti-pattern per evidence); node-based workflow UI (Tier 3 seam only); direct agent-to-agent messaging (tickets + artifacts only, comparable-system-validated).
