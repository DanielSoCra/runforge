# Phase 0 — Safety-Floor Honesty: Task-Level Plan

> Expansion of **Phase 0** of `docs/superpowers/plans/2026-07-02-first-production-deployment-regulated-full-l0.md` (Revision v2, Operator-approved) into implementable tasks. Branch: `plan/first-production-deployment-regulated-full-l0`; build branch: `codex/phase0-safety-floors-build`. Delivered via the delegated sparring pipeline (gate → work-order → external implementer → deep-review).
>
> **Line numbers in this plan are anchors verified 2026-07-02 — they WILL drift. Always `grep -n` for the named symbol before editing; never trust a line number.**

## Scope and governance

Five floors from program-plan Phase 0 (0.1–0.5). All files are governed by **existing draft L2/L3 chains** (verified in `.specify/traceability.yml` 2026-07-02): `scope-enforcement.ts`/`generate-containment-script.ts`/`audit.ts` → STACK-AC-CONTAINMENT; `fsm.ts` → STACK-AC-DAG-EXECUTOR + STACK-AC-RECOVERABLE-FAILURE-ROUTING; `daemon.ts`/`server.ts`/`integration.ts` → STACK-AC-CONTROL-PLANE; `config.ts` also → STACK-AC-RUNTIME-SOURCE-ISOLATION. `draft` status is the repo norm (124/152 nodes); **no new L1 content ⇒ no Operator gate**. Every new file must be added to `traceability.yml` `code_paths`, new test files to `test_paths`; `pnpm --filter @runforge/daemon test src/infra/traceability-paths.test.ts` must pass.

**Ground-truth corrections applied vs. the program plan text** (independent re-verification 2026-07-02):

1. Program-plan 0.4 says "secret scan … alongside the existing blocked-command audit in `session-runtime/audit.ts`". Reality: `audit.ts` contains **no** secret detection of any kind, and its blocked-command audit result is **deliberately advisory-only** (`runtime.ts` ~633, per issue #489 acceptance criteria 5–6: `console.warn` + `auditWarnings`, never terminal). Task 4 below therefore *adds* a credential-leak floor with **fatal** semantics while **preserving** the advisory semantics of the blocked-command audit. Do not flip #489's decision.
2. Program-plan 0.3 undersells: `branches.staging: "dev"` is a **live blocker** — no `dev` branch exists on origin at all; any integrate/checkout/runtime-source validation against it fails today (`git log origin/dev` → unknown revision).
3. The program plan's `daemon.ts:1450/:1548` pause-gate cites did not resolve exactly at HEAD; the pause mechanism itself is confirmed (`pause: () => { paused = true; ... }`, closure-scoped in `daemon.ts` ~1919). Grep for `paused` reads; don't hardcode those cites.
4. `killAllManagedProcessGroups` (`session-runtime/managed-processes.ts:76-95`) is a **single SIGKILL sweep that clears the registry** — it has no SIGTERM-first escalation. Task 5 adds one; do not repurpose the SIGKILL sweep as-is for `/halt`.

---

## Task 1 (0.1) — Fix the dead preventive scope hook

**File:** `packages/daemon/src/session-runtime/scope-enforcement.ts` (`generateScopeHookScript`, ~89–223).

**Defect:** the generated hook script only ever `console.log(JSON.stringify({ block: true, ... }))` and falls off the end of its `stdin.on('end')` handler — **no `process.exit()` anywhere** → always exits 0 → Claude CLI never blocks. `{block: true}` is not a field in the CLI hook contract.

**Correct contract to mirror** — `generate-containment-script.ts:262-271` (grep `checkContainment(input.tool_name`):

```js
if (!result.allowed) {
  process.stderr.write(result.reason + '\n');
  process.exit(2);   // exit 2 + stderr reason = deny
}
process.exit(0);     // exit 0 = allow
```

**Steps:**
1. TDD-first (the acceptance gate already encodes this; see Gate contract G1): a subprocess contract test in the style of `generate-containment-script.test.ts:9-31` (`runHookScript` helper: write generated script to tmp `.mjs`, `execSync('printf <json> | node <script>')`, assert `{code, stderr}`) MUST FAIL against current code.
2. Rewrite the generated script's decision tail: on out-of-scope → `process.stderr.write(reason + '\n'); process.exit(2)`. On allow → `process.exit(0)`. Keep the JSON-parse-failure path **fail-closed for write-capable tools** (a malformed hook input must not silently allow; mirror how the containment script handles parse errors — grep its `catch` — and match that posture; if the containment script's parse-error path is fail-open, still make THIS script's parse-error path exit 2 for write/edit tools and document the difference in a comment).
3. Do not change `checkWriteScope` / `checkToolCallScope` semantics (existing pure-function tests at `scope-enforcement.test.ts:15-124` keep passing).
4. Keep the detective post-session `git diff` audit (`runtime.ts` ~603–619) untouched — the two layers are complementary.
5. Wiring stays as-is: `setupHooks()` at `adapters/cli.ts` ~210 already registers the script as a PreToolUse hook; no adapter change expected. If the hook-input JSON shape the script reads differs from what the CLI actually sends (`tool_name`, `tool_input`), fix the script to the shape the containment script consumes — that one is contract-tested and live.

**Commit:** `fix(session-runtime): scope hook emits real CLI deny contract (exit 2 + stderr) instead of dead {block:true} JSON`

## Task 2 (0.2) — Website variant: remove misleading success (fail closed)

**Files:** `packages/daemon/src/control-plane/phases-website.ts` (primary), `packages/daemon/src/control-plane/fsm.ts:61-72` (`websiteTransitions`, reference only), `phases-website.test.ts`.

**Defect:** every website phase handler is a stub: `withCheckpointGate`'s non-checkpoint path does nothing and `return 'success'` (~line 88; header comment admits "Stubs return 'success' immediately"). `PHASE_DELIVERABLES` names files nothing writes. The FSM advances a 10-phase pipeline to `launch` with zero work done — a fake-success live path. Issue #774 named it.

**Decision (from the program plan): fail closed, do not delete.** Deleting the variant ripples through traceability `code_paths` (CI-enforced existence) and intake classification; fail-closing is the smaller honest change and keeps the Plan-2 slot.

**Steps:**
1. In `createWebsitePhaseHandlers`/`withCheckpointGate`: the stub path (no real implementation for the phase) must return `'failure'` — never `'success'` — after emitting one loud structured line: `console.error('[website] phase <p> has no real implementation — failing closed (stub); see Plan 2', { issue, phase })`. Follow `websiteTransitions`' existing `failure` routing (grep where `failure` events land for website — expected: run ends failed/stuck, which is the honest outcome).
2. Checkpoint-gated paths that DO perform real work (label add/remove, checkpoint pause) keep working — only the "pretend the phase's work happened" tail is replaced.
3. Rewrite `phases-website.test.ts`'s `non-checkpoint phase (auto mode)` block (~line 105): it currently **asserts the fake success as correct** (`'returns success and removes checkpoint-paused label'`). Assert fail-closed instead. This is an existing test the implementer must update — it is NOT part of the immovable acceptance gate.
4. `fsm.ts` itself likely needs no change (transitions already carry `failure` events); if the failure event has no route for some website phase, add the route to the existing terminal failure state rather than inventing a new state.

**Commit:** `fix(control-plane): website variant fails closed instead of reporting stub success (#774)`

## Task 3 (0.3) — Purge retired-branch config (live blocker)

**Files:** `runforge.config.json:13-16`; read-side sanity in `packages/daemon/src/config.ts:250-255` (schema, defaults `staging:'staging'`) — schema change NOT needed (values are free-form strings).

**Defect:** checked-in config says `"staging": "dev"` but `dev` was retired 2026-05-29 and **does not exist on origin**. Every read of `config.branches.staging` (pervasive: `phases.ts` checkout/diff/merge-base sites, `daemon.ts` → `integrateToStaging(...)` → `integration.ts:29`, and `runtime-source.ts:18` `origin/${staging}` expectedRef) targets a nonexistent branch. Under the current config the daemon would boot **paused** (runtime-source validation can't resolve `origin/dev`).

**Steps:**
1. Set the single-trunk shape ratified by L0 v7: `"branches": { "staging": "main", "production": "main" }`. Do **not** add a `deployment` block — that is P2 work, deliberately after P1 lands a PR-gated merge mechanism.
2. **Single-trunk guard in `release.ts` (required code change — codex-verified):** `createReleaseProposal` unconditionally calls `pulls.create({ head: stagingBranch, base: productionBranch })` when completed work exists (`release.ts:89-96`, grep `pulls.create`); with `staging === production === "main"` that attempts a `main`→`main` PR (GitHub API error), NOT an inert no-op. Add a guard: `if (stagingBranch === productionBranch)` → skip PR creation and return a **truthful new result status** — extend the `ReleaseProposalResult` union (`release.ts:13-29`, currently only `success | no-completed-work`) with `'single-trunk-not-applicable'`; returning `no-completed-work` when completed work exists would lie. Update `release.test.ts:64-85` (existing test asserts `dev`→`main`; the implementer updates it — it is not part of the immovable gate) and add a case for the guard. Check callers of `createReleaseProposal` handle the new status (exhaustiveness).
3. `runtime-source.ts` consequence (no code change): expectedRef now resolves to `origin/main` — what P2.6 will later pin explicitly.
4. Guard test (gate encodes this, G3): a test reading `runforge.config.json` asserting `branches.staging`/`branches.production` are not retired branches (`dev`) — cheap, honest, prevents regression. Place near existing config tests (grep `runforge.config.json` under `packages/daemon/src` for the loader/validation test home).

**Commit:** `fix(config): retire dead 'dev' staging branch — single-trunk main per L0 v7 (live blocker: origin/dev does not exist)`

## Task 4 (0.4, retitled) — Worker-output credential-leak floor (fatal), preserving #489 advisory audit

**Files:** `packages/daemon/src/session-runtime/audit.ts` (extend), `runtime.ts` (~633, the `auditSessionOutput` call site), `audit.test.ts` (extend).

**Reality check:** this is a small **new floor**, not a defect fix — `audit.ts` today only detects blocked-command evidence, and that result is advisory by design (#489 AC 5–6). Both facts shape the design:

**Design:**
1. Add `severity: 'advisory' | 'fatal'` to the audit violation shape. Existing blocked-command violations = `'advisory'` (unchanged semantics).
2. Add credential-pattern detection over the session output text, `'fatal'` severity, **high-precision prefix/structure patterns only** (this is a floor, not a DLP product — program plan's words):
   - `sk-ant-[A-Za-z0-9_-]{10,}` (Anthropic)
   - `gh[pousr]_[A-Za-z0-9]{20,}` and `github_pat_[A-Za-z0-9_]{20,}` (GitHub)
   - `AKIA[0-9A-Z]{16}` (AWS access key id)
   - `-----BEGIN( [A-Z]+)? PRIVATE KEY-----` (key material)
   Generic high-entropy assignment detection is **explicitly out** of the fatal set (false-positive floor would brick legitimate sessions); if included at all, it is `'advisory'`. Redaction: violation records must carry a **redacted** match (first 8 chars + length), never the full token — the audit record must not itself become the leak.
3. `runtime.ts` call site: violations with `severity: 'fatal'` **fail the session** (same terminal path as the detective scope-audit hard-fail at ~603–619 — grep how a scope violation fails the run and mirror the mechanism); `'advisory'` keeps today's `console.warn` + `auditWarnings` behavior byte-for-byte. Add a comment marking the #489 advisory decision as intentionally preserved.
4. Traceability: `audit.ts` already sits under STACK-AC-CONTAINMENT; if any new file is created (prefer extending `audit.ts`; a separate `secret-scan.ts` is acceptable if cleaner), add it to that node's `code_paths` and its tests to `test_paths`.

**Commit:** `feat(session-runtime): fatal credential-leak floor on worker output (Anthropic/GitHub/AWS/key-material patterns); blocked-command audit stays advisory per #489`

## Task 5 (0.5a) — Escalating terminate for managed process groups

**File:** `packages/daemon/src/session-runtime/managed-processes.ts` (grep `killAllManagedProcessGroups`, currently 76–95).

**Current shape:** single sweep `process.kill(-pid, signal)` with default `'SIGKILL'`, swallows ESRCH/EPERM, **clears the registry immediately**, returns count. No escalation.

**Steps:**
1. Add `terminateAllManagedProcessGroups(opts: { graceMs?: number }): Promise<{ terminated: number; escalated: number }>` — SIGTERM sweep to every registered group, wait `graceMs` (default 5000) for exits, SIGKILL survivors, then clear registry. Must be idempotent and safe when the registry is empty. Registry entries must NOT be cleared before the escalation pass (the current clear-on-sweep behavior would orphan survivors).
2. Keep `killAllManagedProcessGroups` as-is — the SIGUSR2 force-kill path (`daemon.ts` ~3190–3204) stays untouched (it is deliberately immediate).
3. Unit-test with real short-lived child processes (the repo already spawns real subprocesses in tests; respect the 30s vitest timeout floor — RC-flake mitigation, self-enforced by a hygiene guard).

**Commit:** `feat(session-runtime): SIGTERM→SIGKILL escalating terminate for managed process groups`

## Task 6 (0.5b) — `POST /halt`: park in-flight runs, kill workers, stay resumable

**Files:** `packages/daemon/src/control-plane/server.ts` (route table; POST routes at 115–493 — grep `'/pause'`), `daemon.ts` (handlers closure; grep `pause: () =>`), `state.ts` (park shape: `isRunParked` 146–148, `findParkedRuns` 57–73).

**Semantics (the load-bearing design — an interrupted run must be PARKED, not FAILED):**

1. **The interlock seam is `pipeline.ts`'s phase loop, not the daemon (codex-verified, twice).** `runPipeline` persists run state itself **before** `handleRunOutcome` ever sees an outcome (`daemon.ts` ~1618/~2337 receive it after the fact) — a daemon-side-only flag cannot prevent bad persistence. And parking only at the *terminal* failed/stuck save is still wrong: a killed worker returns a phase `failure` event, which **self-loops** (`fsm.ts:24/:41/:53` route failure back to the same phase; `advancePhase` only converts to `stuck` after retry exhaustion, `pipeline.ts:453-460`) — so during halt the loop would save the same phase (`pipeline.ts:432-436`), retry, and **spawn another worker**; a just-finished `success` would likewise advance and continue. Therefore: thread `isHalting(): boolean` into `runPipeline`/its options (same optional-trailing-plumbing pattern as `onDetectSettled`), and check it **immediately after every phase-handler return/catch, BEFORE retry/global-failure/advance routing**: if halting → persist the park shape (`phase: 'paused'`, `pausedAtPhase: <interrupted phase>`, `parkedBy: 'halt'`) and exit the loop — no retry, no advance, no further spawn. Cover **all** of `runPipeline`'s save sites, not just the terminal one (grep anchors: `pipeline.ts:122-140` pre-flight, `:154-174`, `:277-308`, `:381-436`, and the same-phase save at `:432-436`); the two **pre-handler** save paths (missing-handler pre-flight `:122-140`, budget stop `:154-174`) get the same `isHalting()` park check *before* their saves when halting is already true.
1b. **`RunState` type extension (typecheck reality):** `parkedBy` does not exist on `RunState` (`packages/daemon/src/types.ts` — `pausedAtPhase?: Phase` at ~420, no `parkedBy` through ~466). Add `parkedBy?: 'halt'` there; `types.ts` is already in STACK-AC-CONTAINMENT/`code_paths` — verify the owning node still covers it after the change.
2. **Halt sequence in the route handler:** set `paused = true` + `pauseReason: 'halt'` + the halting flag → call Task 5's `terminateAllManagedProcessGroups({ graceMs: 5000 })` → await in-flight `runPipeline` settlements (bounded wait) → clear the halting flag; `paused` stays set until `/resume`.
3. **`PauseReason` is a closed union — extend it (codex-verified).** Add `'halt'` to `PauseReason` (`health.ts:17-22`) and classify it in the health logic (`health.ts:24-30, 86-92`) alongside the operator-initiated reasons (mirror `'manual'`'s classification, distinct reason string so `/health` surfaces "halted"). Without this the plan's `pauseReason: 'halt'` does not typecheck.
4. **Resume path must be real (codex-verified: today it would rot).** `resumeParkedRuns` (`daemon.ts:2481-2488`) only re-admits `pausedAtPhase === 'l2-gate' | 'integrate'`; every other parked phase is skipped forever, and `/retry` is NOT a resume path (`operator-retry.ts:251-270` — admits only `stuck` issues and **deletes** run state to restart from scratch). Extend `resumeParkedRuns` with a **halt arm evaluated BEFORE the existing `l2-gate`/`integrate` decision branches** (precedence matters: a halt-parked run whose `pausedAtPhase` happens to be `integrate` must not be mistaken for a decision-parked run): runs with `parkedBy: 'halt'` are re-admitted once the daemon is unpaused, re-entering at their recorded `pausedAtPhase` via the same inline re-entry mechanism the crash-resumption startup pass uses (`findIncompleteRuns` pattern — it already re-enters arbitrary recorded phases). **Halt-resume must clear BOTH `parkedBy` AND `pausedAtPhase` before re-entry/persist** (mirror how the existing resume branches clear parked state before re-entry, `daemon.ts` ~2735/~2973) — a stale `parkedBy: 'halt'` left on the run would make a later legitimate `l2-gate`/`integrate` decision park take the halt arm and bypass the decision branches (`pipeline.ts:267` treats any `pausedAtPhase` as parked). Decision-parked runs (no `parkedBy`) keep their existing predicates untouched.
5. Response body: `{ halted: true, parked: [<issue numbers>], terminated, escalated }`. Idempotent: a second `POST /halt` while halted returns current state, kills nothing new.
6. **Auth posture (explicit, not inherited silently):** all POSTs today pass only the `X-Requested-By` CSRF check (`server.ts:65-72` — CSRF, not auth; server binds 127.0.0.1). `/halt` keeps that check AND, when `RUNFORGE_CONTROL_TOKEN` is set in the daemon env, requires `Authorization: Bearer <token>` — applied to `/halt` (and shared as a helper P3.5 can extend to all POSTs later). When the token is unset, `/halt` still works locally (an emergency stop must not be blocked by unset config; halting is the safe direction). Document this trade in the route comment.
7. `docs/running.md`: one short section — halt vs pause vs drain vs SIGUSR2, and the curl shape (`curl -X POST -H 'X-Requested-By: dashboard' [-H 'Authorization: Bearer …'] http://127.0.0.1:<port>/halt`).

**Internal ordering (codex finding):** the `pipeline.ts` park-interlock (step 1) and the health-contract extension (step 3) land **before** the route is exposed — a `/halt` that kills workers while persistence still records stuck/failure is worse than no `/halt`.

**Commit:** `feat(control-plane): POST /halt — pause + park in-flight runs + escalating worker kill; resumable via existing park machinery (P0.5)`

## Task 7 (0.5c) — `/pause` gates phase transitions (integrate-entry minimum)

**Files:** `daemon.ts` / `pipeline.ts` / `phases.ts` (grep `integrate` handler entry and how handlers receive daemon-scoped accessors — the 779-gap6 work threaded `onDetectSettled` through `createPhaseHandlers`; use the same threading pattern for an `isPaused()` accessor).

**Defect:** `paused` only gates work-claim; an already-admitted run proceeds through **merge** after pause. For an operator, "pause" that still merges is a broken promise.

**Steps:**
1. Thread `isPaused(): boolean` (and the Task 6 `halting` check if not already visible there) into the phase-execution layer via `createPhaseHandlers`' existing optional-trailing-plumbing pattern (`phases.ts:147-181`, where `onDetectSettled` lives — codex-confirmed feasible). **The minimum safe hook point is immediately before the `integrateToStaging` call in the integrate handler** (`phases.ts` ~1944–1993, grep `integrateToStaging(`): if paused → park the run (`phase: 'paused'`, `pausedAtPhase: 'integrate'`) and stop; it resumes via the existing integrate arm of `resumeParkedRuns` after `/resume`.
2. Optionally gate all phase-entry transitions the same way if the threading makes it uniform and cheap; integrate-entry is the hard requirement (it is the irreversible, outward-facing phase).
3. Doc line in `docs/running.md`'s pause section: pause = no new claims + no integrate-entry; halt = pause + kill + park.

**Commit:** `fix(control-plane): pause gates integrate-entry — paused runs park instead of merging (P0.5)`

## Task 8 — Traceability, suite, lint, baseline

1. `traceability.yml`: add any new files to the owning node's `code_paths`, new test files to `test_paths` (STACK-AC-CONTAINMENT for session-runtime work; STACK-AC-CONTROL-PLANE for daemon/server work). Run `pnpm --filter @runforge/daemon test src/infra/traceability-paths.test.ts`.
2. **Capture the failure baseline BEFORE changes** (`pnpm --filter @runforge/daemon test 2>&1 | tail -30` — real-PG suites skip without a local Postgres; note which failures pre-exist), then after all tasks: full `pnpm --filter @runforge/daemon test` shows **no new failures vs. that baseline**, plus `pnpm --filter @runforge/daemon typecheck` and `pnpm --filter @runforge/daemon lint` fully green.
3. Dependencies: Task 6 depends on Task 5 (terminate) **and on its own step-1 `pipeline.ts` interlock + step-3 health-union extension landing before the route is exposed**; Task 7 shares the accessor threading with Task 6. Implement 5 → 6 (interlock → health → route → resume arm) → 7 in order; Tasks 1–4 are independent of each other and of 5–7.

---

## Acceptance-gate behavioral contract (for the GATE-AUTHOR — tests must FAIL against current HEAD)

- **G1 (Task 1):** subprocess contract test: generated scope-hook script, fed an out-of-scope `Write` tool-call JSON on stdin, exits **2** with the reason on stderr; in-scope call exits **0**. (Fails today: script always exits 0.)
- **G2 (Task 2):** a website-variant non-checkpoint phase handler invocation returns `'failure'` (not `'success'`) and emits the structured stub error. (Fails today: returns `'success'`.)
- **G3 (Task 3):** config guard: `runforge.config.json` `branches.staging`/`branches.production` ∉ {`dev`} (and equal to `main` for the single-trunk shape); AND `createReleaseProposal` with `stagingBranch === productionBranch` does **not** call `pulls.create` and returns the truthful `'single-trunk-not-applicable'` status — not `no-completed-work`. (Fails today: staging is `dev`; no guard or status exists.)
- **G4 (Task 4):** `auditSessionOutput` (or its successor shape) flags `sk-ant-…`/`ghp_…`/`AKIA…`/private-key-block strings as `severity: 'fatal'` with redacted matches; blocked-command evidence remains `'advisory'`; and the runtime path fails a session on fatal violations (integration-level assertion at the `runtime.ts` seam — mock/fake session output). (Fails today: no such detection exists.)
- **G5 (Task 5):** `terminateAllManagedProcessGroups` SIGTERMs a registered child that exits in grace → `{terminated: 1, escalated: 0}`; a SIGTERM-ignoring child gets SIGKILLed → `escalated: 1`. (Fails today: function absent.)
- **G6 (Task 6):** `POST /halt` (with `X-Requested-By`) returns halted response; while halting, a phase handler settling with **failure does not retry/re-spawn** and one settling with **success does not advance** — in both cases the run is persisted **parked** (`phase 'paused'`, `pausedAtPhase` set, `parkedBy: 'halt'`), never failed/stuck/advanced (exercise the `pipeline.ts` loop seam directly); after `paused` clears, the halt-parked run is re-admitted at its `pausedAtPhase` (halt arm takes precedence over decision-park arms; any phase, not just l2-gate/integrate) **and its persisted state after resume carries neither `parkedBy` nor `pausedAtPhase`**; with `RUNFORGE_CONTROL_TOKEN` set, missing/wrong Bearer → 401/403. (Fails today: route absent.)
- **G7 (Task 7):** with `paused = true`, a run reaching integrate-entry parks instead of merging. (Fails today: it merges.)

Gate tests live under the owning packages' existing test conventions (`packages/daemon/src/**/*.test.ts`), respect the 30s timeout floor, must not require a real Postgres, and must not depend on wall-clock sleeps where fake timers suffice (exception: G5 real-subprocess grace timing — keep graceMs small in test, e.g. 200ms).

## Verify command (work-order `verify_command`)

```
pnpm --filter @runforge/daemon test <gate test paths> && pnpm --filter @runforge/daemon typecheck
```

(Gate paths filled in at HANDOFF once the gate lands. Full-suite baseline diff + lint are Definition-of-done, run by the implementer before PR.)

## Definition of done (this PR — Phase 0 code)

- All gate tests green via `verify_command`; no gate/spec/plan file modified by the implementer.
- Full daemon suite: no new failures vs. pre-change baseline; typecheck + lint green; traceability-paths test green.
- PR opened against `plan/first-production-deployment-regulated-full-l0` (base), branch `codex/phase0-safety-floors-build`.

**NOT in this PR (Phase-0 done-evidence, post-merge — program plan requires a live run, never green tests):** the execution log with (a) a live worker session where an out-of-scope write is blocked mid-session, (b) a seeded secret in output failing a session, (c) the halt drill — long-running live session killed via `POST /halt`, run parked, later resumed. That is the orchestrator's Phase 9 after the Operator merges, and it gates P2 entry.

## Follow-ups (documented, not blocking)

- P3.5 generalizes the Bearer-token check to all POST routes; P3.6 adds the UI halt button.
- Whether blocked-command advisory audit should ever become terminal → revisit only with an explicit decision reversing #489 (out of Phase 0 scope).
- `phases-website.ts` Plan-2 real implementation (or variant deletion) — tracked via #774.
