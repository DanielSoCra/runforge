---
id: ARCH-AC-WINDOW-SCHEDULER
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-FLEET
---

# ARCH-AC-WINDOW-SCHEDULER — Capacity-Pool Window Scheduler

## Overview

The Window Scheduler realizes FUNC-AC-FLEET's capacity-pool behavior. It maintains a per-pool ledger of consumption against each pool's rolling usage window, is consulted by the Provider Registry during provider resolution so that work prefers pools with headroom and avoids exhausted ones, classifies exhaustion signals so a spent window triggers failover rather than a global stall, and stamps every session outcome — review outcomes above all — with the pool, provider, and model that served it, persisting that provenance for quality-drift analysis. It schedules nothing itself: it is a ledger plus an advisory filter that the existing resolution and pause machinery consult.

## Data Model

A **CapacityPool** is a named, configured source of reasoning capacity — typically one subscription or account. It contains: a unique pool name; the set of provider names that draw on it (one pool may back several providers; every provider belongs to exactly one pool); the pool's window shape (rolling window length, and whether the reset is rolling-from-first-use or fixed-schedule); the signal sources the ledger may use (provider-reported remaining quota, rate-limit responses carrying retry-after, observed throttling); and an Operator-configured preference rank. Pool membership, window shapes, and preference ranks are configuration data read at startup and on configuration reload; the scheduler validates shape, not values.

A **WindowLedger** entry tracks one pool's current window: window start, estimated consumption within the window (in the pool's native unit where reported, otherwise in session counts as a proxy), an estimated headroom state (ample, tight, exhausted, unknown), the evidence for that state (last signal kind and timestamp), the projected reopen time when exhausted, and an observed-reset timestamp. The ledger is persisted in the Database so window state survives daemon restarts; on restart with stale evidence the state degrades to unknown rather than assuming ample.

A **PoolOutcomeProvenance** record stamps one completed session with: run identifier, session role, pool name, provider name, model binding, window state at dispatch, and timestamp. For review sessions the record is additionally linked to the review verdict, so review quality can later be grouped and compared per pool from records alone. Provenance is written with the session result, in the same persistence step.

A **PoolExhaustionEvent** records a transition to exhausted: pool name, the triggering signal, the projected reopen time, the work affected (paused or failed over), and a timestamp. It feeds the dashboard and Operator notifications.

## API Contract

The Window Scheduler exposes four operations, all internal.

**Filter and rank candidates** — Called by the Provider Registry during provider resolution, after tier and health filtering. Request: the ordered candidate provider list for a spawn. Response: the same candidates re-ordered and annotated — providers whose pool is exhausted are excluded, providers whose pool is tight are deprioritized below ample ones within the same preference rank, and unknown is treated as tight (usable, but not preferred). The registry's own resolution semantics (preferred, fallback chains, health, cooldown) are otherwise unchanged; the scheduler only filters and re-ranks.

**Report consumption** — Called by the Session Runtime after every session attempt, alongside the existing outcome report. Request: provider name, session cost and unit metadata, any quota signals observed in the provider's responses. Effect: update the pool's WindowLedger consumption estimate and headroom state; write the PoolOutcomeProvenance record.

**Report exhaustion signal** — Called when a session attempt fails with a signal classified as window exhaustion (as opposed to a momentary rate limit). Request: provider name, signal evidence, optional provider-stated reopen time. Effect: mark the pool exhausted with the projected reopen time, emit a PoolExhaustionEvent, and leave all other pools untouched. The classification rule: a retry-after or quota signal whose duration or wording indicates the recurring window (long-horizon) marks the pool exhausted; a short-horizon throttle stays a per-provider cooldown in the Provider Registry and never marks the pool.

**Query pool state** — Called by the dashboard/operator surface. Request: none or a pool name. Response: each pool's headroom state, evidence, projected reopen, and recent provenance counts. Read-only.

## System Boundaries

- Window Scheduler OWNS: CapacityPool registrations, WindowLedgers, PoolOutcomeProvenance, PoolExhaustionEvents, and the exhaustion-vs-throttle classification rule.
- Window Scheduler IS CONSULTED BY: the Provider Registry (filter and rank during resolution) and the operator surface (query). It is REPORTED TO by the Session Runtime (consumption, exhaustion signals).
- Window Scheduler NEVER: selects a provider (the registry does), spawns or pauses sessions (the Session Runtime and Daemon Control Plane do), changes preference ranks (configuration does), or interprets review content (it stamps provenance; analysis is a consumer's job).
- The relationship to per-provider cooldown (ARCH-AC-SESSION-PROVIDERS) is compositional and disjoint: cooldown is short-horizon, provider-scoped, owned by the Provider Registry; window exhaustion is long-horizon, pool-scoped, owned here. A pool marked exhausted excludes all its providers at once, even those individually healthy.
- The all-pools-exhausted condition is surfaced to the Daemon Control Plane through the existing provider-unavailable pathway, reusing its pause-and-auto-resume machinery; this spec adds the reopen-time hint so the pause can end at the projected reopen rather than only on probe success.
- Pool spend attribution composes with, and never replaces, the existing budget enforcement: a session's cost counts against its deployment budget identically whichever pool carried it.

## Event Flows

**Dispatch with headroom awareness:**
1. Session Runtime resolves a provider for a spawn; the Provider Registry produces its candidate order.
2. The registry calls filter and rank; exhausted pools' providers drop out, tight pools sink, ample pools rise within rank.
3. The spawn proceeds on the first surviving candidate; the dispatch records which pool served it.

**Window exhaustion and failover:**
1. A session attempt returns a long-horizon quota signal.
2. Session Runtime reports the exhaustion signal; the scheduler marks the pool exhausted, projects the reopen, emits a PoolExhaustionEvent.
3. The in-flight need is re-resolved through the registry; the exhausted pool's providers are excluded, so the work continues on the next configured pool — same gates, same budgets.
4. The Operator sees the failover in the pool state and the event feed; nothing stalls.

**All eligible pools exhausted:**
1. Re-resolution finds no candidate whose pool has headroom.
2. The provider-unavailable pathway fires; the Daemon Control Plane pauses the affected work with the earliest projected reopen attached and visible.
3. At the projected reopen (or on an earlier success signal), the ledger transitions the pool out of exhausted, and the existing auto-resume machinery picks the paused work back up. Nothing is dropped.

**Provenance for drift detection:**
1. Every session completion writes its PoolOutcomeProvenance with the result.
2. Review verdicts link to their provenance record.
3. A consumer (telemetry, tech-lead analysis, the dashboard) can group review outcomes by pool over time and surface divergence — entirely from records, with no re-execution.

**Window reset observation:**
1. After a projected reopen passes, the first successful attempt on a pool's provider is treated as the observed reset.
2. The ledger starts a new window from the evidence, replacing projection with observation; persistent failure past the projection degrades the pool to unknown and re-raises the exhaustion event rather than flapping.

## Error Handling

**Ambiguous signal (throttle vs window exhaustion):** Classified as a short-horizon throttle — the less disruptive interpretation — handled by per-provider cooldown; only signals positively matching the long-horizon rule mark a pool exhausted. Misclassification self-corrects: repeated immediate throttles on an ample pool escalate to exhausted after the configured repetition threshold.

**No quota signal available at all (silent pool):** The ledger runs on consumption estimates alone and caps the headroom state at tight once the estimate crosses the configured fraction of the window's historical capacity; estimates never report ample without evidence.

**Ledger persistence unavailable:** Filter and rank degrades to pass-through (no pool filtering) while provenance writing fails closed for review sessions — a review whose provenance cannot be recorded is reported to the Control Plane as an incomplete verification record, because unprovenanced review verdicts would silently defeat drift detection.

**Stale ledger after restart:** Headroom state loads as unknown when evidence is older than the pool's window length; unknown is dispatchable but never preferred, and the first outcomes rebuild the estimate.

**Clock skew between projection and provider reality:** Reopen projections are hints, not gates: an attempt is permitted once the projection passes, and a provider still refusing rolls the projection forward from the new evidence instead of tight-looping retries.

**Pool configuration error (provider assigned to no pool or two pools):** Startup validation fails the configuration with the offending assignments named; at runtime (defense in depth) an unassigned provider is treated as its own implicit single-provider pool with unknown headroom and a logged warning.
