# Daemon Pipeline Hardening Design

> Fix structural bugs that cause infinite stuck retry loops and implement missing spec-driven pipeline handlers.

**Goal:** Make the daemon pipeline robust against missing handlers, stuck issue loops, and wiring bugs — then implement the spec pipeline handlers so L2→L3→implement actually works autonomously.

**Architecture:** Two-layer fix. Layer 1 adds safety rails to the pipeline engine itself (variant-agnostic). Layer 2 implements the four missing spec-driven phase handlers. Both layers ship together.

**Context:** The spec-driven pipeline variant defines phases `l2-design`, `l2-gate`, `l3-generate`, `l3-compliance` in `spec-pipeline/variant.ts`, but `createPhaseHandlers()` in `phases.ts` has no handlers for them. The pipeline auto-succeeds these phases, then hits `implement` which fails because no spec work was actually done. The daemon retries the stuck issue on every poll cycle because `stuck` is not in the work detection exclusion lists. Result: 30+ stuck runs per day for the same issue.

---

## Layer 1: Pipeline Safety

### 1.1 Filter stuck issues from work detection

**Files:** `packages/daemon/src/control-plane/work-detection.ts`

Add `'stuck'` to the `exclude` array in every tier of `detectFeaturePipelineWork()` (4 tiers, lines 82–85) and to `detectBugFixWork()` (line 57).

Once an issue has the `stuck` label, the daemon stops picking it up. A human or operator must remove `stuck` (and optionally add `blocked`) to either retry or shelve the issue.

### 1.2 Per-issue retry cap

**Files:** `packages/daemon/src/control-plane/daemon.ts`, `packages/daemon/src/types.ts`

Inside `processWorkRequest` (after claim, before pipeline start — ensures atomicity with claim):

1. Count previous stuck runs for this issue, scoped by repo to avoid cross-repo collisions:
   - **DB mode:** Query `runs` table: `SELECT count(*) FROM runs WHERE issue_number = $1 AND repo_owner = $2 AND repo_name = $3 AND outcome = 'stuck'`
   - **Legacy mode:** Not supported — legacy mode is single-repo, so bare issue number is safe. But since `StateManager.saveRunState` overwrites the single state file per issue (no history), make retry cap DB-only. In legacy mode, rely on stuck label filtering (1.1) and backoff (1.5) instead.
2. If count >= `maxRunsPerIssue` (config field, default 3):
   - Add `blocked` label to the issue via Octokit
   - Post a comment: `Auto-blocked: this issue went stuck ${count} times. Needs human investigation.`
   - Release the claim by removing all claim labels (`in-progress`, `implementing`, `l2-in-progress`, `l3-in-progress`, `l3-review`) — use a shared `releaseClaim(octokit, owner, repo, issueNumber)` helper that removes any of these labels that are present
   - Return early without starting the pipeline

The check happens after claiming to avoid a race condition where another poll cycle claims the same issue between the count check and the claim.

This prevents any single issue from consuming the entire daily budget through retries.

### 1.3 Handler existence validation

**Files:** `packages/daemon/src/control-plane/pipeline.ts`

Add a pre-flight check at the top of `runPipeline()`, before the `while (true)` loop:

```typescript
// Validate all non-terminal phases in the transition table have handlers
const missingHandlers: string[] = [];
for (const phase of Object.keys(table)) {
  if (phase === 'stuck' || phase === 'paused') continue; // terminal
  if (!handlers[phase as Phase]) {
    missingHandlers.push(phase);
  }
}
if (missingHandlers.length > 0) {
  const msg = `Missing handlers for phases: ${missingHandlers.join(', ')} in variant`;
  console.error(`[pipeline] ${msg}`);
  run.phase = 'stuck';
  await stateMgr.saveRunState(run);
  void runWriter?.upsertRun(run.id, { current_phase: 'stuck', phases: buildPhaseRecords(run) });
  return { outcome: 'stuck', run, error: msg };
}
```

Note: returns `'stuck'` (not `'error'`) so that `handleRunOutcome` in daemon.ts handles it correctly — incrementing stuck count, adding the stuck label, and not leaving dangling claims.

This catches wiring bugs at pipeline start rather than failing silently at runtime. Every phase in the FSM transition table must have a corresponding handler — no more auto-success as a fallback.

**Breaking change:** The `decompose` phase in the `feature` variant also has no handler and currently auto-succeeds. This validation would catch it. Resolution: add a trivial `decompose` handler that returns `'success'` (preserving current behavior explicitly).

**Atomicity requirement:** The handler validation (1.3) and the `decompose` handler (3.5) MUST ship in the same commit. If validation lands without the decompose handler, all `feature` variant runs break immediately. Same applies to the four spec pipeline handlers — they must be present before validation is enabled for the `spec-driven` variant.

### 1.4 Gate parking mechanism (l2-gate)

**Files:** `packages/daemon/src/control-plane/pipeline.ts`, `packages/daemon/src/types.ts`, `packages/daemon/src/control-plane/daemon.ts`

The `l2-gate` handler needs to park the run when no approval label is present. This MUST NOT use `applyGlobalTransition()` because that path leads to `handleRunOutcome('paused')` in daemon.ts, which auto-pauses the **entire daemon** (intended for budget exhaustion only).

**Approach: Handler signals parking via RunState field; pipeline intercepts before FSM advance.**

1. Add `'parked'` to the `PipelineResult.outcome` type (alongside `complete`, `stuck`, `paused`, `error`)
2. The `l2-gate` handler sets `run.pausedAtPhase = 'l2-gate'` (but does NOT mutate `run.phase`) and returns `'success'`
3. In pipeline.ts, add a check **after cost sync (line 124) but before global transition check (line 127)**:
   ```typescript
   // Check if handler requested parking (e.g., l2-gate awaiting approval)
   if (run.pausedAtPhase) {
     run.phase = 'paused';
     await stateMgr.saveRunState(run);
     void runWriter?.upsertRun(run.id, { current_phase: run.phase, phases: buildPhaseRecords(run) });
     return { outcome: 'parked', run };
   }
   ```
   This intercepts BEFORE `advancePhase()` reads `run.phase`, avoiding the bug where the handler mutates `run.phase` to `'paused'` and the FSM can't find a transition for `('paused', 'success')`.
4. In `handleRunOutcome`: treat `'parked'` as a no-op — do NOT increment stuck count, do NOT auto-pause daemon
5. The run is saved to state/DB with `phase: 'paused'` and `pausedAtPhase: 'l2-gate'`

**Resume mechanism:** Add a dedicated scan in the daemon's poll loop:

1. After normal work detection, query for parked runs:
   - **DB mode:** `SELECT * FROM runs WHERE current_phase = 'paused' AND outcome = 'in-progress' LIMIT 1` — then check `pausedAtPhase` from the run's JSON metadata (no schema migration needed; `pausedAtPhase` lives in the RunState JSON persisted by `StateManager`, not as a DB column)
   - **Legacy mode:** Scan state files for `phase === 'paused' && pausedAtPhase != null`
2. For each parked run with `pausedAtPhase === 'l2-gate'`: re-check issue labels via Octokit
3. If `l2-approved` now exists: remove `awaiting-l2-review` label, reset `run.phase` to `l2-gate`, clear `pausedAtPhase`, re-enter pipeline
4. Limit to 1 resume per poll cycle to avoid thundering herd

**Label safety for parked runs:** When the `l2-gate` handler parks a run, it adds the `awaiting-l2-review` label (section 2.2). This label must be added to the work detection exclusion lists (all tiers + bug fix) alongside `'stuck'` and `'blocked'`. This prevents a parked run from being re-claimed by normal work detection while the resume scan handles it. The `activeIssues` Set in daemon.ts also prevents re-claim during the same daemon lifecycle, but the label exclusion protects across restarts.

New `RunState` fields:
- `pausedAtPhase?: Phase` — which phase requested parking
- `l2GateNotified?: boolean` — whether the human notification was sent

### 1.5 Retry backoff

**Files:** `packages/daemon/src/control-plane/daemon.ts`

Track stuck timestamps per issue in a `Map<string, { count: number; lastStuckAt: number }>` (key: `owner/repo#issueNumber` to avoid cross-repo collisions):

- When a run goes stuck, record `{ count: prevCount + 1, lastStuckAt: Date.now() }` for that issue
- On each poll, after work detection returns a candidate, check if it went stuck recently:
  - Backoff = `min(baseBackoffMs * 2^count, maxBackoffMs)` (default base: 60s, max: 30min)
  - If `Date.now() - lastStuckAt < backoff`, skip this candidate
  - To avoid queue starvation: pass the set of backed-off issue numbers to the detector as an exclusion set, so it can return the next available candidate instead of nothing
- Reset the entry when an issue completes successfully

This is in-memory only (resets on daemon restart, which is fine — restart is itself a form of backoff).

**Coordination with retry cap (1.2):** Backoff (in-memory, resets on restart) and the retry cap (persisted to DB) serve different purposes. Backoff slows down retries within a daemon lifecycle. The retry cap is a hard stop across restarts. After a restart, an issue may retry without backoff — this is intentional since the restart itself typically resolves transient issues (stale locks, memory pressure). The DB-based cap is the ultimate safety net.

---

## Layer 2: Spec Pipeline Handlers

### 2.1 `l2-design` handler

**Files:** `packages/daemon/src/control-plane/phases.ts`

Spawns a `l2-designer` session via `runtime.spawnSession()`:

- **Session type:** `'l2-designer'`
- **Context provided:**
  - L1 spec content loaded via `loadSpecContent(workRequest.specRefs, specifyRoot)`
  - Issue body (`workRequest.body`) — contains context about what L2 work is needed
  - Repo root path for the session to write specs to `.specify/architecture/`
- **Session instruction:** Use the `spec-brainstorm-l2` skill and `l2-spec-guardian` skill for format validation. Generate or update the ARCH-* spec file. Commit the result.
- **On success:** Returns `'success'` → FSM advances to `l2-gate`
- **On failure/error:** Returns `'failure'` → FSM retries (up to 3 per `specDrivenPhases`)

### 2.2 `l2-gate` handler

**Files:** `packages/daemon/src/control-plane/phases.ts`

This is a label-check gate, not a session:

```typescript
'l2-gate': async (run: RunState): Promise<PhaseEvent> => {
  const { data: labels } = await octokit.issues.listLabelsOnIssue({
    owner, repo, issue_number: workRequest.issueNumber,
  });
  const labelNames = labels.map(l => l.name);

  if (labelNames.includes('l2-approved')) {
    console.log(`[l2-gate] L2 approved for #${workRequest.issueNumber}`);
    return 'success';
  }
  if (labelNames.includes('l2-rejected')) {
    console.log(`[l2-gate] L2 rejected for #${workRequest.issueNumber}, looping back`);
    return 'feedback';
  }

  // First time parking: notify human that review is needed
  if (!run.l2GateNotified) {
    await octokit.issues.addLabels({ owner, repo, issue_number: workRequest.issueNumber, labels: ['awaiting-l2-review'] });
    await octokit.issues.createComment({ owner, repo, issue_number: workRequest.issueNumber,
      body: '**L2 spec generated.** Please review the ARCH-* spec and add `l2-approved` or `l2-rejected` label.',
    });
    run.l2GateNotified = true;
  }

  console.log(`[l2-gate] Awaiting L2 approval for #${workRequest.issueNumber}, parking`);
  run.pausedAtPhase = 'l2-gate';  // Signal to pipeline — do NOT set run.phase here
  return 'success';  // Pipeline checks pausedAtPhase before FSM advance → returns { outcome: 'parked' }
}
```

- `'success'` with `l2-approved` → advance to `l3-generate` (normal FSM advance)
- `'feedback'` with `l2-rejected` → loop back to `l2-design` (existing FSM transition)
- `'success'` with `pausedAtPhase` set → pipeline intercepts before FSM advance, sets `run.phase = 'paused'`, returns `{ outcome: 'parked' }`. This is NOT `'paused'` outcome (which triggers daemon-wide pause) — `'parked'` is a no-op in `handleRunOutcome`.

The daemon's parked-run resume scan (see 1.4) picks the run back up on a future poll cycle once `l2-approved` is added.

**Transition table cleanup:** The `unchanged` event in `specDrivenTransitions` for `l2-gate` becomes dead code since parking is handled via `pausedAtPhase` field, not a PhaseEvent. Remove it to avoid confusion.

### 2.3 `l3-generate` handler

**Files:** `packages/daemon/src/control-plane/phases.ts`

Spawns a `l3-generator` session:

- **Session type:** `'l3-generator'`
- **Context provided:**
  - L1 spec content
  - L2 spec content (just approved)
  - Issue body
  - Repo root for writing to `.specify/stack/`
- **Session instruction:** Use the `spec-generate-l3` skill and `l3-spec-guardian` skill. Generate the STACK-* spec file. Run the `spec-review-compliance` skill in inline mode as a self-check. Commit the result.
- **On success:** Returns `'success'` → FSM advances to `l3-compliance`
- **On failure:** Returns `'failure'` → FSM retries

### 2.4 `l3-compliance` handler

**Files:** `packages/daemon/src/control-plane/phases.ts`

Spawns a `compliance-reviewer` session:

- **Session type:** `'compliance-reviewer'`
- **Context provided:**
  - All three spec layers (L1, L2, L3) loaded via `loadSpecContent()`
  - The diff of the L3 spec file (what was just generated)
- **Session instruction:** Use the `spec-review-compliance` skill to verify the L3 spec is consistent with L1 and L2. Report pass/fail with specific gaps.
- **On success (compliant):** Returns `'success'` → FSM advances to `implement`
- **On failure (gaps found):** Returns `'failure'` → FSM loops back to `l3-generate`

### 2.5 Session type registration

**Files:** `packages/daemon/src/types.ts`, `packages/daemon/src/session-runtime/runtime.ts`, `packages/daemon/src/supabase/run-writer.ts`

The three new session types (`l2-designer`, `l3-generator`, `compliance-reviewer`) must be registered in:

1. **`SessionType` union** in `types.ts` — add the three new string literals
2. **`DEFAULT_AGENT_DEFS`** in `runtime.ts` — add agent definitions with appropriate system prompts that reference the skills (`spec-brainstorm-l2`, `spec-generate-l3`, `spec-review-compliance`, and the guardian skills)
3. **`toDbSessionType()`** in `run-writer.ts` — add mapping so session costs are tracked in Supabase

### 2.6 Spec chain refresh between phases

**Issue:** `workRequest.specRefs` is parsed from the original issue body. After `l2-design` generates a new ARCH-* spec, `specRefs` is stale — it won't include the newly created spec. Same after `l3-generate`.

**Fix:** Before each handler that loads spec content (`l3-generate`, `l3-compliance`, and later `implement`/`review`), re-resolve the spec chain from `.specify/traceability.yml` instead of relying on the static `workRequest.specRefs`. Use the existing `loadSpecContent()` with dynamically resolved refs.

Implementation: add a helper `resolveCurrentSpecRefs(specifyRoot, baseRefs)` that reads traceability.yml and follows the chain from the original L1 refs to find all related L2/L3 specs. Update `run.specRefs` after each spec generation phase so downstream handlers see the full chain.

### 2.7 Shared spec loading

All handlers use `loadSpecContent()` from `infra/spec-loader.ts` (already used by `diagnose` and `review` handlers). No new loading infrastructure needed — just wire the same call into each new handler, using refreshed spec refs from 2.6.

---

## Layer 3: Testing

### 3.1 Handler unit tests

**File:** `packages/daemon/src/control-plane/phases.test.ts`

For each new handler:
- `l2-design`: mock `runtime.spawnSession` → verify called with `'l2-designer'` and spec content
- `l2-gate`: four test cases:
  - Labels include `l2-approved` → returns `'success'`, `run.phase` unchanged
  - Labels include `l2-rejected` → returns `'feedback'`
  - Neither label → returns `'success'`, sets `run.pausedAtPhase = 'l2-gate'` (pipeline intercepts), adds `awaiting-l2-review` label, posts comment
  - Neither label, already notified (`run.l2GateNotified = true`) → parks run but does NOT re-notify
- `l3-generate`: mock session → verify called with `'l3-generator'` and L1+L2 content
- `l3-compliance`: mock session → verify called with all 3 layers; failure returns `'failure'`

### 3.2 Pipeline tests

**File:** `packages/daemon/src/control-plane/pipeline.test.ts`

- Handler validation: transition table with phase `foo`, no handler → expect `{ outcome: 'stuck', error: /Missing handlers/ }`
- Parked outcome: handler sets `run.pausedAtPhase = 'l2-gate'` and returns `'success'` → pipeline intercepts → expect `{ outcome: 'parked' }` with `run.phase === 'paused'`
- Parked vs paused: `applyGlobalTransition('budget-exceeded')` still returns `{ outcome: 'paused' }` (daemon-wide pause), NOT `'parked'`

### 3.3 Work detection filter tests

**File:** `packages/daemon/src/control-plane/work-detection.test.ts`

- Issue with `stuck` label is excluded from `detectFeaturePipelineWork()` (all 4 tiers)
- Issue with `stuck` label is excluded from `detectBugFixWork()`

### 3.4 Per-issue retry cap test

**File:** `packages/daemon/src/control-plane/daemon.test.ts`

- After 3 stuck runs for issue #42, daemon adds `blocked` label and skips the issue
- Issue with fewer than 3 stuck runs is still picked up

### 3.5 Additional test coverage

**File:** `packages/daemon/src/control-plane/fsm.test.ts`
- `applyGlobalTransition` does NOT map `'parked'` (it's not a PhaseEvent — it's a PipelineResult outcome)

**File:** `packages/daemon/src/control-plane/spec-pipeline/variant.test.ts`
- `l2-gate` no longer has `unchanged` transition

**File:** `packages/daemon/src/session-runtime/runtime.test.ts`
- New session types `l2-designer`, `l3-generator`, `compliance-reviewer` have valid agent defs

**File:** `packages/daemon/src/supabase/run-writer.test.ts`
- `toDbSessionType()` maps all new session types

### 3.6 Decompose handler

**File:** `packages/daemon/src/control-plane/phases.ts`

Add explicit `decompose` handler that returns `'success'` — makes the existing feature variant pass handler validation. This preserves current behavior but makes it explicit rather than relying on auto-success.

---

## Config Changes

**File:** `packages/daemon/src/config.ts`

New fields with defaults:
- `maxRunsPerIssue: 3` — per-issue retry cap before auto-blocking
- `retryBackoffBaseMs: 60_000` — base backoff between stuck retries (1 min)
- `retryBackoffMaxMs: 1_800_000` — max backoff cap (30 min)

**Type changes:**

**File:** `packages/daemon/src/types.ts`
- Add `pausedAtPhase?: Phase` and `l2GateNotified?: boolean` to `RunState`
- Add `'l2-designer' | 'l3-generator' | 'compliance-reviewer'` to `SessionType`

**Pipeline changes:**

**File:** `packages/daemon/src/control-plane/pipeline.ts`
- Add `'parked'` to `PipelineResult.outcome` type
- Add `pausedAtPhase` interception after cost sync, before global transition check: if `run.pausedAtPhase` is set after handler returns, set `run.phase = 'paused'` and return `{ outcome: 'parked' }`

**Daemon changes:**

**File:** `packages/daemon/src/control-plane/daemon.ts`
- In `handleRunOutcome`: treat `'parked'` as no-op (don't increment stuck, don't pause daemon)
- Add parked-run resume scan to poll loop

**FSM changes:**

**File:** `packages/daemon/src/control-plane/spec-pipeline/variant.ts`
- Remove dead `unchanged` transition from `l2-gate` entry

**Session runtime changes:**

**File:** `packages/daemon/src/session-runtime/runtime.ts`
- Add agent definitions for `l2-designer`, `l3-generator`, `compliance-reviewer`

**File:** `packages/daemon/src/supabase/run-writer.ts`
- Add `toDbSessionType()` mapping for new session types

---

## Files Modified

| File | Changes |
|------|---------|
| `control-plane/work-detection.ts` | Add `'stuck'` to exclusion lists |
| `control-plane/daemon.ts` | Per-issue retry cap, backoff tracking |
| `control-plane/pipeline.ts` | Handler existence validation |
| `control-plane/phases.ts` | 5 new handlers (l2-design, l2-gate, l3-generate, l3-compliance, decompose) |
| `types.ts` | `pausedAtPhase`, `l2GateNotified` on RunState; new SessionType literals |
| `control-plane/pipeline.ts` | Handler validation; `'parked'` outcome for gate-paused runs |
| `control-plane/spec-pipeline/variant.ts` | Remove dead `unchanged` transition from l2-gate |
| `session-runtime/runtime.ts` | Agent defs for l2-designer, l3-generator, compliance-reviewer |
| `supabase/run-writer.ts` | `toDbSessionType()` mapping for new session types |
| `infra/spec-loader.ts` | `resolveCurrentSpecRefs()` helper for dynamic spec chain resolution |
| `config.ts` | 3 new config fields |
| `control-plane/phases.test.ts` | Handler unit tests |
| `control-plane/pipeline.test.ts` | Validation test, parked outcome test |
| `control-plane/work-detection.test.ts` | Stuck filter tests, exclusion set tests |
| `control-plane/daemon.test.ts` | Retry cap test, parked-run resume test |
| `control-plane/fsm.test.ts` | Test for `parked` vs `paused` distinction |
| `control-plane/spec-pipeline/variant.test.ts` | Update for removed `unchanged` transition |

---

## Design Decisions

**Why no `deploy`/`test` phases in the spec-driven pipeline?**
The spec-driven pipeline's `implement` phase produces code, but `deploy` and `test` are optional phases configured per-repo (`deployCommand`, `healthCheckUrl`, `testCommands`). The existing `review` phase runs the deterministic gate (vitest + typecheck) which covers test verification. The `holdout` and `integrate` phases handle merge safety. If a repo configures deploy/test commands, those phases could be added to the spec-driven transition table later — but this is outside the current scope since no repo currently uses them.

**Why `specDrivenPhases.maxRetries` is not wired to the pipeline engine?**
The `specDrivenPhases` array defines `maxRetries` per phase, but `pipeline.ts` uses its own `DEFAULT_MAX_ATTEMPTS` (which defaults all phases to 3). These happen to agree for now. Wiring the spec metadata into the pipeline config is a follow-up improvement — not blocking since the defaults match.

---

## Out of Scope

- L1 spec generation — remains human-in-the-loop via PO skill
- FSM transition tables — correct as-is (except removing dead `unchanged` from l2-gate)
- Dashboard changes — no UI work needed
- Supabase schema migrations — `pausedAtPhase` and `l2GateNotified` live in RunState JSON (persisted by StateManager), not as DB columns. Resume query uses existing `current_phase` column. No migration needed.
- Wiring `specDrivenPhases.maxRetries` into pipeline config (follow-up)
