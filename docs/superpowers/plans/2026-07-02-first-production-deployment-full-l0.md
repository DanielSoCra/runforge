# First Production Deployment (Regulated Pilot) — Full-L0 Program Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. This is a **program plan**: each phase below is a work package, not a micro-task list. Before writing any code for a phase, (1) verify/author the phase's L1→L2→L3 spec chain using the guardian skills (`l1-spec-guardian`, `l2-spec-guardian`, `l3-spec-guardian`) as the repo's CLAUDE.md requires, then (2) expand the phase into a detailed task-level plan via `superpowers:writing-plans`, then (3) implement with TDD. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take runforge from "everything built, nothing in production" to its first production deployment — the regulated pilot deployment (deployment #1) named in L0 v7 line 26 — realizing the full L0 promise: closed-loop delivery, one working operator steering surface, and earned autonomy that measurably asks the Operator less over time.

**Architecture:** Close the three real gaps (self-governance of deployment #0, PR-gated single-trunk delivery, target-deployment release lane), harden the operator surface to production grade, wire the "earning" half of earned autonomy, then onboard the regulated pilot deployment human-gated and graduate it under the earn-in protocol. Every phase terminates in a documented live run (execution-log convention), never in "tests pass."

**Tech stack:** TypeScript monorepo (pnpm), Node 22; daemon (`packages/daemon`, control-plane + session-runtime), Next.js dashboard (`packages/dashboard`), Postgres (Drizzle), Claude CLI workers, launchd on the macOS host (primary topology), Docker Compose + Hetzner (documented alternative).

**Revision v2 (2026-07-02, post-adversarial-review, Operator-approved):** adds the operator-reachable halt (P0.5 — a P2 entry gate), a post-merge revert lane (P1.5), the self-hosting posture + prompt-freeze fixes (P2.6–2.8), a config-honesty gate (hard pre-P7), **Phase R** (regulated-pilot reconnaissance, gates D7/P7), the P7 data boundary, a 10–16-week re-baseline, and **Milestone M1**. All revision-verifying evidence is recorded in §1/§3.

## Global constraints (bind every phase)

- **Spec-first sequence is mandatory** (repo CLAUDE.md): no implementation without a complete L1→L2→L3 chain in `.specify/` linked in `traceability.yml`. Where this plan says "spec chain must be written first," that work precedes code and its L1 content is an Operator approval — one of the two reserved gates.
- **The two reserved Operator gates** (L0 v7 line 71): specification-content approval and production release. No phase may mint a third gate; no phase may bypass either.
- **Fail-closed floors stay fail-closed** (L0 v7 lines 73–84): verifier-withheld ⇒ escalate; malformed compliance profile ⇒ block; budget exceeded ⇒ hard stop; always-escalate set untouched. Any change that would relax a floor is out of scope for this plan.
- **Earn, never schedule** (L0 v7 lines 30–33): autonomy widens only off recorded proven runs, never off calendar time or optimism.
- **Done means a live run**, documented as `docs/superpowers/plans/<date>-<name>.execution-log.md` with a Phase-9-style E2E proof, per the repo's existing convention (7 such logs exist). Unit/integration tests green is necessary, never sufficient. This is the anti-"99%-done" device — the exact failure mode this plan exists to break.
- **Update `traceability.yml`** for every new file; run the affected spec's `test_paths` after changes.
- Repos referenced: `DANIELSOCRAHANDLEZZ/runforge` (this system, deployment #0), `DANIELSOCRAHANDLEZZ/cause-driven-tasks` (demo deployment, live-proven), `DANIELSOCRAHANDLEZZ/runforge-example` (spec-pipeline scaffold), the regulated pilot repo (deployment #1 — **not audited by this analysis**; see Risks).

---

## 1. Ground truth — what is really done vs. what seems done

Classification: **(a)** built and tested · **(b)** proven live end-to-end · **(c)** stub / deferred / aspirational. Every claim below was gathered read-only from the repo on 2026-07-02 and load-bearing items were independently re-verified.

### 1.1 Spec tree and traceability — (a), with governance debt

- L0 (`.specify/L0-ac-vision.md`) is **v7, approved**. The regulated pilot deployment named at line 26; the two reserved gates at line 71; fail-closed floors at lines 73–84; narrow-first/earn-never-schedule at lines 30–33.
- L1: 31 functional specs; **12 approved** (decision-escalation v3, operator-learning, compliance-gate, fleet v2.2, merge-decision v2, verifier-gate, plugins v4, runtime-adapters, dashboard v4, operator-surface, steering, release), **18 draft** — including **FUNC-AC-PIPELINE v2, the core pipeline spec, still draft** — 1 deprecated.
- L2 (~40) and L3 (~60) are **all draft** except the ARCH-SDD methodology specs. Traceability totals: 21 approved / 124 draft / 5 deprecated. Spot-checked L3 `code_paths` all exist on disk.
- **Verdict:** the spec architecture is complete and honest, but the majority of shipped code is governed by unratified specs. Ratifying them is literally Operator gate #1 work and is scheduled as a cross-cutting track below.

### 1.2 Daemon pipeline (control-plane) — (b) on external repos, (c) on itself

- FSM + pipeline + phase handlers are fully wired: `fsm.ts:16-84` (four variants + spec-driven), `pipeline.ts:122-141` pre-flight-validates every phase has a handler (forces `stuck` if not), `phases.ts:537-2445` implements detect/classify/decompose/implement/review/holdout/integrate/deploy/test/report plus l2-design/l2-gate/l3-generate. Label-driven intake (`ready`, `review-finding`, `ready-to-implement`, `l1-approved`, `l2-approved`) polls live in `daemon.ts:1533/1644/1724`.
- **Live proof, code lane:** demo daemon log (2026-06-26) shows three fully unattended runs on cause-driven-tasks — `decideMerge` returned real `auto-merge` with `verifierStatus {observed:true, runnable:true, falsifying:true}` and `[integrate] Successfully merged feature/5 → main and pushed to origin` (issues #5/#6/#7, zero operator touch), downstream of a one-time manual autonomy widen (operator-grant 2026-06-25 in `state/autonomy.json`).
- **Live proof, spec lane:** 2026-06-04 (`docs/learnings/2026-06-04-spec-pipeline-delivery-blockers.md`) — runs #12/#17 shipped L0→L3 e2e and run #23 proved the full tail (l2-gate→l3-generate→implement→review→holdout→integrate→report) on the runforge-example scaffold; independently verified (22/22 tests, tsc clean); the blocking fixes are still in current code. Not repeated since; three minor races noted open in that doc.
- **Known soft spots:** `decompose` is a pass-through no-op (`phases.ts:1189-1194`); the website variant is a **misleading-success stub** (#774); the `deploy` phase short-circuits to success when `deployCommand`/`healthCheckUrl` are unset.
- **Emergency controls are thinner than they look (verified):** `POST /pause` only sets a flag read at work-claim time (`daemon.ts:1919-1923`, gates at `:1450/:1548`) — an already-admitted run proceeds through merge after pause; **no abort/kill endpoint exists** in the daemon route table (`server.ts:74-505`) or dashboard, and the only true abort is host-shell `SIGUSR2` → `killAllManagedProcessGroups`. The only revert code in the repo (`coordination/merge-agent.ts:125-144`) is **inert scaffolding**: behind `useCoordinator` (default `false`, `config.ts:463,500`) with a stub git dependency that returns `ok('')` unconditionally (`daemon.ts:1159`). The live integrate path has zero post-merge observation or rollback.
- **The self-gap:** `runforge.config.json` has **no `deployment` block** and still sets `staging: "dev"` — a branch retired 2026-05-29 and nonexistent. The daemon takes the legacy unconditional-merge path if pointed at this repo and **has never landed a commit in runforge itself** — all ~800 PRs came from a separate sparring-driven process. Deployment #0 does not exist as a governed deployment. (#774 dead-end 3 — the only one of its three dead-ends still true; the verifier stub and non-durable autonomy state were fixed after that audit, per the 2026-06-26 live log.)

### 1.3 Operator steering surface — inbox (b); production posture (c); steering-roles spec (c)

- The `/steering` page + decision inbox is **genuinely wired, no stubs**: `steering/page.tsx:29-48` → proxy routes → daemon `GET /decisions/pending`, `GET /decisions/:id`, `POST /decisions/:id/answer`, `POST /decisions/:id/reveal` (`server.ts:222-382`), all backed by real handlers (`daemon.ts:2086-2161`). The answer round-trip (answer → GitHub `DecisionResponse` comment → `resumeParkedRuns` consumes → pipeline resumes, `daemon.ts:2596-2957`) is code-traced end-to-end and **live-proven** via the first-use-safety, /retry, rung-1, and finding-dismissal execution logs.
- **Production gaps:** `/steering` has **no polling/refresh** (only `/briefing` mounts the 30s refresher) — the operator must manually reload to see new decisions; the Playwright E2E (`e2e/operator-surface.spec.ts`) runs **only against a mock daemon** (`e2e/mock-daemon.mjs`); the **daemon control API has zero authentication** (binds 127.0.0.1, checks only an `X-Requested-By: dashboard` header on POST) — all auth lives in the dashboard's better-auth session + `teamMembers` roles, and FUNC-AC-OPERATOR-AUTH is draft; there is **no out-of-band notification** when a decision parks (a #774-named risk that becomes load-bearing the moment autonomy widens).
- **FUNC-AC-STEERING (approved L1) is unwired:** its L3 module `control-plane/steering/{cron,decide,registry,schema}.ts` has **zero non-test callers**. 9 of its 10 requirements have no wired implementation; a hard-coded legacy path (`po-agent.ts`, `tech-lead-scheduler.ts`, wired at `daemon.ts:957-1147`) does the actual steering, and even it logs "routing not yet wired" (`daemon.ts:1098`). An approved spec whose implementation is dead code is exactly the kind of 99%-mirage this plan must not leave standing.

### 1.4 Session-runtime safety — mostly (a), one dead floor, no live proof of this layer

- Workers are **plain host child processes** of the Claude/Codex/Pi CLIs (`runtime.ts:481-650`, `cli.ts:411-422`) — no per-worker container (deliberate: OAuth constraint, below).
- Containment hooks: **(a), genuinely wired** — `setupHooks()` writes a PreToolUse blocker into the workspace's `.claude/settings.local.json` on every spawn/resume; contract-tested as a real subprocess with exit-code assertions (`generate-containment-script.test.ts`).
- **Confirmed bug — preventive scope hook is dead code:** `generateScopeHookScript` (`session-runtime/scope-enforcement.ts:89-223`) emits `{block: true}` — a field that does not exist in the Claude CLI hook schema — and never exits non-zero, so it **can never block a call**. Write-scope is currently **detective-only** (post-session `git diff` audit, `runtime.ts:603-619`, which does hard-fail the run). Deny-path *reads* work via native `permissions.deny`. Zero subprocess-level test coverage on this script — which is why it survived.
- Cost/rate limits: **(a), hard-stop** — `costTracker.reserveCost()` gates before spawn (`runtime.ts:512-529`); exact-usage accounting with reservation semantics.
- OAuth/container constraint: **real and documented** (`docs/running.md:116`) — Max-subscription OAuth tokens can't refresh in a container; current answer is the native daemon (launchd) with a 15-min `creds-sync` launchd job for the optional Docker path. A workaround, not a fix.
- Runtime-source isolation (verified): validation runs at boot **and** every work-claim (`daemon.ts:277,1493,1925,2462`), pause-on-unhealthy — under the current config the daemon would boot **paused** (expectedRef resolves to the retired `origin/dev`). `allowSelfRepair` is a dead knob (stored at `config.ts:88,98`, read nowhere; the ARCH spec's repair step is unimplemented). Governance inputs are mostly boot-frozen (`FACTORY_RULES.md` fingerprint-cached; the 5 contract prompts pre-warmed) but ~9 non-contract agent prompts live-read on first use and `product-owner-interactive.md` always reads fresh — a narrow but real torn-read window.
- No credential/secret-leak scanning exists on worker output (the post-session audit only looks for blocked-command evidence). No execution-log entry exercises this layer's hooks live.

### 1.5 Earned-autonomy machinery — gating (b), earning (c)

- **Real and live-proven:** verifier gate (`evaluateVerifierGate`, fail-closed, ranked rule #1 in `decideMerge` — `merge-decision/decide.ts:73-77`) with a **real observation probe** (`createProbeOracle`, `phases.ts:110-141` — checks the declared verifier ref against real package scripts/workflows); the 9-rule merge decision; deployment-registry autonomy state with append-only `WideningRecord` history, consumed live by the integrate handler (`phases.ts:1949-2136`, fails closed on unknown repo/absent registry); operator-learning **rung 1** (inbox re-ranking, live) and **rung 2** (decision pre-fill, live, #808), with guarded classes capped at `surface`.
- **Aspirational:** `evaluateEarnIn` (`lane-engine/earn-in.ts:10-26`) has **zero callers** — nothing builds a `LaneTrackRecord`, nothing ever mints an `earn-in-policy` widening; the only live path to `recordWidening` is the manual Operator `POST /deployments/:id/widen`. Rung 3/4 act-side (`maybeProposeAskLess`/`approveAskLessProposal`) exists but has **no caller** — deliberately deferred pending the Operator's rung-3-shape decision (#811: "No autonomous action yet"). And **nothing anywhere measures escalation rate or autonomy trend** — the "measurably asks less over time" promise is currently unmeasurable.
- **Stored-only config surfaces (verified sweep):** 5 of 13 `DeploymentProfile` fields are validated-and-stored but read by nothing — `budget` (a spend cap an operator can set today that nothing enforces), `landing`, `honestAutomation`, `capabilityBindings`, and `complianceVerdicts` (the last deliberately unsourced, fail-closed by design) — plus `allowSelfRepair` (§1.4) and the entire window-scheduler/fleet-capacity module (zero non-test callers, no config wiring at all). A knob that silently does nothing reads as safety when it isn't; the config-honesty gate in §4's cross-cutting track exists to close this class.

### 1.6 Delivery mechanism vs. the ratified branch model — (c), needs new code

The integrate phase performs a **raw `git merge --no-ff` + push** to a configured branch (`integration.ts:41-46`). The live demo ran with `staging: "main"`, i.e., direct pushes to main — **bypassing PRs, branch protection, and required checks entirely**. No PR-creation or PR-merge path exists for code changes; the only `octokit.pulls.merge` call (`phases.ts:360`) is scoped to L2/L3 **spec-artifact** proposals. `DeploymentProfile.landing` (`landsOn`, `productionReleasePath`) is validated and stored but **read by nothing**. The L0-v7-ratified model (feature-branch → PR → main, PR-gated by risk class) therefore **requires new code**, mirroring the already-proven spec-artifact PR pattern.

### 1.7 Release and deploy — self (a), target deployments (c), plumbing (a)-never-used

- `scripts/release.sh`: real, fail-closed, dry-run by default, `--confirm` for tag + GitHub release + launchd daemon restart — **runforge's own daemon only** (its own note: dashboard/DB are "a SEPARATE deploy step this script does not touch"). FUNC-AC-RELEASE (approved) covers exactly this self-release.
- **Target-deployment release is a stub:** `cause-driven-tasks.config.json:56` declares `"productionReleasePath": "tag-and-deploy"`, but zero code branches on it. There is no mechanism by which the Operator's production-release gate can act on a target deployment. `release.ts:70-107` only opens a staging→production notes PR.
- Deploy plumbing (compose, 4 Dockerfiles, Caddyfile, `infra/main.tf` + cloud-init, launchd plists incl. creds-sync, `.env.prod/.mac.example`, install/health scripts): **complete and internally consistent** — every cross-reference checks out — and never used for a production deployment. No CD workflow (by design; CI only).

### 1.8 Compliance lane — (a) wired fail-closed, (c) never exercised live

`compliance/evaluator.ts` + schemas are wired into the integrate seam (`merge-decision/compliance.ts`, `evaluateComplianceForced`) and the deployment-registry profile; malformed profile ⇒ block. FUNC-AC-COMPLIANCE-GATE is approved with L2/L3 draft. But no live run has ever exercised a non-empty `complianceReviewers` set (the demo profile sets `[]`), and the regulated pilot's GRÜN/GELB/ROT classification exists only in the superseded 2026-05-29 roadmap doc, not as a real profile.

### 1.9 The named gap between the 99% feeling and reality

**Component-completeness is real; institutional existence is not.** Nearly every subsystem is at (a), and an unusually large share is at (b) — including full unattended verifier-gated auto-merges, which is rare air. What has never existed is the assembled institution: the system has never governed itself (deployment #0 unconfigured), never merged code the way its own constitution ratified (raw pushes, not PR-gated), never released anything for a target deployment (landing unconsumed), never measured its own asking rate, never authenticated its control plane, carries one dead safety floor (scope hook) and one fake-success path (website variant), and 18 draft L1s govern shipped code. The perpetual-99% feeling is the artifact of a build process that takes capability after capability to (a) while the (b)-status of the whole stalls at demo scale. Correspondingly, **the plan below is mostly assembly, wiring, and proving — not greenfield building.** That is genuinely good news, and it is also why "one more feature" has never crossed the line: the line is crossed by live proofs, not features.

---

## 2. Gap to the full L0 promise, promise by promise

| L0 promise | Current distance |
|---|---|
| Closed-loop lifecycle (intake→spec→implement→verify→merge→release) | Through merge: **live-proven** on two external repos (spec lane 06-04, code lane 06-26). Release half: **absent** for target deployments. Self-loop (runforge improving runforge via its own pipeline): **never run**. |
| One working operator steering surface | Decision inbox: **works, live-proven**. Missing for production: live refresh, real-daemon E2E, authenticated remote access, out-of-band alerts. FUNC-AC-STEERING's declared steering roles: approved spec, **dead code**. |
| Earned autonomy that measurably asks less | Gating: live. Earning: **not wired** (earn-in zero callers; rung 3/4 deferred on an Operator decision). Measurement: **does not exist**. Today every widening is manual and nothing can demonstrate "asks less." |
| Per-deployment profiles | Schema + one real live profile (cause-driven-tasks). Runforge's own profile: missing. Regulated-pilot profile: not started. `landing`: declared, unconsumed. |
| Verifier-gated autonomy (hard boundary) | **Live-proven at merge time**, both arms (auto-merge and escalate). Execution-time gate (#774 step 4): absent. |
| Exactly two reserved gates | Gate 1 (spec content) functions socially; 18 draft L1s awaiting it. Gate 2 (production release) exists for runforge's own daemon only; **no mechanism** for a target deployment. |
| Fail-closed floors | Mostly real and live (verifier-withheld, compliance-block, session-level budget hard-stop, scope tripwire escalation — but the deployment-profile `budget` field is stored-only until P4.4). Four holes: preventive write-scope hook dead; website variant reports fake success; no operator-reachable abort (pause is claim-time-only); no trunk rollback (the only revert code is inert scaffolding). |

---

## 3. Ranked blockers to a production regulated-pilot deployment

Hardest / most load-bearing first. "Resolved looks like" is the phase exit evidence.

1. **Deployment #0 is ungoverned; the system has never run on itself.** Evidence: no `deployment` block in `runforge.config.json`; `staging:"dev"` (retired branch); zero daemon-landed commits in this repo; Gate-1 self-target baseline decision still deferred (`docs/specs/2026-06-02-gate1-self-target-baseline-recommendation.md`). Blocks: the narrow-first protocol requires proving the loop on the least-regulated deployment before touching a regulated one — and self is that deployment. Resolved = one unattended, verifier-gated, PR-mediated merge of a real change into `runforge/main`, documented in an execution log. (Phases 0+2.)
2. **PR-gated single-trunk delivery does not exist.** Evidence: §1.6. Blocks: the ratified branch model, regulated-pilot onboarding (a regulated repo will have branch protection and required checks — raw pushes are a non-starter), and honest CI gating for deployment #0. Resolved = integrate creates a PR and performs a risk-class-gated API merge, consuming `landing.landsOn`, proven live with branch protection ON. (Phase 1.)
3. **No target-deployment release lane — Operator gate #2 has no mechanism.** Evidence: §1.7. Blocks: the literal definition of "first production deployment." Resolved = release proposal → decision inbox → Operator approval → executed `productionReleasePath` with an auditable record, proven live on the demo deployment. (Phase 5.)
4. **Operator surface is not production-postured.** Evidence: §1.3 gaps. Blocks: the Operator steering a regulated pilot; safe autonomy widening (no out-of-band alert = parked decisions rot silently). Resolved = authenticated remote access, live-updating inbox, real-daemon E2E in CI, push/email alert on parked decisions. (Phase 3.)
5. **The "earning" half of earned autonomy is unbuilt and the promise is unmeasured.** Evidence: §1.5. Blocks: "measurably asks less over time" — full L0 by definition; regulated-pilot graduation (Phase 8) has no mechanical basis without it. Resolved = escalation-rate metric visible on the dashboard; earn-in wired to mint bounded widenings under the L0 v7 pre-approved floors; rung-3 shape decided and act-side landed. (Phase 4.)
6. **Safety-floor holes unacceptable for a regulated lane.** Evidence: dead scope hook (§1.4), website-variant fake success, no secret-leak scan, no execution-time verifier gate, **no operator-reachable emergency stop and no trunk rollback** (§1.2), and five stored-only profile knobs including `budget` (§1.5). Resolved = preventive scope blocking subprocess-tested live; fake-success path removed; worker-output secret scan wired; `POST /halt` live-drilled; the post-merge revert lane shipped with P1; execution-time gate lands with Phase 2; config-honesty gate green before P7. (Phases 0, 1, 2 + the pre-P7 gate.)
7. **FUNC-AC-STEERING approved but unwired; legacy hard-coded steering runs instead.** Evidence: §1.3. Blocks: "closed-loop, self-improving" as specced; also a governance integrity problem (approved L1, dead L3). Resolved = at least one data-declared steering role waking on rhythm, proposals landing in the inbox, legacy path migrated or retired. (Phase 6 — parallel track, not pilot-blocking.)
8. **Compliance lane never exercised live; regulated-pilot profile does not exist.** Evidence: §1.8. Resolved = regulated-pilot profile with real `complianceReviewers` + GRÜN/GELB/ROT `riskPathMap`; one live forced-compliance escalation observed and answered through the inbox. (Phase 7.)
9. **Governance debt: 18 draft L1s (incl. FUNC-AC-PIPELINE) + all L2/L3 draft.** Blocks nothing mechanically, but Operator gate #1 is unserved at scale, and "full L0" with the core pipeline spec unratified is a contradiction. Resolved = batch ratification passes (cross-cutting track).

---

## 4. The sequenced plan

Dependency spine: **P0 → P1 → P2 → {P3 ∥ P4 ∥ P5} → P7 → P8**, with **P3 starting immediately in parallel** (different subsystem), **Phase R (regulated-pilot reconnaissance) starting week 1 in parallel** — it gates D7 and P7, and the plan's tail is provisional until it lands — and **P6 parallel, required before declaring full-L0 but not pilot-blocking**. Two hard gates protect the spine: the **P0.5 operator halt is a P2 entry gate**, and the **config-honesty audit** (cross-cutting track) **is a hard pre-P7 gate**. Rough calendar with parallelism: **10–16 weeks** to the first regulated-pilot production release, including discovery buffers (P2 +1 week, P7 +1–2 weeks — first live proofs historically surface blockers; see the 2026-06-04 log's five); 8–12 weeks is the everything-goes-right case. Throughput note: the L1-ratification track is Operator-bound — if D1 batches aren't consumed at cadence, ratification becomes the critical path (sizing confidence: medium — see Risks).

Every phase ends with: run affected `test_paths`, a live run on a real daemon, and a committed `*.execution-log.md`. The implementing agent must not mark a phase complete on green tests alone.

### Phase 0 — Ground repairs and safety-floor honesty (S–M, ~3–5 days)

**Delivers:** the known-broken floors fixed and the config lies removed, so every later live proof stands on honest ground.
**Unblocks:** P1/P2 (can't gate deployment #0 on floors that silently don't hold).
**Governing specs:** existing chains — these are defect fixes under STACK-AC session-runtime/pipeline specs; no new L1 content ⇒ no Operator gate. Update `traceability.yml` test_paths where new tests land.

- [ ] **0.1 Fix the dead scope hook.** `packages/daemon/src/session-runtime/scope-enforcement.ts:89-223`: emit the Claude CLI's actual hook contract (exit code 2 + stderr reason, and/or `permissionDecision: "deny"` JSON — mirror `generate-containment-script.ts:264-270`, which is correct). **TDD:** first write a subprocess contract test in the style of `generate-containment-script.test.ts:9-29` (spawn the generated script, feed a scope-violating tool-call JSON on stdin, assert exit 2) — it must FAIL against current code; then fix. Keep the detective git-diff audit; the two layers are complementary.
- [ ] **0.2 Remove the website variant's misleading success.** Make it fail closed (return `stuck`/escalate) or delete the variant from `fsm.ts` until a real implementation exists. Fake success on a live path is the one thing worse than a missing feature.
- [ ] **0.3 Purge retired-branch config.** `runforge.config.json` `staging:"dev"` / `production:"main"` → single-trunk shape consistent with L0 v7 (do not yet add the `deployment` block — that's P2, after P1 gives it a safe merge mechanism).
- [ ] **0.4 Worker-output secret scan (minimal).** Add a post-session scan for credential-shaped strings (Anthropic `sk-ant-`, GitHub `gho_`/`ghp_`, generic high-entropy assignments) alongside the existing blocked-command audit in `session-runtime/audit.ts`, failing the session on a hit. Keep it small — this is a floor, not a DLP product.
- [ ] **0.5 Operator-reachable halt (P2 entry gate).** Add authenticated `POST /halt` to the daemon control API: sets paused, kills in-flight worker process groups (reuse `killAllManagedProcessGroups`, SIGTERM with SIGKILL escalation), and parks affected runs via the existing park machinery so they are resumable, not lost. Fix `/pause` semantics so pause also gates phase transitions (at minimum integrate-entry) — today an admitted run merges even after pause (`daemon.ts:1450,1548`). The UI button lands in P3.6; the endpoint must be usable via authenticated curl from day one.

**Verifier/gate:** subprocess contract tests green; full daemon suite green.
**Done-evidence:** execution log showing a live worker session where an out-of-scope write is **blocked mid-session** (not just audited post-hoc), plus a seeded secret in output failing the session, plus a halt drill: a deliberately long-running live session killed via `POST /halt`, its run parked and later resumed.

### Phase R — Regulated-pilot reconnaissance (S–M, ~3–5 days; **parallel track, start week 1; hard gate for D7 and P7**)

**Delivers:** verified ground truth about the target that ~40% of this plan's timeline rests on — replacing assumptions lifted from a superseded 2026-05-29 doc.
**Unblocks:** D7 (target confirmation), P7 (pilot design); firms up the plan's provisional tail.
**Governing specs:** none needed — read-only reconnaissance; findings feed the P7 profile, which is where spec-governed work happens.

- [ ] **R.1 Audit the regulated-pilot repo read-only:** CI shape and typical runtime (the verifier probe target — `createProbeOracle` needs a declared, runnable check), branch protection and required checks, test-suite health, issue hygiene/labeling (intake needs labels), repo layout.
- [ ] **R.2 Sensitive-data-in-repo check (fail-closed P7 precondition):** scan for real regulated/sensitive data in fixtures/dumps/docs. If found: those paths go into containment blocked-paths AND remediation precedes any pilot, and a content-protection L1 chain becomes a P7 blocker (see P7's data boundary).
- [ ] **R.3 Commit-subject hygiene check:** briefing-summarizer's input surface is `git log --oneline` subject lines — confirm the pilot repo's subjects carry no sensitive content, or exclude that service from the pilot topology (see P7.5).
- [ ] **R.4 Revalidate the GRÜN/GELB/ROT classification** against the current repo (the source doc is superseded), consolidating epic #677's referenced pilot-side architecture docs (2026-05-20/21) and the 2026-06-10 pilot autonomy masterplan into one current statement.

**Done-evidence:** a recon report committed under `docs/` (findings + revalidated classification + sensitive-data verdict); D7 answerable from it. **Until this lands, P7/P8 and the calendar tail are provisional.**

### Phase 1 — PR-gated single-trunk delivery lane (L, ~1.5–2 weeks)

**Delivers:** the ratified branch model in code: integrate creates a PR and performs a risk-class-gated merge via the GitHub API; `landing.landsOn` is consumed.
**Unblocks:** P2 (deployment #0 must merge via PRs — its own CI and this repo's conventions demand it), P7 (the regulated pilot will require branch protection).
**Governing specs:** **spec work first.** FUNC-AC-MERGE-DECISION v2 (approved) governs the decision; the *delivery mechanism* for code is uncovered — extend FUNC-AC-CONTROLLED-ARTIFACT-DELIVERY (draft, currently spec-artifacts-only) to code changes, or amend FUNC-AC-MERGE-DECISION. **Recommendation: extend CONTROLLED-ARTIFACT-DELIVERY** — "review proposals always target the single configured trunk … a fixed safety floor" is already its language, and the wired spec-artifact PR path (`phases.ts:360`, `mergeL2Proposal`) is the proven pattern to mirror. This is an L1 content change ⇒ **Operator gate #1** (Decision D2 in §5). Then L2/L3 via guardian skills.

- [ ] **1.1 Author/ratify the L1 delta + L2/L3 chain** (guardian skills; Operator approves L1 content).
- [ ] **1.2 Implement:** in the integrate handler (`phases.ts:1944-2286`) and `integration.ts`, replace raw merge with: push feature branch → create PR → on `auto-merge` verdict, merge via `octokit.pulls.merge` (squash/merge per config) after required checks pass; on `escalate`/`hold`, the PR is the parked artifact the decision references. Consume `profile.landing.landsOn` as the target trunk (kill the legacy `branches.staging` read for gated deployments; keep legacy path only where no `deployment` block exists, and log it loudly as ungoverned).
- [ ] **1.3 Handle required-checks reality:** merge waits on CI (poll checks API with timeout → escalate on red/timeout, never bypass). Note memory: on macOS TLS/date issues, `gh auth token` can go invalid — the daemon uses octokit with its own token; keep it that way.
- [ ] **1.4 Prove live on cause-driven-tasks** with branch protection + a required check enabled on that repo.
- [ ] **1.5 Post-merge observation and revert lane.** After each auto-merge, observe the merge commit's required checks/verifier on the trunk; on red, automatically open a **revert PR** and raise an escalation decision (fail-closed: the Operator one-click-approves the revert; a revert may auto-merge only under the same verifier gate). Quarantine or delete the inert coordinator/merge-agent scaffolding (`coordination/merge-agent.ts` — flag-off, stub-injected; see §1.2) so nobody mistakes it for a live rollback net.

**Verifier/gate:** verifier-gate + merge-decision unchanged (they already work); the new lane's own tests + the live proof.
**Done-evidence:** execution log with a real PR URL on cause-driven-tasks: opened by the daemon, checks green, auto-merged by the daemon with `decideMerge` verdict logged — zero operator touch — and a second run showing the escalate arm parking a PR + inbox decision. Plus a post-merge-red drill: a seeded bad change auto-merges, trunk checks go red, and the daemon opens the revert PR + escalation without human prompting.

### Phase 2 — Deployment #0: runforge governs itself (M–L, ~1–1.5 weeks)

**Delivers:** runforge as a registered, gated deployment of itself; the self-improving loop closed for real (#774 steps 3+5, and its step-4 execution-time gate).
**Unblocks:** P4 (earn-in needs a track record to read), P7 (narrow-first: self proven before regulated), and retires the "never ran in production" sentence — the daemon running unattended against this repo on the macOS host **is** production for deployment #0.
**Entry gate:** P0.5's halt endpoint exists and was live-drilled — no unattended self-merge without a remote abort.
**Governing specs:** FUNC-AC-FLEET v2.2 (approved) covers register-as-deployment; FUNC-AC-VERIFIER-GATE (approved) — promote its L2/L3 out of draft as part of the execution-time work (#774 step 4). Gate-1 baseline needs the Operator's Decision D3 (§5) — the recommendation in `docs/specs/2026-06-02-gate1-self-target-baseline-recommendation.md` Phase 1 (one-time exit-code baseline; pre-existing red ⇒ tainted, downgraded to warnings) — no new L1, it's within FUNC-AC-QUALITY's scope (draft; fold into the ratification track).

- [ ] **2.1 Implement the Gate-1 baseline** per the accepted recommendation (self-target red/flaky tests must not poison every run; the concurrent-load flake history — RC-1..4, all fixed — says the suite is mostly green but treat trust as earned).
- [ ] **2.2 Author runforge's own deployment profile** in `runforge.config.json` (fleet shape like `cause-driven-tasks.config.json`): riskPathMap with `.specify/**`, `.github/**`, `packages/daemon/src/control-plane/**`, `session-runtime/**` ⇒ `orange`/`red` (the system's own governance and safety code must escalate); ordinary `packages/**` code ⇒ yellow; docs ⇒ green. `complianceReviewers: []`. `landing: { landsOn: "main", productionReleasePath: "release-sh" }`.
- [ ] **2.3 Wire the execution-time verifier gate** (#774 step 4): no declared+runnable verifier ⇒ no autonomous implement/integrate for that deployment (fail-closed, same probe as merge-time).
- [ ] **2.4 Run the daemon on the macOS host via launchd** (`scripts/install-daemon.sh`, `com.runforge.daemon.plist`; heed vault mistake-note: KeepAlive/RunAtLoad restart traps, `ProcessType: Interactive` on Apple Silicon; heed memory: health.sh heartbeat TZ display bug — check file mtime, not its report) against runforge itself, feeding it a small real backlog issue labeled `ready`.
- [ ] **2.5 Operator widens green/docs lane once via the existing widen API** (this is the legitimate manual seed — earning comes in P4), then observe.
- [ ] **2.6 State the self-hosting posture explicitly** (in `docs/running.md` and this phase's execution log): physical runtime isolation is deliberately substituted by validate-at-boot-and-every-claim + pause-on-unhealthy (`runtime-source.ts`; `daemon.ts:277/1493/1925/2462`) + self-changes landing only as PRs on origin (which never mutate the running daemon's working tree) + Operator-gated `release.sh` restart as the only self-update path ("promotion is the restart"). Set `runtimeSource.expectedRef: origin/main` explicitly (P0.3 removed the stale `dev` reference).
- [ ] **2.7 Freeze governance inputs at boot:** extend `preloadPromptCache` (`runtime.ts:101`) to pre-warm **all** prompt files — the ~9 non-contract agent prompts and `product-owner-interactive.md`, not just the 5 in `PROMPT_CONTRACTS` — closing the first-use torn-read window (§1.4).
- [ ] **2.8 Remove the `allowSelfRepair` knob** (stored, read nowhere) rather than implementing it — the ARCH spec's repair step is deferred scope, and a dead knob fails the config-honesty gate. Note the deferral in the ARCH spec.

**Verifier/gate:** CI required checks on the daemon's PRs (the P1 lane); verifier gate both arms.
**Done-evidence:** execution log: one unattended run — issue → implement → review → PR → checks green → verifier-gated auto-merge into `runforge/main` — plus one orange-path run correctly escalating to the inbox and resuming after the Operator answers **from the UI**. This log is the single most important artifact in the whole plan.

### Phase 3 — Operator surface to production grade (M, ~1–1.5 weeks; **start in parallel with P1**)

**Delivers:** the steering surface the Operator can actually run the fleet from: remote, authenticated, live-updating, alerting.
**Unblocks:** P7 pilot steering; safe widening (P4/P8).
**Governing specs:** FUNC-AC-DASHBOARD v4 + FUNC-AC-OPERATOR-SURFACE (approved) govern; FUNC-AC-OPERATOR-AUTH (draft) must be ratified (Operator gate #1, batched in the ratification track) before the auth work — the implementation (better-auth + roles) already exists, so this is ratify-then-harden, not build.

- [ ] **3.1 Live inbox:** mount the existing 30s-refresh mechanism (`components/briefing/briefing-realtime.tsx` pattern) on `/steering` — respecting the answer-flow race note at `decision-answer.tsx:228-234` (refresh must not clobber an in-flight answer).
- [ ] **3.2 Real-daemon E2E:** one Playwright smoke in CI driving `/steering` against a **real** daemon control-plane server with a seeded ledger (not `mock-daemon.mjs`) — decision D4-B from the operator-followups plan, already recommended there.
- [ ] **3.3 Out-of-band alert on parked decisions:** on `ledger.raise`, send a push (ntfy/Pushover) or email to the Operator with the decision title + deep link. Small adapter in the daemon, config-driven; no framework.
- [ ] **3.4 Remote access topology (Decision D6, §5 — recommendation: macOS-host-native):** daemon native (OAuth constraint), dashboard in Docker, exposed to the Operator's devices via `tailscale serve` (per existing memory: `--bg --http=<port>`, not the HTTPS default). Verify `LOCAL_AUTH_BYPASS` is hard-off in this posture (`packages/auth/src/local-bypass.ts` keys off production indicators — set `NODE_ENV=production` explicitly and add a boot assertion that bypass is disabled).
- [ ] **3.5 Daemon-API hardening consistent with topology:** keep 127.0.0.1 binding; add a shared-secret header check between dashboard and daemon so a same-host process can't drive the control API unauthenticated.
- [ ] **3.6 Halt control in the UI:** a confirm-gated halt/pause button on `/steering` proxying to `POST /halt` / `POST /pause` (P0.5), admin-role-gated like answer/reveal.

**Verifier/gate:** the new real-daemon E2E in CI; auth boot assertion.
**Done-evidence:** execution log: the Operator (from a separate device, over Tailscale, logged in) receives a push for a parked decision, opens `/steering`, sees it appear without manual reload, answers it, and the daemon-side run resumes — screenshots + daemon log excerpts.

### Phase 4 — The earning half: measure, earn, ask less (M–L, ~1.5 weeks)

**Delivers:** L0's headline differentiator made mechanical: an escalation-rate metric, earn-in-minted widenings under pre-approved floors, rung-3 act-side.
**Unblocks:** P8 graduation (mechanically, not by vibes).
**Governing specs:** FUNC-AC-OPERATOR-LEARNING v2 (approved, includes the fourth rung) and the L0 v7 pre-approved earn-in floors govern; the known **L2 amendment** for auto-dismiss (noted as blocking PR3a/3b) must be written via `l2-spec-guardian` (L2 = no Operator gate; the L1 already carries the content). Rung-3 shape is the Operator's Decision D5 (§5).

- [ ] **4.1 Escalation metric:** persist per-week counts of decisions raised / auto-resolved / operator-answered per deployment (source: decision ledger + `WideningRecord` history — both already persisted), expose a daemon endpoint, render a trend on the dashboard (use the `dataviz` skill). This is the "measurably" in "measurably asks less."
- [ ] **4.2 Wire earn-in:** build `LaneTrackRecord` from the merge-decision outcomes already recorded; call `evaluateEarnIn` (`lane-engine/earn-in.ts:10-26`) on a post-integrate tick; when thresholds pass, mint `recordWidening` with `authorization: {kind:'earn-in-policy'}` **within the L0 v7 pre-approved floors only** (green→yellow lanes; orange/red remain Operator-only — floors never widen autonomously). Surface every earn-in widening as an inbox notification (visibility, not approval — no third gate).
- [ ] **4.3 Execute the rung-3 decision (D5)** and land the act-side: `maybeProposeAskLess` wired into the finding-dismissal tick, `approveAskLessProposal` as an inbox decision, auto-application bounded per the approved shape; guarded classes (`finding_dismissal:security`) stay capped at `surface` — that cap is already in code (`operator-learning/types.ts:186-196`), keep it.
- [ ] **4.4 Deployment-level budget abort:** verify the per-deployment `budget` field is enforced (session-level caps are proven hard-stop; #774 flags deployment-level spend as advisory) — if advisory, wire a hard abort + escalation at the deployment cap before any autonomy widening ships.

**Verifier/gate:** unit + integration tests on earn-in minting (esp. floor boundaries); metric endpoint tested.
**Done-evidence:** execution log on deployment #0: after N recorded proven green-lane runs, an `earn-in-policy` widening appears in `state/autonomy.json` history **without operator touch**, is visible in the UI, and the dashboard trend shows escalations/week declining across the phase. That log is the first ever *evidence* of "asks less over time."

### Phase 5 — Release lane: Operator gate #2 gets a mechanism (M, ~1 week)

**Delivers:** the production-release gate as a working flow for target deployments: proposal → inbox → Operator approval → executed `productionReleasePath` → auditable record.
**Unblocks:** P8 (the actual regulated-pilot production deploy).
**Governing specs:** **spec work first.** FUNC-AC-RELEASE (approved) covers only runforge's own daemon; extend it (v2) to target-deployment release lanes consuming `landing.productionReleasePath` — L1 content change ⇒ **Operator gate #1** (Decision D2 bundle). Then L2/L3.

- [ ] **5.1 L1 v2 + chain** (guardian skills; the Operator approves).
- [ ] **5.2 Implement the release lane:** a `release-proposal` flow that aggregates merged-but-unreleased changes on a deployment's trunk (reuse `release.ts:70-107`'s notes assembly), raises a **release decision** in the inbox (always-escalate — this is the reserved gate, it never earns autonomy), and on approval executes the deployment's declared `productionReleasePath` via a small adapter registry: `release-sh` (self), `tag-and-deploy` (tag + deploy command from profile), `manual-runbook` (record-only: emits the approved release record and instructs the human runbook — this is the regulated pilot's likely first shape).
- [ ] **5.3 Auditable record:** every release decision + execution result appended to a per-deployment release ledger (Postgres), rendered on the dashboard `/releases` page (route already exists).
- [ ] **5.4 Prove live on cause-driven-tasks** (`tag-and-deploy`).

**Verifier/gate:** adapter tests incl. failure paths (deploy command fails ⇒ recorded failed release, no silent retry); live proof.
**Done-evidence:** execution log: the Operator approves a release in the UI; the demo repo gets a tag + GitHub release created by the daemon; the ledger row and dashboard render match.

### Phase 6 — Steering roles: wire the approved spec (M, ~1–1.5 weeks; **parallel track**)

**Delivers:** FUNC-AC-STEERING's data-declared steering roles live; the hard-coded po-agent/tech-lead path migrated or retired. Required for *full* L0 ("self-improving" as specced, and governance integrity for an approved L1); **not** on the pilot critical path — schedule parallel to P4–P7.
**Governing specs:** FUNC-AC-STEERING (approved) + its draft L2/L3 (promote as proven). No new L1 content.

- [ ] **6.1 Shadow mode first:** wire `steering/cron.ts` → `registry.ts` → `decide.ts` into the daemon tick behind a flag, emitting proposals to logs only; run beside the legacy path for several days; compare outputs.
- [ ] **6.2 Route proposals into the inbox** (spec req #6) via the existing decision-escalation ledger; budget-bounded wakings with overrun ⇒ recorded item (req #3).
- [ ] **6.3 Migrate the po-agent and tech-lead-scheduler behaviors** into role declarations; retire the hard-coded path (`daemon.ts:957-1147`) once shadow parity is shown; fix the admitted "routing not yet wired" gap (`daemon.ts:1098`) as part of migration.

**Done-evidence:** execution log: a declared steering role wakes on rhythm, scans since-last-waking, lands a shaped proposal in the Operator's inbox, and implementation starts only after the Operator's answer; legacy path removed or dark.

### Phase 7 — Regulated-pilot onboarding: the pilot, fully human-gated (M, ~1.5–2 weeks incl. soak)

**Delivers:** the regulated pilot registered as deployment #1 with a real compliance profile; the pipeline delivering pilot changes with **every merge escalated** (fleet spec: "the regulated pilot enters fully human-gated even on GREEN").
**Prerequisites:** Phase R complete (recon report + sensitive-data verdict) and D7 confirmed (§5). The config-honesty gate (cross-cutting track) must be green before this phase starts.
**Governing specs:** FUNC-AC-FLEET v2.2, FUNC-AC-COMPLIANCE-GATE (both approved) govern; the regulated pilot's **profile content** (riskPathMap, reviewers, GELB/ROT boundaries) is deployment configuration expressing L1-approved semantics — have the Operator sign off the profile as a Gate-1-adjacent content review.
**Data boundary (binding for this phase):** runforge's only touchpoint with the pilot is **repository content** — no target-database connectivity exists anywhere in the codebase (verified: the only DB config is runforge's own operational Postgres). Sensitive-data safety therefore rests on the **no-sensitive-data-in-the-repo precondition** established by Phase R.2, not on any content scanner. Semantic content-scanning is explicitly deferred — **unless** Phase R finds sensitive data in the repo, in which case a content-protection L1 chain becomes a blocker for this phase.

- [ ] **7.1 Author `regulated-pilot.config.json`** from Phase R's **revalidated** classification: GRÜN (code/tests/docs) ⇒ green paths but `defaultMinLevel` effectively escalate-all for the pilot; GELB (regulated-domain compliance requirements strained) ⇒ orange; ROT (irreducibly human regulated-domain compliance requirements — certification cycles, re-certification, signature chains) ⇒ excluded from scope entirely via riskPathMap red + containment blocked-paths. `complianceReviewers`: at least one real reviewer identity (the Operator initially). `honestAutomation` block mirrors GRÜN/GELB/ROT (and is consumed or reserved per the config-honesty gate). Verifier: the pilot's real test suite ref as confirmed by Phase R.1 (the probe requires a declared, runnable check).
- [ ] **7.2 Bug-fix pilot lane** (roadmap Phase 5a): intake from labeled pilot issues; implement → review → PR → **escalate every merge** to the inbox regardless of verdict (pilot posture), the Operator approving each from the UI.
- [ ] **7.3 Prove the compliance arm live:** one run touching a `complianceReviewers`-matched path must park with a forced-compliance decision; answer it through the inbox; confirm the auditable record.
- [ ] **7.4 Soak:** ≥10 delivered pilot changes through this lane; track escalation metric (P4) from day one.
- [ ] **7.5 Egress and provider pins for the pilot window:** configure the built-but-unset `withholding` sanitizer for pilot decision payloads (named fields on decisions leaving the daemon); pin the pilot's `roleModels` to Anthropic-only (knowledge-sync content can otherwise ride to non-Anthropic providers); assert `knowledgeSync.enabled: false` for the deployment window in the profile checklist; exclude `briefing-summarizer` from the pilot topology or document its input surface as commit subjects + run metadata only (per Phase R.3).

**Verifier/gate:** the pilot's own CI as required checks on every daemon PR; compliance gate fail-closed.
**Done-evidence:** execution log: ≥10 pilot PRs delivered by the daemon, each Operator-approved via `/steering`, incl. ≥1 live forced-compliance escalation; zero scope/containment violations in audits.

**Milestone M1 — pilot value under full human gating.** End-of-P7 is a named, legitimate steady state: runforge delivering regulated-pilot changes with every merge Operator-approved and the compliance gate live. If the autonomy tail (P4-dependent graduation, P8) slips, M1 stands on its own as delivered value. It is a checkpoint on the way to full L0, not a scope cut — P8 remains the finish line.

### Phase 8 — Graduation and the first production release (M + soak, ~2–3 weeks)

**Delivers:** the L0 moment: the regulated pilot's GREEN lane earns auto-merge via the P4 machinery, and the first production deploy of an runforge-delivered pilot change goes out through the P5 gate with the Operator's approval.

- [ ] **8.1 Earn-in over the pilot record:** when the P7 track record passes the ratified thresholds, the system **proposes** green-lane widening for the regulated pilot (earn-in floors: green only; GELB/ROT never widen); the Operator's approval of the first regulated-deployment widening is warranted (pre-approved floors were ratified for the general case; first application to a regulated deployment deserves eyes — this is applying gate-1-approved policy, not a new gate).
- [ ] **8.2 First unattended regulated-pilot GREEN merge** (verifier-gated, checks green, no operator touch) — the regulated-lane equivalent of the 2026-06-26 demo proof.
- [ ] **8.3 First production release:** release proposal aggregating runforge-delivered changes → inbox → **the Operator approves (Operator gate #2)** → `productionReleasePath` executes (likely `manual-runbook` first: the approved, audited record hands into the pilot's existing weekly release; upgrade to automated deploy later — expanding that adapter is post-plan scope, not gold-plating avoided but scope L0 defers).
- [ ] **8.4 Declare and document:** a final execution log + a short `docs/learnings/` entry stating what "production" now means operationally for deployment #1, and the escalation-trend chart over P7–P8 as the first "asks less" evidence on a regulated deployment.

**Done-evidence (= the plan's finish line):** a regulated-pilot production release containing ≥1 change that traveled issue → daemon implement → review → verifier-gated merge (≥1 of them unattended) → Operator-approved release — with the whole journey steered from `/steering`, and the metric chart showing declining operator touches per delivered change across the pilot.

### Cross-cutting track — Governance ratification (runs alongside P1–P7)

- [ ] Batch the **18 draft L1s** (FUNC-AC-PIPELINE first — the core loop must not stay unratified) into 3–4 decision-brief rounds for the Operator (the `decision-brief-app` pattern exists for exactly this), each spec diffed against its live `code_paths` before presentation (#774 theme 3: approval is a content-certification act, so present spec-vs-code deltas, not just documents).
- [ ] Promote L2/L3 specs to approved as their phases' live proofs land (e.g., ARCH/STACK-AC-VERIFIER-GATE with P2).
- [ ] Prune phantom/superseded spec nodes flagged by #774.
- [ ] **Config-honesty audit (hard pre-P7 gate):** every `DeploymentProfile` and runtime-source field either has ≥1 non-test consumer that changes runtime behavior, or the schema rejects it / marks it loudly as reserved — enforced by a CI test walking the schema against a consumer registry. Known instances to resolve (§1.5): `budget` (wired in P4.4), `landing` (consumed by P1/P5), `honestAutomation` (consume in P7 lane-selection or reserve), `capabilityBindings` (reserve or remove), `complianceVerdicts` (annotate as deliberately unsourced/fail-closed), `allowSelfRepair` (removed in P2.8), window-scheduler/fleet-capacity (delete or mark dormant — zero callers, no config wiring).

---

## 5. Decisions reserved for the Operator

The two constitutional gates, instantiated, plus the genuine forks. Each stated with a recommendation — accept or overrule, but they need answers at the phase noted.

| # | Decision | Needed by | Recommendation |
|---|---|---|---|
| D1 | **Gate #1 (spec content), batch ratification:** 18 draft L1s incl. FUNC-AC-PIPELINE, via decision-brief rounds with spec-vs-code diffs. | rolling, start now | Approve in 3–4 batches; FUNC-AC-PIPELINE + FUNC-AC-QUALITY + FUNC-AC-SAFETY + FUNC-AC-OPERATOR-AUTH in batch 1 (they gate P1–P3 work). |
| D2 | **Gate #1, plan-created L1 deltas:** (a) CONTROLLED-ARTIFACT-DELIVERY extended to code delivery (P1); (b) FUNC-AC-RELEASE v2 target-deployment release lanes (P5). | P1 / P5 start | Approve both as drafted by the guardian process; they encode what L0 v7 already ratified (single-trunk PR-gating; release as Operator-gated event). |
| D3 | **Self-target CI strictness (Gate-1 baseline):** accept the 2026-06-02 recommendation Phase 1 (one-time exit-code baseline; pre-existing red ⇒ tainted + warnings) and defer per-test fingerprinting. | P2 start | **Accept Phase 1.** The flake root-causes (RC-1..4) are fixed and guarded; fingerprinting is polish the narrow-first protocol defers. |
| D4 | **Retire raw merge entirely, even for GREEN?** P1 makes PR-gating the only path for gated deployments; the legacy raw-merge path remains only for profile-less configs. | P1 | **Yes — retire it for all gated deployments.** Branch protection on the regulated pilot makes raw pushes impossible anyway; one mechanism, no dark path. |
| D5 | **Rung-3 shape** (the deferred fork blocking auto-dismiss PR3a/3b): per-instance batch digest vs. class-level standing approval. | P4.3 | **Class-level approval with a hard bound + weekly digest + one-click revoke** — it matches L0 v7's fourth rung ("Operator-authorized autonomous application within a bound") and actually reduces asks; per-instance batching still asks every week. |
| D6 | **Production topology for deployment #0/#1 operations:** macOS-host-native daemon + Docker dashboard + Tailscale, vs. Hetzner. | P3.4 | **macOS host + Tailscale.** The OAuth/Max-token constraint (docs/running.md:116) makes native the honest posture; Hetzner stays a documented alternative until the credential story changes. Revisit after P8. |
| D7 | **Confirm the regulated pilot as the current deployment-#1 target and name the production-release approver.** The mapping is current per open epic #677 ("runforge PVS-ready", sub-issues #680/#681 open); Phase R's recon report is this decision's evidence base. | after Phase R, before P7 | Confirm the regulated pilot + name the release approver. If the pilot is unavailable in the window, the honest fallback is extending deployment #0 + cause-driven-tasks soak while an alternative regulated target is chosen — an L0-level content decision that is the Operator's alone. |
| D8 | **Dogfood order:** self (deployment #0) before the regulated pilot, no additional external dogfood target. | P2 | **Proceed as planned** — it is #774's path and the narrow-first protocol's plain reading; cause-driven-tasks already served as the external proof. |

---

## 6. Risks and honesty

**Top risks and how the plan de-risks them:**

1. **Self-target runs destabilize on real CI** (flake history; self-hosted runner contention). De-risk: D3 baseline-taint, RC-1..4 fixes already landed + guarded, P2 starts with one small issue, not a backlog. Residual: medium.
2. **PR-gated lane meets GitHub reality** (required-check latency, merge queues, token scopes). De-risk: mirror the proven spec-artifact PR path; escalate-on-timeout, never bypass; prove on the demo repo before self; the P1.5 revert lane bounds the blast radius of a bad merge (auto-revert-PR + escalation). Residual: low-medium.
3. **Steering-role migration destabilizes the live po-agent loop.** De-risk: shadow mode + parity comparison before cutover; parallel track so it never blocks the pilot. Residual: low.
4. **Regulated-pilot friction is unknown — the pilot repo was not audited in this analysis.** Its CI shape, test runtime, branch protection, and issue hygiene were assumptions; **Phase R (week 1, hard gate for D7/P7) now front-loads that discovery** instead of absorbing it inside the pilot, and the pilot's first week stays escalate-everything regardless. Residual: medium once Phase R lands; the calendar tail stays provisional until then.
5. **External scheduling removes or complicates the regulated pilot** (D7). De-risk: decision surfaced before P7 with a stated fallback. Residual: outside the plan's control.
6. **OAuth/credential fragility** (native-daemon workaround; CLI updates can break it). De-risk: creds-sync monitoring, health checks in P2.4; accept as known debt. Residual: medium, chronic.
7. **Single-operator attention** — parked decisions rot without alerts. De-risk: P3.3 out-of-band alerts land before any widening beyond deployment #0. Residual: low after P3.
8. **Widening removes fail-closed nets** (#774's own warning). De-risk: floors are constitutionally non-widening (P4.2), guarded classes stay capped, deployment-budget abort verified before graduation (P4.4).

**Confidence on the big claims:** *High* (multi-source, code-traced, independently re-verified): the ground-truth classifications in §1 — including the live auto-merge proof, the dead scope hook, the unconsumed `landing` field, the unwired steering module, and the raw-merge finding. *Medium:* effort sizing and the 10–16-week calendar (re-baselined post-review with explicit P2/P7 discovery buffers; 8–12 weeks is the everything-goes-right case — assembly work estimates well, but P2's first self-run and P7's regulated-pilot onboarding carry discovery risk, and the ratification track is Operator-throughput-bound). *Medium:* that no further unknown dead floors exist — I verified the layers named in this plan; I did not exhaustively audit every subsystem (e.g., briefing-summarizer, knowledge-sync, window-scheduler internals). *Low:* anything about the regulated-pilot repo itself (not examined). Nothing in this plan was taken from prior docs' optimism without checking: where docs claimed more than the code (steering "wired", #774's by-then-stale dead-ends 1–2, my own gatherer's first miss on the spec-pipeline live proof), the discrepancy is reported above with the evidence.
