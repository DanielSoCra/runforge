# Runforge — End-to-End Refactoring & Rewrite Plan
## From hosted control plane to portable governed core + optional infra shell

**Version:** 1.0 · **Date:** 2026-08-04 · **Repo:** `DanielSoCra/runforge`

---

## 0. Executive summary

Runforge's governance brain (lanes, merge decision, earn-in, budgets, FSM, gates) is already written as mostly-pure TypeScript. Its weight comes from one ~2,000-line composition root (`control-plane/daemon.ts`) that wires Postgres, Octokit, HTTP, and six background schedulers directly into the same function that owns the run loop.

This plan refactors Runforge into three layers — **portable core → ports/adapters → infra shell** — in **8 phases (P0–P7), ~30 PRs**, each fail-closed, gate-tested, and reversible. The end state:

- `runforge run --issue 123` executes the full governed pipeline on a laptop with **zero Postgres, zero daemon, zero dashboard** — file-based state, SQLite trace, CLI decisions.
- The existing daemon becomes a **thin composition root** calling the same `executeRun()` the CLI uses.
- The core ships as a **stampable skill** (SSSF-style) with templates, prompts, and `.specify` scaffolding.

**Non-negotiables throughout:** no behavior change until the seam is proven; every decision function gains a purity gate; deployment #0 keeps running off `main` at all times.

---

## 1. Current-state assessment (measured, not assumed)

### 1.1 What's already on our side

| Asset | Evidence | Consequence |
|---|---|---|
| Purity-gate culture | `p4-earn-in.gate.test.ts` asserts `decideMerge` stays pure | Extraction is enforceable, not aspirational |
| Implicit ports already exist | `ConfigReader`, `RunWriter`, `RepoDataSource`, `RunHistoryReader` (in `src/data/`), `ProviderAdapter`, `TrunkReader`, `PromotionPort` | P2 formalizes rather than invents |
| One-shot CLI already exists | `main.ts` → `processSingleIssue(issue, config)` | P4's CLI is an evolution, not greenfield |
| Run state is already file-based | `StateManager` over `state/` dir survives crashes; Postgres is used for *reporting/history*, not the run loop | The portable path needs no new state machinery |
| Agent adapters for 3 CLIs | `session-runtime/adapters/`: `cli.ts` (claude), `codex-cli.ts`, `pi-cli.ts` | Core speaks the same agent runners SSSF does |
| Worktree isolation exists | `workspace.ts`, `workspace-bootstrap.ts` | SSSF's gap is already solved here |
| Fail-closed boot guards | A1 boot guards, degraded server, decision-index availability checks | The philosophy to preserve, not retrofit |

### 1.2 The actual problem (with file evidence)

`control-plane/daemon.ts` (~2,000 LOC) currently owns, in one function scope:

1. **Boot validation** (env, runtime source, prompt contracts, workspace trust)
2. **Postgres wiring** (`createDbClient`, `createPostgresStores`, five data readers/writers)
3. **Degraded-startup server** + bounded retry + port handoff
4. **Release lane construction** (Octokit `TrunkReader`, `PromotionPort`, drill gate)
5. **Six background schedulers**: knowledge-sync, knowledge-maintenance, remote-control, review-scheduler, PO agent, tech-lead scheduler, coordinator (feature-flagged)
6. **Control server with ~30 routes** (status, health, pause/halt/resume/drain, retry, release ×3, decisions ×4, autonomy, metrics, spend ×6, PO ideas/sessions)
7. **Work polling loop** with detect-gate serialization, stuck backoff, decision-owned skip sets
8. **`resumeParkedRuns`** — the largest single flow: l2-gate + integrate park resumption, cockpit answer recognition, ledger state machine, label choreography
9. **Crash resumption**, watchdog, heartbeat, drain/shutdown, signal handlers

And `processWorkRequest()` (the single-run spine) is **trapped inside** this closure — it captures `dailyRunState`, `handleRunOutcome`, `activeIssues`, and a dozen daemon-scoped services. That is the extraction target.

### 1.3 Dependency classification (from direct source inspection)

```
PORTABLE-CORE CANDIDATES (pure or fs/git-only)
├── control-plane/merge-decision/     decide.ts, compliance.ts, risk-class.ts, observe-verifier.ts, touched-paths.ts
├── control-plane/lane-engine/        match.ts, assign.ts, risk.ts, gate-set.ts, tripwire.ts, eligibility.ts,
│                                     earn-in.ts, outcome-ledger.ts, resolve-mode.ts, schema.ts, verifier-gate/
├── control-plane/earn-in/            floors, promotion-policy, track-record, mint, debut, demote-on-red
├── control-plane/spend/              budget arithmetic (NOT the Postgres read model)
├── control-plane/fsm.ts, variants.ts, workflow-types.ts, builtin-workflows.ts
├── control-plane/classifier*.ts, batch-classifier*.ts (schemas + pure logic)
├── control-plane/phases.ts + pipeline.ts + checkpoint.ts (orchestration spine)
├── control-plane/deployment-budget.ts (check/record — pure over injected deps)
├── control-plane/revert-lane.ts (decision-id building, reversal logic)
├── session-runtime/                  runtime.ts, adapters/, providers/, cost.ts, scope-*, containment-hooks
├── implementation/coordinator.ts     (worker coordination — verify deps in P1)
├── decision-escalation/              build-request, parse/resume consumer logic (pure parts)
└── types.ts, lib/result.ts, lib/json-store.ts, lib/process.ts

ADAPTERS (port implementations)
├── data/config-reader.ts, run-writer.ts, repo-source.ts, run-history.ts  → Postgres adapter
├── decision-escalation/manager.ts + ledger                               → Postgres adapter (SQLite variant NEW)
├── release/release-ledger-manager.ts                                     → Postgres adapter (SQLite variant NEW)
├── work-detection.ts, repo-manager.ts                                    → GitHub adapter
├── decision-escalation/github-block-notifier.ts, answer-publisher.ts     → GitHub adapter
├── notify.ts                                                             → webhook adapter
├── phases-website.ts                                                     → deployment-specific adapter

INFRA SHELL (stays heavy, gets thin)
├── control-plane/daemon.ts, server.ts, degraded-server.ts, decision-api.ts
├── control-plane/repo-manager.ts (polling loop), watchdog.ts, heartbeat.ts, health.ts
├── coordination/ (PO agent, tech-lead, review scheduler, coordinator)
├── knowledge/, knowledge-sync/, operator-learning/ (product extras — decision needed, see P6)
├── packages/dashboard, packages/db (drizzle schema), deploy/, infra/, scripts/
└── remote-control.ts, startup-retry.ts, crash-handlers.ts
```

---

## 2. Target architecture (final state)

```
runforge/                                  (same monorepo, new boundaries)
├── packages/
│   ├── core/                    ← NEW: @runforge/core — the portable brain
│   │   ├── src/
│   │   │   ├── envelopes/       run state, phase results, typed outputs
│   │   │   ├── pipeline/        fsm, variants, workflow defs, runPipeline, checkpoint
│   │   │   ├── phases/          phase handler contracts + code-phase impls (test/lint/commit/worktree)
│   │   │   ├── governance/      lane-engine, merge-decision, earn-in, risk, budgets, tripwires
│   │   │   ├── decisions/       protocol types, id builders, answer parsing, file-inbox logic
│   │   │   ├── agents/          ProviderAdapter port + claude/codex/pi adapters, cost, scope enforcement
│   │   │   ├── workspace/       worktree manager, repo bootstrap (git CLI only)
│   │   │   ├── state/           StateManager (file run state) + SQLite trace (NEW)
│   │   │   ├── ports/           Store, QueueSource, DecisionTransport, Notifier, TrunkReader, Clock
│   │   │   └── execute-run.ts   THE single-run entrypoint (one function, all modes)
│   │   └── package.json         deps: NONE of @runforge/* ; node builtins + drizzle-free
│   ├── adapters-sqlite/         ← NEW: Store + DecisionLedger + ReleaseLedger over SQLite (PGlite or better-sqlite3)
│   ├── adapters-github/         ← moved: work-detection, repo-manager read-side, publishers, notify-webhook
│   ├── adapters-postgres/       ← moved: packages/db + src/data/* Postgres impls
│   ├── daemon/                  ← SHRINKS to: boot, schedulers, HTTP server, polling, wiring
│   ├── dashboard/               ← unchanged consumer, repointed at Store port
│   ├── decision-protocol/       ← RETIRED: zod-only types/schemas, merges cleanly INTO core/decisions
│   ├── decision-index/          ← SPLIT: state machine + read model → core; drizzle writer → adapters-postgres;
│   │                              already has port contracts (Notifier, SourceSink, ResumeDispatcher) + fakes — P2 formalizes, doesn't invent
│   └── release-ledger/          ← same split (writer/reader types → core port, drizzle impl → adapters)
├── .claude/skills/runforge/     ← NEW (P5): SKILL.md, cookbooks/, scripts/install.py, templates/
├── prompts/                     ← stays; becomes skill template input
└── .specify/                    ← stays; methodology gains "layering" spec + traceability rows
```

**The one-rule test:** `pnpm --filter @runforge/core build` must succeed with `node_modules` containing zero `@runforge/*` siblings and zero Postgres/HTTP clients. CI enforces it (P0).

---

## 3. Phase plan

Each phase = a set of PRs. Every PR: immovable acceptance gate written RED first (your established convention), deep-review rounds, traceability updates. Sequencing is strict within a phase, parallel across where noted.

---

### P0 — Guardrails & characterization baseline (PRs 1–3)

**Goal:** make the current behavior unchangeable-by-accident before touching anything.

| PR | Scope | Acceptance gate |
|---|---|---|
| 1 | **Import-boundary lint + architecture gate.** ESLint `import/no-restricted-paths` zones matching §1.3 (initially all "warn" except: nothing new may import `daemon.ts`). Gate test `architecture-boundaries.gate.test.ts` walks the import graph and snapshots current violations to a checked-in baseline file | Gate fails if the violation baseline *grows*; shrinking updates the file |
| 2 | **Characterization harness for the run spine.** Golden-fixture tests around `processWorkRequest` + `runPipeline` + `resumeParkedRuns`: recorded mock responses (Octokit, ProviderAdapter, StateManager) replayed end-to-end for 5 canonical runs (green merge, parked l2-gate → approve, integrate park → reject → rework, reversal-raised, budget abort) | 5 golden runs byte-stable on `main`; must stay green through every later phase |
| 3 | **Deployment #0 freeze kit.** Snapshot live config + state dir schema + label choreography into `docs/deploy/frozen-baseline.md`; add CI job running the daemon's existing full suite on every refactor PR (already exists — pin it as required) | Ops runbook updated; no PR merges without full suite |

**Risk:** golden fixtures over-fit to incidental JSON key order → normalize before snapshotting.
**Rollback:** trivial (additive only).

---

### P1 — Extract the governance brain into `packages/core` (PRs 4–8)

**Goal:** pure moves. No behavior change, no new ports yet — just relocation behind an import boundary.

| PR | Moves | Notes |
|---|---|---|
| 4 | `merge-decision/`, `lane-engine/`, `earn-in/` → `core/governance/` | They are already purity-gated; re-point imports via `index.ts` barrels. The `decideMerge-stays-pure` gate moves with them and now also asserts *zero imports outside core* |
| 5 | `fsm.ts`, `variants.ts`, `workflow-types.ts`, `builtin-workflows.ts`, `pipeline.ts`, `checkpoint.ts`, `classifier*.ts` → `core/pipeline/` | `runPipeline` is the spine; verify it takes all services as params (it does: handlers, stateMgr, costTracker…) |
| 6 | `spend/` budget arithmetic, `deployment-budget.ts` (check/record only) → `core/governance/budgets/` | Postgres read model stays behind; only pure calc moves |
| 7 | `session-runtime/` → `core/agents/` | Adapters (`cli`, `codex-cli`, `pi-cli`), cost, scope-enforcement, containment-hooks, providers. **Check:** `runtime.ts` prompt-cache + governance-context loading — extract prompt loading behind a `PromptSource` port with a file impl |
| 8 | `workspace.ts`, `workspace-bootstrap.ts`, `lib/` (result, json-store, process) → `core/workspace/`, `core/lib/` | git CLI only; no Octokit allowed here |

**Acceptance:** P0 golden runs green; `architecture-boundaries` baseline shrinks by exactly the moved set; `@runforge/core` builds standalone (the one-rule test, initially with a temporary pass on residual violations listed in the baseline).

**Effort:** ~40% mechanical (move + rewire imports), 60% untangling barrel cycles. Expect 2–3 hidden circulars through `types.ts` — break them by hoisting shared types into `core/envelopes/`.

---

### P2 — Formalize the ports (PRs 9–13)

**Goal:** every infra dependency becomes an interface **owned by core**, with the current Postgres/GitHub code re-registered as the first adapters.

| PR | Port | Defined from existing code |
|---|---|---|
| 9 | `RunStore` (insert/upsert/history), `ConfigSource`, `RepoRegistry` | Generalizes `RunWriter`/`ConfigReader`/`RepoDataSource`/`RunHistoryReader` — they already are interfaces; move the *definitions* into core, impls → `adapters-postgres` |
| 10 | `DecisionLedger` | Extract from `DecisionIndexManager.ledger()` surface: `raise, answer, statusOf, advanceToResumed, reconcile, reader`. The Postgres writer becomes `adapters-postgres/decision-ledger` |
| 11 | `ReleaseLedger` + `TrunkReader` + `PromotionPort` | Already port-shaped (`createReleaseLane` takes them); move type definitions to core, Octokit `TrunkReader` → `adapters-github` |
| 12 | `QueueSource` (detectReadyWork/claimWork/markStuck + bug/feature variants) | From `work-detection.ts` — split the *polling strategy* (pure: backoff, detect-gate, decision-owned skip) into core; Octokit calls → `adapters-github` |
| 13 | `DecisionTransport` (publish request, read answer), `Notifier`, `Clock` | From `github-block-notifier`, `answer-publisher`, `resume-consumer` parsing (parsing logic is pure → core; posting → adapter) |

**Acceptance:** every port has (a) a contract test suite in core run against *all* adapter impls (the classic port-adapter pattern — one suite, N impls), (b) the Postgres/GitHub adapters passing it unchanged. Golden runs still green.

**Key design decision (document as an L2 spec):** `DecisionTransport` and `DecisionLedger` are separate ports. The ledger is the audit state machine; the transport is how a human sees/answers it. File-inbox, GitHub comments, and the cockpit HTTP API are three transports over one ledger.

---

### P3 — The portable adapters (PRs 14–17) — *this is the rewrite-heavy phase*

| PR | Deliverable | Detail |
|---|---|---|
| 14 | **`adapters-sqlite`: SqliteStore + SqliteDecisionLedger + SqliteReleaseLedger** | **De-risked by current state:** PGlite is already a devDependency of `decision-index`, `release-ledger`, and `sanitizer-redaction` (their gate tests run against it), and `packages/db` already has a `schema-parity` test pattern to reuse for dialect drift. Extend the shared drizzle schema → two dialects (postgres + sqlite via PGlite), with a parity gate so the two can never drift |
| 15 | **File decision inbox transport** | `decisions/pending/{id}.json` written on raise; watcher/poll for `decisions/answered/{id}.json`; CLI command `runforge decisions list/show/answer` reads/writes these. Same idempotency keys and epoch semantics as the cockpit path (reuse core parsing from P2) |
| 16 | **CLI notifier + stdout trace renderer** | `notify` port impl printing structured alerts; NEW: append run events to a SQLite trace table (SSSF-inspired: sessions/phases/events/envelopes) — additive, not replacing run state |
| 17 | **Local `QueueSource`** | `runforge run --issue N` fetches that single issue via `adapters-github` (thin) OR reads `runforge run --prompt "..."` / `--prompt-file` for GitHub-free local work — the SSSF-style entry mode Runforge lacks today |

**Acceptance:** the P2 contract suites pass against every new adapter; a new golden run executes end-to-end using **only** SQLite + file adapters (with mocked agent runner) — no Postgres process anywhere.

**Risk:** PGlite native-WASM packaging friction in the skill context → fallback adapter on `better-sqlite3` behind the same port; decide after a spike in PR 14 (timebox: 1 day). Note the daemon itself carries **no direct Postgres dependency** (it reaches storage only via the workspace packages) — so once P2/P3 land, the daemon is storage-agnostic for free; the only Postgres-touching code is inside the three storage packages.

**Also moves to core:** `@runforge/sanitization` (zod-only: pipeline, registry, config — domain-blind middleware host). Its concrete sibling `@runforge/sanitizer-redaction` is Postgres-backed → adapter, with a file-backed `ProtectedStore` variant as the portable impl (its `defaultProtectedDir` already hints at a file mode).

---

### P4 — `executeRun()` and the real CLI (PRs 18–21) — *the pivotal extraction*

**Goal:** the run spine leaves `daemon.ts`.

| PR | Deliverable |
|---|---|
| 18 | **`executeRun(deps, request)` in core.** Lift `processWorkRequest` out of the daemon closure: every captured daemon-scope variable becomes an explicit dep (`budgetDeps`, `onOutcome`, `isPaused`, `isHalting`, …). `createPhaseHandlers` moves to core with all ~20 params grouped into a `PhaseServices` object (config, agents, state, ledger, transports, registry, notify) |
| 19 | **Park/resume cycle into core.** `resumeParkedRuns`' per-run logic (l2-gate + integrate + reversal recognition, ledger ordering, label choreography) becomes `resumeDecisionParkedRun(deps, run)` in core — the *scan* loop stays in the daemon, the *decision logic* moves. GitHub label operations sit behind the already-moved transport port |
| 20 | **CLI v2:** `runforge run` (single run, portable adapters by default, `--postgres` flag to opt into infra adapters), `runforge decisions`, `runforge trace` (read the SQLite trace), `runforge lanes check` (validate config + verifier falsifiability offline) |
| 21 | **Daemon rewired to call `executeRun()`.** `daemon.ts` sheds ~800 lines: work detection per-tick still lives here, but dispatch is one call. Prove equivalence: P0 golden runs + a **dual-run shadow test** (same input through old commit's daemon vs new core, diff outcomes) run once in CI against recorded fixtures |

**Acceptance (the litmus test, automated):** `runforge run --issue 123 --config runforge.config.json` on a clean checkout with no `RUNFORGE_DATABASE_URL` executes detect→classify→implement→verify→gated-merge-proposal→parked release decision, writes a file decision, resumes on `runforge decisions answer`, and the trace DB contains the full event stream.

**Rollback strategy:** the old `processWorkRequest` stays in-tree (marked `@deprecated`) until P7; the daemon can be re-pointed via a single feature flag.

---

### P5 — The stampable skill (PRs 22–24)

| PR | Deliverable |
|---|---|
| 22 | **`scripts/install.py` equivalent (`install.mjs`) + templates/.** Stamps into a target repo: `runforge.config.json` (lanes skeleton), `prompts/` subset, `.specify/` methodology + traceability skeleton, `justfile`/`package.json` scripts. Idempotent, skip-existing, `--force` with the same warnings SSSF documents |
| 23 | **`.claude/skills/runforge/SKILL.md` + cookbooks.** SKILL.md = hard rules + routing table (install, run, decide, trace, extend); cookbooks: `install.md`, `run-a-pipeline.md`, `author-a-lane.md`, `write-a-verifier.md`, `operate-decisions.md`, `go-unattended.md` (the last one explains when you *do* want the daemon — honest upsell, SSSF-style) |
| 24 | **Docs: honesty table.** "Where it can still fail" for the portable mode (agent hangs, SQLite lock contention, file-inbox races, unconfigured verifiers = no merge rights). This table is a Runforge/SSSF cultural signature — keep it |

**Acceptance:** stamp into a fresh demo repo, run the full pipeline on a toy issue, produce a merge proposal + trace. Script this as CI (`skill-smoke` job).

---

### P6 — Daemon slimming & product decisions (PRs 25–27)

| PR | Deliverable |
|---|---|
| 25 | **Daemon as composition root.** Target ≤400 lines: boot guards, adapter selection (env-driven: `RUNFORGE_STORE=sqlite\|postgres`), schedulers, HTTP server, polling → `executeRun`. The ~30 routes become thin adapters over core services; route handlers move into `daemon/src/routes/` one file per concern |
| 26 | **Dashboard boundary clarified.** Findings show the dashboard (Next.js 16 + better-auth) talks to Postgres **directly** via drizzle, not through daemon ports. That is acceptable: the dashboard is *definitionally* infra shell. Leave it on the Postgres adapter; do NOT force it through the portable Store port. Only ensure its read paths use the same drizzle schema the adapters generate |
| 27 | **Product decision gate (Operator sign-off required):** fate of `coordination/` (PO agent, tech-lead, review scheduler), `knowledge*/`, `operator-learning`, and especially **`concierge` (four long-running processes: core/observer/memory/board + Slack) and `briefing-summarizer` (standalone interval process)** — findings confirm these are a separate personal-assistant product, not factory machinery. Options: (a) keep as infra-shell opt-ins, (b) extract to a separate repo, (c) retire. **Recommendation: (b)** — they have their own specs and process model; extraction is a repo move, not a rewrite, and it sharpens Runforge's identity as *the factory* |

**Acceptance:** daemon boots with `RUNFORGE_STORE=sqlite` for a single-repo deployment (no Postgres at all), and with `postgres` for deployment #0 unchanged.

---

### P7 — Hardening, deprecation, v1.0 (PRs 28–30)

1. **Delete the deprecated paths** (old `processWorkRequest`, retired packages `decision-protocol`/`decision-index` shells after merge into core/adapters) — only after two weeks of deployment #0 running on P6 code.
2. **Public-release readiness completion:** secret scan automation, repo cutover checklist, SECURITY.md, the "honest limits" README section updated for the layered world.
3. **v1.0 spec ratification:** L1/L2 spec diff package (your established read-and-sign process) ratifying the layering as the new architecture of record; `traceability.yml` final sweep; methodology spec gains the **layering invariant**: *core may not import ports' implementations; ports may not know transports; the daemon is wiring only* — enforced by the P0 gate, now with zero baseline violations.

---

## 4. Cross-cutting strategies

### 4.1 Testing strategy (three rings)

| Ring | What | When it runs |
|---|---|---|
| **Purity gates** | Import-graph assertions per decision function (extends `decideMerge-stays-pure` pattern to all of `core/governance/`) | Every PR |
| **Port contract suites** | One suite per port × all adapters (SQLite, Postgres, file, GitHub-mocked) | Every PR |
| **Golden runs** | P0's 5 recorded end-to-end runs + the P4 litmus run + skill-smoke | Every PR (recorded), nightly (live on staging repo) |

### 4.2 Spec-driven process (dogfood the dogfood)

- The refactor itself runs through Runforge lanes: each PR is an issue → lane → verifier → governed merge. The refactor is the largest single validation of the system it produces.
- Every phase ends with an L3 spec update + traceability rows; P7 ratifies L1/L2.

### 4.3 Risk register (top 5)

| Risk | Likelihood | Mitigation |
|---|---|---|
| Hidden daemon-closure coupling makes P4 spiral | High | P0 golden runs + P1's explicit-dep discipline; timebox each P4 PR, split rather than swallow |
| SQLite/Postgres semantic drift in ledger state machines | Medium | P2 contract suites run against both; shared drizzle schema with dialect generation (P3) |
| Deployment #0 regression mid-refactor | Medium | Freeze kit (P0.3); daemon always deployable from `main`; old spine behind flag until P7 |
| Scope creep: "while we're in here" improvements | High | Hard rule: no behavior change PRs during P1–P4 except bugfixes filed separately |
| Skill packaging dumbs down governance (users stamping without verifiers) | Medium | `lanes check` fails hard on missing/fake verifiers; install stamps a *guarded* default (no auto-merge lane until earn-in exists) |

### 4.4 Sequencing overview

```
P0 (baseline)          ████                                    wk 1–2
P1 (extract brain)         ████████                            wk 2–5
P2 (ports)                      ████████                       wk 4–7   (overlap w/ P1 tail)
P3 (portable adapters)               ██████                    wk 6–9
P4 (executeRun + CLI)                     ████████             wk 8–12  ← pivotal
P5 (skill)                                     ████            wk 11–13
P6 (daemon slim + product gate)                 ██████         wk 12–15
P7 (v1.0)                                              ████    wk 15–16
```

Solo operator with agent workforce. Calendar time compresses ~40% if the refactor runs through the Runforge pipeline itself with earned autonomy on the mechanical PRs (moves, import rewiring) — which it should; that's the demo.

---

## 5. Definition of done (the whole program)

1. `runforge run --issue N` executes the governed pipeline with zero Postgres, zero daemon — proven in CI on a clean container.
2. `@runforge/core` builds with zero `@runforge/*` and zero network-client deps — import-boundary gate at zero violations.
3. Daemon ≤400 lines of wiring; deployment #0 runs it with Postgres adapters, a fresh laptop deployment runs the same code with SQLite adapters.
4. The skill stamps into an empty repo and produces a merge-proposed, trace-recorded run in under 15 minutes of setup.
5. Every port has contract suites passing against ≥2 adapters.
6. The layering invariant is an L2 ratified spec, enforced by CI, listed in `FACTORY_RULES.md`.
7. The README's "Limits" section shrinks: "requires Postgres/daemon" stops being true.


---

## Appendix A — Package-level findings (direct source inventory, 2026-08-04)

Grounding for the phase plan; full API surfaces mapped from `main`.

| Package | Runtime deps | Layer verdict |
|---|---|---|
| `@runforge/db` | drizzle-orm, postgres, zod | **Adapter.** 9 store interfaces (`Repo/Run/CostEvent/Credential/Plugin/Briefing/Settings/GitHubConnection/OperatorAuth`) are the natural `RunStore`/`ConfigSource` port basis. Has `schema-parity` test — reuse for dialect drift |
| `@runforge/decision-protocol` | **zod only** | **Core.** Pure protocol types, state-machine constants, zod schemas. Merge into `core/decisions`, retire package |
| `@runforge/decision-index` | drizzle, postgres, ajv, ulid | **Split.** State machine + read model + priority → core; `IndexWriter` (drizzle) → Postgres adapter. Already defines `Notifier`/`SourceSink`/`ResumeDispatcher` contracts **with fakes** — the port-adapter pattern exists here in embryo. PGlite in devDeps |
| `@runforge/release-ledger` | drizzle, postgres | **Split** (same pattern). PGlite in devDeps |
| `@runforge/sanitization` | **zod only** | **Core.** Domain-blind sanitizer port + ordered pipeline + registry |
| `@runforge/sanitizer-redaction` | drizzle, postgres | **Adapter** (+ file-backed `ProtectedStore` variant for portable mode) |
| `@runforge/auth` | **zero** | **Shell.** Dashboard concern (better-auth config, role gating, local bypass) |
| `@runforge/dashboard` | Next.js 16, better-auth, drizzle | **Shell.** Talks to Postgres directly — leave it there (P6 PR 26) |
| `@runforge/concierge` | hono | **Separate product** (4 processes + Slack). Extract in P6 |
| `@runforge/briefing-summarizer` | `@runforge/db`, Anthropic SDK | **Separate product** (standalone interval process). Extract in P6 |
| `@runforge/daemon` | octokit, MCP sdk, commander, zod; **no direct postgres** | **Shrinks to shell.** Storage-agnostic the moment P2/P3 land |

**Three findings that change the plan's risk profile (all positive):**
1. The daemon never imports `postgres` — storage swap is contained to three packages.
2. PGlite is already battle-tested in-tree (three packages run gate tests against it) — the portable-storage spike is mostly done.
3. `decision-index` already ships adapter contracts with fakes — P2 is largely *moving and generalizing* proven seams, which fits the "no behavior change" discipline of P1–P2.
