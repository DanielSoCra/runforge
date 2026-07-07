---
date: 2026-06-10
revised: 2026-06-11
status: superseded
superseded_by: docs/superpowers/specs/2026-06-11-runforge-vnext-masterplan-design.md  # v2; Layer-A/B split + Appendices A/B carry forward by reference
type: design-spec
topic: Regulated Pilot Deployment Autonomy Masterplan — operating runforge's first configured deployment (the regulated pilot) + the multi-model cost layer
authors: the Operator (lead) + Claude (synthesis)
reads_down_from:
  - .specify/L0-ac-vision.md  # L0-AC-VISION v5 (Operator-approved, PR #697)
  - .specify/functional/  # FUNC-AC-PIPELINE, -OPERATOR-LEARNING, -COMPLIANCE-GATE, -FLEET, -DECISION-ESCALATION
related:
  - docs/superpowers/specs/2026-05-29-unified-cockpit-roadmap.md  # superseded; framing ancestor ("configured deployments, not bespoke builds")
  - the knowledge vault docs/superpowers/specs/2026-05-23-pm-cockpit-design.md  # cockpit decision-lifecycle v1
  - runforge issues #677–684 (deployment-ready execution track), #685–689 (cockpit steering track)
  - runforge PRs #703 (DecisionRequest/Response live), #707 (roleModels), #708/#709/#715 (subscription auth + container daemon)
supersedes: []
---

# Regulated Pilot Deployment Autonomy Masterplan — Design Spec

> **One-line goal:** make runforge autonomously develop **the regulated pilot deployment (deployment #1)** under the Operator's intended workflow — where the pilot is *deployment #1 of a project-agnostic platform, a configured deployment and not a bespoke build*, and the Operator steers as CPO (L1 authoring + production-release approval) while everything below runs autonomously.

## 1. Framing — the spine of this whole plan

runforge is the **engine**: a generic, repo-agnostic autonomous SDLC pipeline (detect → classify → decompose → implement → review → holdout → integrate → deploy → test → report), governed by the Operator-approved L0-AC-VISION v5 and its L1 children in `.specify/`. **The engine never learns it is building a regulated application.** It runs the same pipeline it runs on itself.

"the pilot is a regulated application" is expressed in exactly **two places, neither of which is engine infrastructure**:

1. **The regulated pilot's deployment config** — its branch model, label taxonomy, and which code paths are high-blast-radius.
2. **The agents/skills selected for the pilot's runs** — including a secure-coding skill and a security-review agent, because the *pilot application* handles sensitive data at runtime and therefore its **code must be written securely**. That is a property of the target codebase, enforced by the agents writing it — the same discipline any competent dev team applies, automated. It has nothing to do with the daemon, the risk gate, or model routing.

This split is the organizing structure of the plan:

| Layer | What it is | Where it lives |
| :--- | :--- | :--- |
| **A — the engine** | Generic pipeline, risk gate, PO front-door, decision protocol, multi-model routing, runtime | `runforge` core (governed by `.specify/` L0/L1) |
| **B — the regulated pilot deployment** | Onboarding, per-repo risk-path config, the pilot's agents/skills, the pilot's `.specify` tree | the pilot's platform repo + per-repo config (NOT runforge core) |

Everything that follows is filed under A or B. If a proposed change would teach the engine a regulated-domain fact, it is misfiled — it belongs in B.

### 1.1 Operator role (retained, not automated)

The Operator = **CPO**. Two retained gates, everything else autonomous:

- **(a) L1 spec content** — authoring/approving functional intent.
- **(b) Production releases** — deploy-from-`main` is the Operator-approved event.

Plus (c) destructive ops outside the pipeline's normal mutation set. Pushing feature branches, opening PRs, closing issues, label ops, GREEN/YELLOW auto-merge — all autonomous (per the repo's autonomous-operating-mode charter).

### 1.2 Explicitly resolved / retired in this session

- **Model-routing data-residency constraint → retired.** Code is free of regulated/sensitive data; routing it to the cheapest capable model (Kimi K2.6 / DeepSeek V4 via OpenRouter) is outside regulated-domain compliance scope (rationale: §7 + Appendix B). This is the default for *every* deployment, the regulated pilot included.
- **IP/exfiltration conservatism → retired.** For a 1-dev pre-PMF company, time-to-market risk dwarfs codebase-exfiltration risk by orders of magnitude. Not an architectural constraint.
- **External deadline urgency → not applicable here.** Other entities' timelines are their own. The regulated pilot runs on its own pace; do not import outside urgency.
- **Self-hosted/EU fine-tuning + serving stack → deferred & parked** (Appendix A), revived only on a real cost signal or a specific customer contract — not as a compliance requirement.

## 2. Current state → the gap set

**Proven / live:**
- The engine runs autonomously on itself; DecisionRequest/DecisionResponse protocol is **live** (PR #703).
- Multi-repo is architected and ready: `RepoManager` polls per-repo from Postgres (`repos` table, `POST /upsert-repo`, per-repo tokens via `connection_id`, automatic phase-label provisioning).
- Per-role model config exists: `roleModels` (PR #707) — provider / providerBinding(preferred+fallback) / model / modelTier, with adapters `cli.ts` (Claude Code) + `codex-cli.ts` (Codex).
- Unattended 24/7 runtime: subscription-auth creds-sync + docker autostart (PRs #708/#709/#715).
- Governance: L0-AC-VISION v5 + L1s (`FUNC-AC-OPERATOR-LEARNING`, `-COMPLIANCE-GATE`, `-FLEET`, `-DECISION-ESCALATION`) Operator-approved in `.specify/`.

**The gap is NOT "teach runforge the regulated domain."** It is: onboard a second deployment and give it the right config and agents. Concretely missing —
- the regulated pilot not onboarded (no poller, no labels, no token wired);
- the risk gate needs a clean **per-repo path→class config surface** (so the pilot's rules are config, not engine code);
- the **PO front-door** (raw idea → spec-linked ready ticket) is not built;
- **no e2e proof on a second repo** (engine portability unproven outside itself);
- the **multi-model cost layer** is configured-but-not-wired to a cheap provider;
- the pilot has **no `.specify` tree** and its **own label taxonomy**.

## 3. Layer A — the engine (generic, repo-agnostic)

Phased. Sequencing in §8. Each phase states intent + exit criteria. **None of these phases contains a regulated-domain fact.**

### Phase 0 — Runtime
Stand up the 24/7 daemon as the durable host for all deployments (the macOS host or container per #708/#709/#715). Resolve the open "where does the daemon run" question (a dev laptop is not it). 
**Exit:** daemon runs 24/7, survives host restart, health endpoint green, polls ≥1 repo from Postgres.

### Phase 1 — Risk gate as a configurable mechanism
The earned-trust ramp (GREEN/YELLOW/ORANGE/RED) and compliance gate already exist (`FUNC-AC-COMPLIANCE-GATE`). This phase ensures the gate reads its **path→risk-class map from per-repo config**, not from engine hardcode. GREEN+YELLOW auto-merge from day 1 (Operator decision); ORANGE/RED → `DecisionRequest` to the Operator. **Risk class = blast radius (cost of being wrong in prod), independent of data-sensitivity.**
**Exit:** a repo can declare its own path→class map; a GREEN change auto-merges through the gate; an ORANGE change raises a `DecisionRequest`. No domain rules in engine code. (Ties off #679 / #684.)

### Phase 2 — E2E smoke on a second deployment (#681)
Drive one real pilot issue end-to-end through the live pipeline on a non-sensitive surface, proving the engine is portable beyond itself.
**Exit:** green e2e run on the regulated pilot; PR merged via the gate; report emitted.

### Phase 3 — PO front-door
Build the cockpit's PO intake: **po-draft** (shape a raw idea into a spec-linked ticket) → **batched `DecisionRequests`** → **ready queue**. GitHub-only surface (Operator decision). Focus-gated admission; full backlog ownership. The canary for any risky PO behavior is **a canary deployment, never the regulated pilot**.
**Exit:** a raw GitHub issue is PO-shaped into a ready, spec-linked ticket, with the Operator approving batched decisions rather than per-item.

### Phase 4 — Compounding (#678 + #680 + #696)
Compound autonomous runs (#678); optional deploy-verify (#680); multi-repo polish (#696 — fairness across pollers, per-repo budgets).
**Exit:** multiple issues compound autonomously across ≥2 repos without Operator micro-steering.

### Phase 5 — External-effect lane
A runbook lane for infra / external-effect operations (deploys, DNS, provisioning), each step gated by a `DecisionRequest`. **Requires a new L1** (`FUNC-AC-EXTERNAL-EFFECT` or equivalent) — Operator-authored.
**Exit:** an infra runbook executes step-gated, with each external effect individually approvable.

## 4. Workstream M — Multi-model cost layer (Layer A; generic)

The economic thesis (validated in the Manus harness report): frontier models for planning + adversarial review, cheap open-weight models for implementation. Even at 4× the iterations, a 10× cheaper implementer wins on cost and unlocks parallelism. **Applies to every deployment; model choice is unrestricted because code is free of sensitive data.**

- **M1 — OpenRouter gateway.** Wire OpenRouter as a provider binding via the existing `codex-cli` adapter (OpenAI-compatible → OpenRouter base URL). The Operator already holds the key. This is a *small* config addition to `roleModels` (#707), not a new subsystem.
- **M2 — Routing matrix.** Default: **frontier plan → cheap implement (Kimi K2.6 / DeepSeek V4) → frontier review**. Simple/GREEN tasks: **cheap implement → frontier review only** (skip the frontier plan; lean on good harness prompts + the adversarial review sensor). Per-role via `roleModels`.
- **M3 — Failover ladder.** On provider error / rate-limit: **Kimi → DeepSeek → Sonnet → Opus**, plus **rate-window-aware scheduling**. *(Worked example, this very session: the deep-research fan-outs that produced this doc exhausted the Claude Max 5-hour window — the exact failure mode M3/M5 exist to absorb. Cheap-provider offload + window awareness keeps the pipeline live when the frontier window is spent.)*
- **M4 — Cost/iteration telemetry.** Track `$/task` and `iterations-to-green` per model per role. Validate the cheap-model thesis empirically and promote/demote routing on data, not vibes.
- **M5 — Token hygiene.** Cache protection (no mid-session model/tool churn), proactive compaction discipline, progressive disclosure of rules (keep them out of the system prompt).
- **M6 — Improvement layer.**
  - **M6.1 — Capture, now.** Persist `(review-correction → accepted-fix)` pairs to Postgres from every review cycle. Cheap (it's logging), vendor-independent, and the **one durable asset** — every managed player in this space has died or pivoted within 18 months.
  - **M6.2+ — Fine-tune & serve, deferred.** Standing up a training/serving pipeline (even managed) is MLOps a 1-dev team should not carry pre-PMF, and the routing win (M2) captures most of the value with zero MLOps. The full self-host/EU serving research is **production-ready and parked** in Appendix A — revived only when M4 shows a cost signal *and* there is slack to run it. Data-residency is **not** the driver.

## 5. Layer B — the regulated pilot deployment (config + agents)

Lives **with the pilot** (its repo + per-repo config), never in engine core.

- **B1 — Onboard.** `POST /upsert-repo`, per-repo token via `connection_id`, reconcile the pilot's **own label taxonomy** against the engine's phase-label mirror.
- **B2 — Risk-path config.** The pilot *declares* its path→class map and feeds it into the Phase-1 gate: `sensitive-data-schema/`, `auth/`, `billing/`, migrations → **ORANGE** minimum (high blast radius); `secrets`, deploy config, CI workflows → **RED**; unknown paths → **ORANGE** (conservative default). This is pilot config consumed by a generic mechanism — not engine hardcode.
- **B3 — Agents / skills.** The pilot's runs select a **secure-coding skill**, a **security-review agent**, and a **synthetic-test-data rule**. Rationale: the *pilot application* handles sensitive data at runtime (dedicated encrypted data schemas, an `llm-pseudonymizer` before any LLM call), so its code must be written and reviewed for that — application security, enforced at the agent layer. This is the "what agents we need" surface; it is independent of the engine and of model routing.
- **B4 — `.specify` seeding** → see Workstream S.

## 6. Workstream S — `.specify` seeding (the pilot repo)

The pilot has no spec tree. Seed it, in dependency order, using the guardian skills:
- **L0** — the pilot's domain vision (the regulated entity separate from the billing/IT entity).
- **L1s** — core functional specs via `l1-spec-guardian`. **The Operator approves L1 content** (the Operator's retained gate).
- **L2/L3** — authored as features land; **do not pre-write L3 `code_paths`** to files that don't exist yet (CI fails on missing `code_paths`).

These specs govern the **pilot application**, in the **pilot repo** — not the engine.

## 7. Data handling (the resolved debate, tight)

**Code routes freely to any model.** Rationale (verified against the regulated domain's compliance requirements — Appendix B):
- **Regulated-domain confidentiality rules** are triggered only by disclosing a protected secret obtained in a professional capacity. Sensitive-data-free source code contains no such secret → the rule is not engaged.
- **Data-protection law** engages only when the transmitted payload **is** personal data; sensitive-data-free code is not personal data, so transmitting it to an external processor is not "processing of personal data" — **conditioned on the actual payload**, not a blanket rule.

The safe harbor is **conditional on three guards** — all Layer-B agent/CI rules, already required:
1. **Synthetic test fixtures only.** A fixture seeded from a real production table puts sensitive data in the payload.
2. **No production data in runtime capture.** Logs, DB dumps, and stack traces produced during test runs must not contain real identifiers.
3. **No secrets / production credentials in the payload — load-bearing.** For *digital* secrets, **access capability alone** can complete the confidentiality breach: shipping credentials that grant control over a sensitive-data store triggers the regulated-domain rules even with zero sensitive data in the bytes. Therefore `.env`/credentials are never transmitted, and **CI/agents have no production-data access**.

**EU-residency** is a contractual/DD lever only (a future customer contract could demand it), never a statutory requirement here. It remains a **dormant switch** — the parked self-host/EU stack (Appendix A) can be enabled per-deployment if a contract ever requires it, with no re-architecture.

## 8. Sequencing & dependencies

**Trust-first** (Operator decision): close Phase 0 → Phase 1 before opening the cheap-model floodgates, so the gate is proven before volume rises.

- **Critical path:** Phase 0 → 1 → 2 → 3 → 4.
- **Parallel to the critical path:** Layer-B onboarding (B1–B3), Workstream S, and Phase 5's new L1 authoring.
- **Workstream M:** M1 + M2 land early (they make every run cheaper); M3–M5 follow; **M6.1 capture can start anytime** (independent, cheap).

```
0 Runtime ──▶ 1 Risk-gate ──▶ 2 E2E(#681) ──▶ 3 PO front-door ──▶ 4 Compounding
                  ▲                                   
   B1–B3 pilot onboarding ─┘ (parallel)            
   Workstream S (.specify) ── (parallel) ── the Operator approves L1s
   Workstream M: M1,M2 early ─ M3–M5 ─ M6.1 capture (anytime)
   Phase 5 L1 authoring ───── (parallel) ──▶ 5 External-effect lane
```

## 9. Open questions / risks

- **Daemon location** (resolved by Phase 0) — confirm the durable 24/7 host.
- **Pilot label-taxonomy reconciliation** — map the pilot's existing labels onto the engine's phase labels without collision.
- **Phase 5 new L1** — `FUNC-AC-EXTERNAL-EFFECT` must be Operator-authored before the external-effect lane is built.
- **M2 routing thresholds** — need M4 telemetry to tune the GREEN-vs-complex split; start conservative, adjust on data.

## 10. Out of scope (YAGNI)

- EU / self-host serving as a routing constraint (dormant switch; §7 + Appendix A).
- Fine-tuning / serving pipeline (deferred; M6.2+).
- Pioneer.ai and managed improvement-layer vendors (parked; Appendix A).
- **Any regulated-domain logic inside the runforge engine** (Layer A stays generic — by construction).

---

## Appendix A — Parked improvement-layer research (for when M6.2 revives)

Verified (deep-research, June 2026), production-ready and ready to lift when a cost signal justifies it:
- **Serving:** mainline **vLLM** is the production-ready successor to the now-unmaintained LoRAX — many LoRA adapters concurrently behind one OpenAI-compatible endpoint (`--enable-lora/--max-loras`), **runtime hot-swap** via `POST /v1/load_lora_adapter` (gated by `VLLM_ALLOW_RUNTIME_LORA_UPDATING`; trusted-network only). **NVIDIA Dynamo** is the hardened multi-replica routing upgrade in front of vLLM.
- **Training:** **Unsloth/Axolotl** LoRA at 8B–32B; Unsloth→vLLM adapter path works for Qwen/Mistral/Llama — **must smoke-test each loaded adapter changes output** (silent-ignore `target_modules` bug class).
- **Economics (EU, if ever needed):** Hetzner **GEX44 ≈ €184/mo** (always-on 8B serving), **GEX131** or **Scaleway L40S @ €1.47/hr** (periodic fine-tune).
- **Managed-EU fallback:** **Scaleway Generative APIs** (strongest verified posture — Paris-only, ZDR, no-train, outside Cloud Act, SecNumCloud) for inference; **Nebius Token Factory** / **OVHcloud ML Services** for fine-tune (contract-gated — Nebius EU-residency + LoRA-output **unconfirmed**, verify before any sensitive use).
- **Dead ends:** OpenPipe platform (deprecated 2026-07-30 → W&B); LoRAX (Apache-2.0 but unmaintained since Nov 2024). OpenPipe's **ART** (Apache-2.0) survives as OSS.

Full cited research outputs: deep-research runs `wf_c74a9f55-cd4` (OSS/EU stack) and the prior Pioneer.ai verification.

## Appendix B — Regulated-domain compliance basis

Deep-research run `wf_34506524-809` (99 agents; 22+ confirmed claims; primary sources). Headline confirmations, all pointing the same way — routing sensitive-data-free source code to external model providers is outside the regulated domain's confidentiality and data-protection rules:
- The regulated-domain confidentiality rule is triggered only by disclosing a protected secret obtained in a professional capacity; no secret in the payload → no breach.
- There is a lawful, necessity-limited pathway to involve external IT/AI providers *even when* a secret would be exposed, conditioned on necessity + a binding secrecy obligation.
- For **digital secrets**, access capability alone can complete the breach → guard #3 in §7 is the compliance safe-harbor condition, not mere hygiene.
- **Data-protection law:** non-personal-data transmission is not "processing of personal data"; conditioned on the actual payload, not a blanket "code is never personal data."
- **EU-residency** demands are contractual/DD-driven, not statutory.

Full chain: `tasks/wtgwujnyk.output`.
</content>
</invoke>
