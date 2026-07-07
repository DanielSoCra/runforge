---
date: 2026-06-11
status: NON-NORMATIVE — illustrative example data, not specification
type: default-config-pack-example
topic: The one place policy values live — default pipeline configuration example (masterplan D10)
related:
  - docs/superpowers/specs/2026-06-11-runforge-vnext-masterplan-design.md  # D5, D7, D10, D11, §6
  - .specify/functional/merge-decision.md   # mechanism: lanes, tripwire, earn-in
  - .specify/functional/plugins.md          # mechanism: role registry, config packs
  - .specify/functional/fleet.md            # mechanism: capacity pools, windows
  - .specify/functional/runtime-adapters.md # mechanism: runtime contract, smoke test
---

# Default Config Pack — Non-Normative Example

> **This document is data, not specification.** Per masterplan decision **D10**, specs define mechanisms only; every routing, threshold, assignment, and schedule value lives in editable configuration — shipped as a preconfigured default pack, changeable at runtime, never normative. This file is the **single** illustrative example the spec chain references. Nothing here is a requirement: every value below can be edited in the pack without touching a spec or the platform. If a value here ever contradicts a spec, the spec wins by definition — and the contradiction means this example is stale.

## Pack identity

```yaml
pack: default-pipeline
version: 1.0.0   # packs are versioned and immutable per version; deployments bind to a version
```

## Lanes (example initial set, runforge deployment #0)

```yaml
lanes:
  - name: trivial
    qualify: { complexity: [simple], changeKind: [docs, formatting, dependency-refresh] }
    allowedPaths: ['docs/**', '**/*.md', 'package.json', 'pnpm-lock.yaml']
    roleRouting: { implement: cheap-implementer, review: frontier-reviewer }
    gateSet: gate1-deterministic-only
    mergePolicy: auto
    postMergeReview: { enabled: true, cadence: nightly }
    earnIn: { cleanMerges: 10, bounceFreeDays: 3 }
  - name: standard
    qualify: { complexity: [standard, complex] }
    allowedPaths: ['**']            # standard lane is scope-unbounded; tripwire still runs
    roleRouting: { plan: frontier-planner, implement: cheap-implementer, review: frontier-reviewer }
    gateSet: full-ladder            # deterministic gates + adversarial review + holdout
    mergePolicy: review-then-auto
    postMergeReview: { enabled: true, cadence: nightly }
    earnIn: { cleanMerges: 20, bounceFreeDays: 7 }
mostCautiousLane: standard-hold     # hold-for-operator variant used for fallback assignment
```

## Deployment lifecycle modes (FUNC-AC-MERGE-DECISION v2.1; Operator, 2026-06-11)

> "First go fast and messy, then clean up, then be clinical when released." Modes scale lane gate rigor; they never bypass invariants (tripwire, always-escalate set, verification requirement, compliance). Transitions are Operator DecisionRequests, never automatic.

```yaml
lifecycleModes:
  phases: [velocity, hardening, clinical]   # names are pack data, not spec
deployments:
  regulated-pilot: { lifecyclePhase: velocity }   # pre-production (2026-06): wider
                                               # autonomous scope, lighter per-lane
                                               # gate-sets; QA + review weight stays
                                               # high — trust rests on QA results.
                                               # clinical from first production release.
  runforge:  { lifecyclePhase: hardening }
```

Per-mode lane variance (only `gateSet` and `mergePolicy` may vary by phase):

```yaml
lanes:
  - name: standard            # regulated-pilot deployment override, illustrative
    gateSet:     { velocity: gate1-plus-review, clinical: full-ladder }
    mergePolicy: { velocity: review-then-auto,  clinical: hold }
```

## Model ladder & role registry defaults (D7)

> Objective (FUNC-AC-FLEET v2.1): **intelligence-fit** — the cheapest tier that
> sustains each lane's quality bar. Fit telemetry: iterations-to-green and
> review-rejection rate per tier and task class. Not raw cost minimization.

```yaml
roles:
  frontier-planner:   { provider: claude-cli,  model: opus-4.x,        budgetUsd: 8 }
  cheap-implementer:  { provider: pi-cli,      model: kimi-k2.6,       budgetUsd: 3,
                        fallbackModels: [deepseek-v4, gemini-flash] }
  frontier-reviewer:  { provider: claude-cli,  model: opus-4.x,        budgetUsd: 6,
                        fallbackProviders: [codex-cli] }
  # Checklist-shaped structured work (classification, spec-compliance checks,
  # reporting) routes to the cheapest adequate model; adversarial quality and
  # security review stays frontier. (Assignment substance salvaged from the
  # retired ARCH-AC-MODEL-TIER draft on feature/467 — per D10 it is pack data,
  # not a fixed table in a spec.)
  fast-structured:    { provider: pi-cli,      model: gemini-flash,    budgetUsd: 0.5 }
```

## Providers & capacity pools (window-aware failover; masterplan Q1)

```yaml
providers:
  claude-cli: { pool: claude-max,   nativeGuardHooks: true }
  codex-cli:  { pool: chatgpt-pro,  nativeGuardHooks: false }
  pi-cli:     { pool: openrouter,   nativeGuardHooks: false }
  # cursor: NOT wired (adapter interface is generic; wire later by config + adapter)
pools:
  claude-max:  { window: 5h-rolling, preferenceRank: 1 }   # Claude-preferred
  chatgpt-pro: { window: provider-reported, preferenceRank: 2 }
  openrouter:  { window: pay-per-use, preferenceRank: 3 }
```

## Steering policy (D9)

```yaml
steering:
  agents:
    - { role: product-owner, rhythm: every-6h, budgetUsd: 2 }   # ancestor: po-agent.ts
    - { role: tech-lead,     rhythm: daily,    budgetUsd: 2 }   # ancestor: tech-lead-scheduler.ts
  ideaPath: [research-task, tech-lead-consult, operator-inbox-proposal]
```

## Stability bar — confirmed initial value (masterplan Q4, Operator-confirmed 2026-06-11)

The merge-decision and operator-surface specs reference a *configured stability bar*; this is its confirmed initial value, gating (a) the regulated pilot's GREEN/YELLOW autonomous merge and (b) the start of the cockpit-consumer fold:

```yaml
stabilityBar:
  unattendedDays: 7            # zero manual rescues throughout
  canary: canary-deployment    # risky behaviors prove on the canary, never the regulated pilot
  e2eSmokeRuns: { issue: 681, requiredPasses: 2 }
  manualRescues: 0
```

## Other defaults collapsed from the Q1–Q8 brief (masterplan §6)

```yaml
postMergeBatchReview: on-for-auto-merge-lanes     # nightly
regulatedPilotFastLanes: earn-in                      # 20 clean merges + 7d zero bounces
notesAndRunVerbs: enabled
adapterSmokeTest: on-startup-and-on-wiring-change
```

---

*Edit freely. That is the point.*
