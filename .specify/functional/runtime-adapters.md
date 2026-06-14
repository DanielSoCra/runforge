---
id: FUNC-AC-RUNTIME-ADAPTERS
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-RUNTIME-ADAPTERS — Pluggable Reasoning Runtimes and Work Resumption

> **Spec history (v1, 2026-06-11):** Written for the v-next masterplan (decisions D1/D2). The first runtime wired through this contract beyond the platform's native one is the pi coding agent, joining as a process-managed runtime for lower-cost implementation work; *which* runtimes are wired and which roles route to them are configuration values recorded in the non-normative default configuration pack example, never requirements of this spec. The safety baseline for runtimes without native guard integration deliberately does not assume the native runtime's hook mechanism.

## Problem Statement

Every piece of reasoning work the platform runs — planning, implementing, reviewing, diagnosing — executes on a reasoning runtime. Today the platform is effectively married to one family of runtimes: its assumptions about how work is started, how its cost is learned, and how its outcome is read are entangled with that family's behavior. This has two costs. First, economics: the cheapest runtime capable of a given piece of work is often not the native one, and the platform cannot exploit that without a uniform way to plug other runtimes in. Second, resilience: when the native runtime's capacity is exhausted, work stalls instead of continuing elsewhere.

A second waste compounds this. The platform treats every phase of a run as a fresh start: a fix cycle or a follow-on phase begins with no memory of the work that came before, and the context painstakingly built in the previous phase is re-bought at full price. The runtimes themselves can continue an earlier piece of work where it left off — the platform simply never asks them to. But resumption is only safe when the ground has not shifted: continuing a conversation whose working area has changed underneath it, or whose earlier exchange went bad, produces confidently wrong work, so the platform must know when to resume and when to deliberately start clean.

Finally, a runtime the platform has never exercised is an unverified claim. Wiring a new runtime in — or pointing an existing one at a different capability — must not silently route real work onto something that does not respond, responds as the wrong thing, or produces no output. And runtimes that lack the native runtime's built-in guard integration must not thereby get weaker safety: the platform needs a stated baseline of protections that applies to any runtime regardless of what it natively supports.

## Actors

- **Operator** — wires runtimes into the platform through configuration, decides which roles may run on which runtime, and is told when a runtime fails its proving run or loses its resumption ability
- **Control Plane** — routes each piece of reasoning work to a runtime through one uniform contract, decides per piece of work whether to continue earlier work or start clean, enforces the safety baseline, and records cost and outcome for every piece of work regardless of runtime
- **Worker** — the autonomous run whose phases and fix cycles are carried out on whichever runtime the platform routes them to; it neither knows nor depends on which runtime executed it

## Behavior

### One contract for every runtime

**Scenario: A runtime joins through the uniform contract**
- Given a reasoning runtime the Operator wants the platform to use
- When it is wired in through the deployment-independent runtime contract — start a piece of work, continue an earlier piece of work where it left off, stop a piece of work, report what the work cost, and report how the work ended
- Then the platform can route reasoning work to it the same way it routes to every other runtime, and no other part of the platform changes

**Scenario: Work is routed without the rest of the platform knowing the runtime**
- Given several runtimes are wired in
- When a piece of reasoning work is dispatched
- Then the work is described by its role and need — never by runtime — and the platform resolves which runtime carries it; the producing run behaves identically whichever runtime served it

**Scenario: Cost is learned for every piece of work**
- Given a piece of reasoning work has finished on any runtime
- When its outcome is recorded
- Then its cost is recorded with it; when a runtime cannot report exact cost, the platform records a clearly-marked conservative estimate rather than no cost at all

**Scenario: The outcome of every piece of work is legible**
- Given a piece of reasoning work has ended on any runtime
- When the platform reads its result
- Then it can always establish how the work ended — finished, failed, stopped, or out of time — and never has to guess an outcome from silence

### Continuing earlier work

**Scenario: A later phase continues the same conversation**
- Given a run whose earlier phase built up working context on a runtime that can continue earlier work
- When a follow-on phase or a fix cycle of the same run begins
- Then the platform continues the earlier piece of work where it left off instead of starting from nothing, and the continuation is recorded as such

**Scenario: A shifted working area forces a clean start**
- Given a run's working area has changed since the earlier piece of work was carried out
- When a later phase would otherwise continue that work
- Then the platform starts clean instead, records that it did and why, and the prior conversation is not continued against ground that moved underneath it

**Scenario: A poisoned conversation is abandoned, not continued**
- Given an earlier piece of work is known to have gone bad — its exchange was corrupted, misled, or marked unusable
- When a later phase begins
- Then the platform deliberately starts clean, the bad conversation is never resumed, and the clean start is recorded with its reason

**Scenario: A runtime that cannot continue work still works**
- Given a runtime that has no way to continue earlier work
- When a later phase of a run is routed to it
- Then the platform starts clean as a matter of course — the inability degrades cost, never correctness

### Proving a runtime before trusting it

**Scenario: A newly wired runtime must pass a proving run**
- Given a runtime has been newly wired in, or an existing runtime has been pointed at a different capability
- When it would first receive real work
- Then a short proving run is executed first — one that requires the routed capability to actually respond and to produce an observable change — and only a passing proof admits the runtime into rotation

**Scenario: A failed proving run keeps the runtime out**
- Given a proving run does not pass — nothing responds, the wrong capability responds, or no observable change is produced
- When work would be routed to that runtime
- Then it is not; the runtime stays out of rotation, the failure is surfaced to the Operator, and work routes to the remaining runtimes instead

### The safety baseline

**Scenario: A runtime without native guard integration gets the compensating baseline**
- Given a runtime that lacks the platform's native, built-in guard integration
- When work runs on it
- Then the platform's compensating baseline applies in full: the work runs in an isolated working area, the platform's deterministic checks gate its output, and its changes receive independent review at the platform's strongest review level before any merge eligibility

**Scenario: No runtime buys its way past the gates**
- Given any runtime, native or not
- When its work is considered for the shared mainline
- Then the same merge decision, scope verification, and compliance gates apply as for any other work — which runtime produced a change never weakens what the change must pass

## Success Criteria

- A new reasoning runtime is added by configuration against the uniform contract; no other part of the platform changes, and work routed to it behaves — to the rest of the platform — exactly like work on any other runtime
- A follow-on phase or fix cycle on a resumption-capable runtime continues the earlier conversation rather than rebuilding it, and the saving is visible in recorded cost
- No conversation is ever continued after its working area changed or after it was marked bad; every clean start in those situations is recorded with its reason
- Every piece of reasoning work, on every runtime, carries a recorded cost (exact or clearly-marked estimate) and a definite outcome
- No runtime receives real work before passing a proving run that shows the routed capability responds and produces an observable change; every failed proof is surfaced and keeps the runtime out of rotation
- Work on a runtime without native guard integration is never less protected than work on the native runtime: isolation, deterministic checks, and strongest-level independent review always apply to it
- Which runtimes are wired and which roles run where are configuration values an Operator can change without a platform change

## Constraints

- The runtime contract is **deployment- and vendor-independent**: it is expressed in the platform's own terms (start, continue, stop, cost, outcome) and never in any one runtime's terms; a runtime's quirks are absorbed at its boundary and never leak into the rest of the platform
- **Routing is configuration, never platform behavior**: which runtimes exist, which roles prefer which runtime, and every fallback order are values in configuration; this spec defines only the mechanism that reads them
- **Resumption is opt-in by evidence, fail-safe by default**: the platform continues earlier work only when it can establish that the same working area is intact and the conversation is not marked bad; any doubt resolves to a clean start, never to a risky continuation
- The identity needed to continue earlier work is **durably recorded per run** as part of the run's state, so a continuation survives the platform's own restarts; losing it degrades to a clean start, never to an error that blocks the run
- A **proving run is mandatory** before a newly wired runtime or newly routed capability receives real work; the proof must demonstrate an actual response from the routed capability and an observable produced change — reachability alone proves nothing
- The **safety baseline for runtimes without native guard integration** — isolated working area, deterministic checks, independent strongest-level review before merge eligibility — is the platform's floor and is not configurable downward; the platform must never assume the native runtime's guard mechanism exists on other runtimes
- Credentials follow the platform's existing rule: no runtime, native or otherwise, ever receives credentials beyond what its sanctioned execution requires, and reasoning sessions never receive the platform's own secrets
- Stopping a piece of work must be possible at any time for every runtime; a runtime that cannot be stopped cannot be wired in
