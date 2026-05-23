# Daemon DB-Outage Resilience — Design

Date: 2026-05-21
Status: draft (pending spec deep-review)
Spec refs: FUNC-AC-SAFETY, FUNC-AC-DATA-PLATFORM, ARCH-AC-OPERATIONAL-SAFETY, ARCH-AC-DATA-PLATFORM, STACK-AC-OPERATIONAL-SAFETY, STACK-AC-DATA-PLATFORM

## Goal

The auto-claude daemon should survive a transient operational-data outage (Postgres unreachable) without exiting the process, surface the underlying cause of dependency failures in operator-readable form, and still fail loudly on permanent misconfiguration (schema/auth/permission errors).

## Current State

- `packages/daemon/src/control-plane/daemon.ts:201` calls `await configReader.start()`, which calls `await this.fetch()` once in `packages/daemon/src/data/config-reader.ts:38`. Any throw bubbles to `main.ts:18`, which `process.exit(1)`s.
- launchd (`scripts/com.autoclaude.daemon.plist`) keeps the process alive via `KeepAlive` + `ThrottleInterval=30`. Result: a Postgres outage produces an opaque crash-loop with no `/health` reachable.
- Today's incident: Docker was stopped; the heartbeat went stale; the log filled with `Failed to start: [config-reader] global settings fetch failed: Failed query: select "id", ... from "global_settings"` — no indication that the actual cause was `ECONNREFUSED`.
- `unavailableOnThrow()` in `packages/db/src/postgres-stores.ts:861` catches every Drizzle error and reduces it to `error.message`. `postgres-js` wraps connection errors so the `message` is the SQL only; the underlying `cause` (`ECONNREFUSED`, `28P01`, `42P01`) is dropped on the floor.
- The control HTTP server (`createControlServer` in `packages/daemon/src/control-plane/server.ts:180`) does not bind until step 6 of `startDaemon` — *after* the failing step-2 config fetch. The observability surface is unavailable exactly when it would be most useful.

## Design — bounded retry + degraded background-retry (option E)

Sparring with codex picked option E over: A (bounded retry then exit), B (last-known-good disk cache bootstrap), C (server-first, no inline retry), D (diagnostic-only). Rationale carried in the codex transcript; in short: A still hands recovery to launchd (silent crash-loop), C hides the boot-race vs real-outage distinction, B adds correctness risk around stale repo sets / schema drift, D fixes the visibility gap but leaves the process exiting needlessly.

### Behavioral contract

1. **Categorical store outcomes.** Every `StoreResult` failure of error `unavailable` now carries a `category` of `unreachable` (transient, retry-eligible) or `rejected` (permanent — schema, auth, syntax, permission). Consumers branch on category, not on message text.
2. **Cause preservation.** `unavailableOnThrow()` walks `error.cause` and picks the **deepest** layer that has a non-empty `code` or non-default `name`/`class`; if every layer is opaque, the outermost `message` is used. The chosen layer is recorded as `{ class, code, message }` on the unavailable result, and the human-readable message becomes `${SQL summary} — ${code}: ${chosen-layer message}` rather than only the SQL. The rule is shared verbatim with STACK-AC-DATA-PLATFORM.
3. **Throwaway degraded server, then linear startup.** Rather than reordering the (large, tightly-coupled) real startup, `startDaemon` binds a *minimal throwaway* control server — `createDegradedServer` answering only `/health` and `/status` with `{ ok: true, degraded: true, lastConfigError }` — on the control port immediately after the DB client + configReader are constructed (no DB I/O yet). It then runs the bounded retry. The real startup sequence (lines ~201–1390) is left **completely unchanged** and runs linearly *after* config has loaded, re-binding the real control server on the same port. The degraded server is closed (port released) immediately before the normal flow proceeds. The two servers never listen simultaneously. This avoids extracting or reordering the 700-line startup body — the single biggest source of regression risk.
4. **Bounded inline retry.** Initial config fetch (`configReader.tryFetch()`) retries up to 5 attempts with backoff after attempts 1–4 of `1s, 2s, 4s, 8s` (~15s total; no delay after the final attempt). Each attempt logs `[daemon] startup config fetch failed (attempt N/5, ${category}, ${code}): ${message}`. Tunable via `DAEMON_STARTUP_RETRY_MAX_ATTEMPTS`, `DAEMON_STARTUP_RETRY_BASE_MS`, `DAEMON_STARTUP_RETRY_MAX_DELAY_MS`. **Inline attempts do not advance the escalation counter** — they are the daemon's fast-recovery path for boot races against Docker startup.
5. **Background-retry phase (blocking await, no hook).** If all inline attempts fail with `unreachable`, `startDaemon` `await`s `runDegradedUntilRecovered(configReader, ...)` — an async function that polls `configReader.tryFetch()` at the config poll cadence and resolves only when a fetch finally succeeds. While it blocks, the throwaway degraded server keeps answering `/health`. Each unrecovered `unreachable` poll advances the escalation counter; at threshold the Operator is notified once (re-armed only after a clean recovery). A `rejected` outcome during this phase closes the degraded server, runs cleanup, and `process.exit(1)`s. Because `startDaemon` simply blocks here and then continues linearly, there is no recovery callback, no `completeStartup` extraction, and no reentrancy: the normal startup runs exactly once, after config is loaded, with its `Result` propagated normally. The daemon claims no work while blocked because the work loop is wired only in the post-block normal startup.
6. **Categorical `rejected` → fail loud (any phase).** If any attempt returns `category: 'rejected'`, the daemon fails loudly. In the inline phase: `startDaemon` closes the degraded server, ends the DB client, and returns `err(...)` (then `main.ts` exits non-zero). In the background phase (inside `runDegradedUntilRecovered`): close the degraded server, end the DB client, and `process.exit(1)` directly (startDaemon is blocked awaiting and will not return). Permanent misconfiguration is never silently retried regardless of phase. The escalation counter is irrelevant for `rejected` — they always exit on first detection.
7. **Escalation.** A counter tracks consecutive unrecovered background-retry attempts while `startupDegraded === true`. The threshold is the **existing** `config.maxConsecutiveStuck` value reused verbatim — no new threshold field is introduced. Once the counter reaches that threshold the daemon fires a single Operator notification on the configured channel and does not re-fire until the degraded flag has cleared at least once (tracked via a `notifiedThisDegradation` boolean reset on clear).

### Rejected alternatives

- **Persisted last-known-good config (option B).** Adds correctness risk: repo list might be stale, plugin set might be stale, daemon might claim work against a config that no longer reflects the operator's truth. Defer until we have a forcing function.
- **Skip the inline-retry, go straight to degraded (option C).** A fresh boot-race against Docker startup almost always recovers within 5–10s; making every Mac mini boot read `degraded` for the first poll interval is noisy and degrades the signal value of `/health.degraded`.
- **Walk back to launchd as the sole recovery loop (option A).** Hours of opaque crash-loop on a dependency outage is exactly the failure mode this incident exposed; we should not leave it intact.

### Integration details

- **No race, no hook — linear blocking await.** Inline-retry and background-retry are sequential within `startDaemon`. On inline exhaustion, `startDaemon` `await`s `runDegradedUntilRecovered`, which resolves only on a successful fetch. The normal startup then proceeds linearly. There is no recovery callback, no extracted `completeStartup`, and no reentrancy: the heavy startup body runs exactly once, in its original order, after config is loaded.
- **Port handoff.** The throwaway degraded server holds the control port during the outage. Before the normal flow proceeds (on inline success or background recovery), `await degradedServer.close()` releases the port; the real server then binds it at its normal place (`server.ts:180`). Sequential `await` on a single-threaded event loop makes the close→bind handoff safe; the instance-lock semantics are unchanged.
- **`tryFetch` vs `start()`.** The bounded inline retry calls `configReader.tryFetch()` directly, which loads config on success. `start()` is changed to *only* arm the poll timer (it no longer does an initial `fetch()`), so the normal flow's `configReader.start()` call does not issue a redundant/again-failing fetch right after recovery. The poll timer's steady-state behavior (keep last-known-good, `console.warn`) is unchanged.
- **Degraded poll escalation.** `runDegradedUntilRecovered` counts consecutive `unreachable` polls; at `config.maxConsecutiveStuck` it fires the operator notifier once (`notifiedThisDegradation` guards re-fire). Recovery resolves the await; a `rejected` poll closes the degraded server, ends the DB client, and `process.exit(1)`s.
- **Mutation refusal is structural.** No work loop, crash-resume, or parked-run-resume is wired until the post-block normal startup, so the daemon *cannot* claim work while degraded. An explicit `isStartupDegraded()` guard is unnecessary in option E′ but a one-line belt-and-suspenders guard on the work-detection callback is cheap insurance.
- **`docker-compose.yml depends_on: daemon`.** Only `briefing-summarizer`'s `depends_on` lists `migrate`; nothing depends on `daemon`. The change does not alter dashboard-side reachability.

### File topology

**Modified**

- `packages/db/src/postgres-stores.ts` — `unavailableOnThrow` walks `error.cause`; `errorMessage` formats `code:class:message`. Add `category: 'unreachable' | 'rejected'` field on the unavailable result type. Classification helper distinguishes network/timeout (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNRESET`) from postgres SQLSTATE classes (`08*` connection — unreachable; `28*` auth, `42*` syntax/schema — rejected).
- `packages/db/src/stores.ts` — extend `StoreResult` `unavailable` variant with `category` and structured `cause`.
- `packages/daemon/src/data/config-reader.ts` — extend the `ConfigReader` interface with `tryFetch(): Promise<Result<void, ConfigFetchError>>`, `isStartupDegraded()`, `getLastConfigError()`. `start()` changes to *only* arm the poll timer (no initial fetch). Add `runDegradedUntilRecovered` either here or in daemon.ts (it needs `tryFetch` + the notifier + the fatal handler).
- `packages/daemon/src/control-plane/daemon.ts` — insert Phase C (bind throwaway degraded server) + Phase D (bounded inline retry → rejected/success/exhausted) before the existing line-201 startup; close the degraded server before the normal flow. The 700-line startup body is otherwise UNCHANGED. (Governed by STACK-AC-OPERATIONAL-SAFETY + STACK-AC-CONTROL-PLANE.)
- `packages/daemon/src/control-plane/server.ts` — OPTIONAL: real server's `/health` adds `degraded: false, lastConfigError: null` for shape-uniformity with the degraded server. The real server is never degraded in option E′ (it binds only after recovery), so this is cosmetic. (Governed by STACK-AC-CONTROL-PLANE.)
- `packages/daemon/src/main.ts` — surface non-Error throws + `error.cause` chain. (Governed by STACK-AC-CONVENTIONS and STACK-AC-RUNTIME-SOURCE-ISOLATION; not STACK-AC-CONTROL-PLANE, which does not cover `main.ts`.)

**New**

- `packages/db/src/error-classification.ts` (or co-located in `postgres-stores.ts`) — `classifyDriverError(err): { category, code, class, message }`. (Governed by STACK-AC-DATA-PLATFORM's glob `packages/db/**`.)
- `packages/daemon/src/control-plane/startup-retry.ts` — bounded-retry helper with injectable `delay`. (Added to STACK-AC-OPERATIONAL-SAFETY traceability + frontmatter in the implementation PR.)
- `packages/daemon/src/control-plane/degraded-server.ts` — `createDegradedServer(port, host, getState)`: minimal HTTP server answering `/health` + `/status` with `{ ok: true, degraded: true, lastConfigError }`; returns `{ close(): Promise<void> }`. (Governed by STACK-AC-OPERATIONAL-SAFETY + STACK-AC-CONTROL-PLANE; added to traceability in the implementation PR.)

**Explicitly unchanged**

- `scripts/com.autoclaude.daemon.plist` — `KeepAlive` + `ThrottleInterval=30` stay as backstop for true crashes (process death, OOM). Not the primary recovery mechanism anymore.
- The entire `startDaemon` body from current line ~201 onward (services, repoManager, crash resumption, heartbeat, parked-run resume, signal handlers, real control server) — runs unchanged after config loads.

### Test strategy

- **Unit, `unavailableOnThrow` classification.** Synthetic errors for each SQLSTATE (`08006`, `28P01`, `42P01`, `42703`) and each network errno (`ECONNREFUSED`, `ETIMEDOUT`); assert `category` and `cause.code` round-trip.
- **Unit, `startup-retry`.** Inject fake `tryFetch` that fails `unreachable` N times then succeeds; assert max attempts, backoff sequence, flag transitions. Inject `rejected` failure on attempt 1; assert short-circuit.
- **Unit, `config-reader` degraded poll.** Fake clock; assert flag clearing on first success, escalation counter increment + notification one-shot while degraded, and `console.warn`-only behavior once recovered.
- **Integration, daemon.test.ts.** Mock data layer to return `unreachable` for first N polls; assert `/health` reports degraded, `tryClaimWork` returns refused, then asserts recovery once the mock starts returning ok.
- **End-to-end (Phase 9, manual).** `docker stop auto-claude-postgres-1`; observe `[daemon] startup config fetch failed (attempt 1/5, unreachable, ECONNREFUSED): connect ECONNREFUSED 127.0.0.1:5432` in the log; observe `/health` returns `{ ok: true, degraded: true, lastConfigError: { ... } }`; `docker start auto-claude-postgres-1`; observe degraded clears within one poll interval, no process restart.

### Risks

- **Test runtime.** Bounded retry with real delays would inflate test runtime. Inject `delay` via parameter; default to `setTimeout`, override to immediate in tests.
- **Notification spam.** If degraded oscillates (postgres flapping), the escalation one-shot must only re-arm after a clean cycle (degraded cleared at least once). Track via a separate `notifiedThisDegradation` boolean reset when the flag clears.
- **Refused-work observability.** Operators may see "0 work claimed" without knowing why. The `/status` response already exposes `paused` / `draining`; adding `degraded` to the same payload keeps the diagnostic surface in one place.
- **Throw safety around the degraded window.** Wrap Phase C + Phase D in a `try/catch`: any unexpected throw closes the degraded server and ends the DB client before returning `err`, so no dangling bound-but-useless process. The `rejected` paths are explicit (not exceptions) and do their own cleanup before exit.
- **Port handoff timing.** The only delicate moment is `degradedServer.close()` → real `server.listen()`. `close()` is awaited (waits for in-flight requests to drain and the listener to release), so the real bind cannot collide. If `close()` ever hangs, the real bind would fail with EADDRINUSE and `startDaemon` returns err → main.ts exits → launchd respawns. Acceptable failure mode.

### Follow-ups (intentionally out of scope)

- Persisted last-known-good cache (option B). Revisit only if degraded-only startup is too limited in practice (e.g., dashboard wants to read repo list from daemon while it's degraded).
- Generalising the same retry-and-degrade pattern to runtime DB outages, not just startup. The existing `fetchSafe` already caches; this is mostly a notification concern (currently `console.warn` only).
- Removing `KeepAlive` from launchd entirely once we trust the self-healing. Premature.

### Migration plan

Single PR against `dev`. No data migration; only behavior change inside the daemon process. Rollback is `git revert` on the merge commit — the old crash-loop behavior returns and Docker-up is again the manual recovery.
