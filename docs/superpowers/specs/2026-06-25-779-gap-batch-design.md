# 779 — CLI-Adapter Gap Batch (Mechanical Fixes) — Design

**Issue:** #779 (mechanical batch). Escalation gap #2 is OUT OF SCOPE (handled separately).
**Branch:** `codex/779-gap-batch-build` (off `origin/main` @529ec2a, includes PR #778).
**Type:** Fixes governed by EXISTING (DRAFT) L3 specs. NOT a new L1→L2→L3 chain.

## Goal

Close five verified daemon defects discovered in the cli-adapter autonomy push.
Each is a localized fix against an already-governed source file. The batch is
ordered by dependency: cost-truth first (unblocks budgets), then the
classifier-cache and the P1 decompose-schema unblocker, then the detect-lock
serialization and the boot-env consolidation. Every fix ships with a unit test
that fails before and passes after.

Non-goals: no new spec chains; no refactors beyond each fix's blast radius; the
only traceability mutation is adding `daemon.ts` to `STACK-AC-CONTROL-PLANE`
(gap #6). Memory rule honored: `traceability.yml` `code_paths` must point to
files that EXIST — `daemon.ts` already exists, so the addition is safe.

## Build order (codex-validated, dependency-correct)

1. gap #3 cost parsing (+ #4 downstream, test-only)
2. gap #5 stale `preClassification` cache
3. gap #1 decompose structured schema (P1 unblocker)
4. gap #6 detect git-lock contention
5. gap #7 boot `.env` + consolidated env validation

---

## gap #3 — cost parsing reads the wrong field (covers #4)

### Current state (confirmed)

`packages/daemon/src/session-runtime/adapters/cli.ts` — `parseOutput()` at
**line 104**; the cost extraction is **lines 112–117**:

```ts
const rawCost = typeof json['cost_usd'] === 'number'
  ? json['cost_usd']
  : typeof json['cost'] === 'number'
    ? json['cost']
    : 0;
const cost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : 0;
```

The Claude CLI's `--output-format json` emits the per-run cost as
**`total_cost_usd`**, not `cost_usd` or `cost`. So `rawCost` is always `0`,
`cost` is always `0`, and `costEstimated` (line 123: `cost === 0`) is always
`true`. `parseOutput()` is the single read site — `spawn()`, `resume()`, the
timed-out branches, the rate-limit branch, and the `proc.on('error')` branch all
funnel through it (lines 416/417, 431/432, 491/492, 598/599, 613/614, 669/670).

**Downstream (gap #4):** because real cost is never recorded, the cost tracker /
window-scheduler budget logic mis-fires (`per-run-budget-exceeded` evaluated
against phantom zero costs). This is *purely* downstream of #3 — once real cost
is parsed, budgets work. No separate code change; a test proves cost is parsed.

`session-providers-ts.md:164` already mandates: absent cost fields must yield
`costEstimated: true` — "silently recording zero cost corrupts budget
enforcement and the per-lane telemetry." The current code violates the *intent*
of that line by reading a field the provider never emits, making
`costEstimated` permanently `true` for the canonical (Claude CLI) provider.

### Chosen fix

In `parseOutput()`, select the first **finite, positive** value among
`[total_cost_usd, cost_usd, cost]`; else `0`. `total_cost_usd` is the canonical
Claude-CLI field; `cost_usd`/`cost` are retained as fallbacks for other
providers / older CLI shapes (operator instruction). Replace the nested ternary
with an ordered scan so a `NaN`/negative leading field correctly falls through
to the next candidate instead of poisoning the result.

```ts
const costCandidates = [json['total_cost_usd'], json['cost_usd'], json['cost']];
let cost = 0;
for (const c of costCandidates) {
  if (typeof c === 'number' && Number.isFinite(c) && c > 0) { cost = c; break; }
}
```

`costEstimated: cost === 0` is unchanged. The existing BUG-16 sanitization
behavior (NaN/negative/Infinity → 0) is preserved and *strengthened*: a poisoned
leading field no longer masks a valid fallback.

### Rejected alternative

Read only `total_cost_usd` and drop the fallbacks. Rejected: the operator
explicitly wants `cost_usd`/`cost` retained for non-Claude providers and forward
safety; the cost is negligible and the fallbacks are already tested.

### Governing specs

`STACK-AC-SESSION-PROVIDERS` (cli.ts). `cost.ts` consumers governed by
`STACK-AC-OPERATIONAL-SAFETY`. Both DRAFT, both already list the touched files.
No traceability change. No spec-text change required — the fix aligns the
implementation with `session-providers-ts.md:164`'s existing intent.

---

## gap #5 — stale `preClassification` cache re-fires failed classifications

### Current state (confirmed)

- **Write site:** `packages/daemon/src/control-plane/daemon.ts`,
  `preClassifyReadyWork()` — `preClassification` is set at **lines 2500–2514**
  (`preClassification: { event: item.event, ... }` at 2505), unconditionally for
  every batch result item that has a match.
- **Read site:** `packages/daemon/src/control-plane/phases.ts`, the `classify`
  handler — **lines 1077–1084**: when `workRequest.preClassification` is present
  the handler SKIPS the classifier session and returns `preClassification.event`
  verbatim.

The batch classifier (`control-plane/batch-classifier.ts`) distinguishes real
classifications from non-classifications via the `BatchResultItem.classified`
boolean (interface lines 29–40):
- `toResultItem()` (line 324) → `classified: true`, `event: success|success:simple`.
- `unclassified()` (line 342) → `classified: false` for rate-limited /
  budget-exceeded / containment-breach.
- `orderResults()` (line 354) → for any issue with no result, falls back to
  `unclassified(issue, 'success:simple')` — `classified: false` but event
  `'success:simple'` (the "empty" case).

Because the write site caches **any** item, a `classified: false` result
(rate-limited, errored, or empty) gets stored as `preClassification`. On retry
the `classify` handler short-circuits and re-emits the stale failure event,
never re-running the (now-fixed) classifier. Note `'success:simple'` is
**overloaded** — emitted both for genuine simple classifications
(`classified: true`) and for the empty fallback (`classified: false`) — so
gating on the event string alone is insufficient.

### Chosen fix

Gate the write on **`item.classified === true && item.complexity !== undefined`**.
Otherwise return the request unchanged so the per-run `classify` phase re-runs the
live (fixed) classifier on the next attempt.

The `complexity !== undefined` clause is REQUIRED (codex catch — verified):
`item.classified` alone is NOT the unambiguous "real classification" signal.
In the per-issue fallback path (`batch-classifier.ts:297–312`, used when the
batch session itself failed), `classified: !signal` — and `signal` is only set
for budget/rate-limit/containment events. A classifier `classify()` that fell
back to `'success:simple'` with **no complexity** (the session-failed and
invalid-output fallbacks at `classifier.ts:96` and `:136`) yields
`signal=undefined` → `classified: true` despite being a non-classification.
A REAL classification always carries `complexity` (`classifier.ts:139–147`), so
`complexity !== undefined` is the true discriminator and also excludes the
overloaded-`success:simple` empty/`orderResults` case (`classified:false`).

```ts
return requests.map((request) => {
  const item = byIssue.get(request.issueNumber);
  if (!item || item.classified !== true || item.complexity === undefined) return request; // re-classify live
  return { ...request, preClassification: { event: item.event, complexity: item.complexity, ... } };
});
```

### Rejected alternatives

- Gate on `item.event` being a success event (`'success' | 'success:simple'`).
  Rejected: `'success:simple'` is overloaded — emitted by the empty/`orderResults`
  fallback (`classified:false`) AND the classifier fallback (`classified:true,
  complexity:undefined`), so event-string gating caches non-classifications.
- Gate on `item.classified === true` alone. Rejected (codex): the fallback path
  sets `classified:true` for a complexity-less `success:simple`; the
  `complexity` presence check is needed.

### Governing spec

`STACK-AC-BATCH-CLASSIFIER` (DRAFT). The write site lives in `daemon.ts`, which
is already governed by `STACK-AC-OPERATIONAL-SAFETY` /
`STACK-AC-RECOVERABLE-FAILURE-ROUTING` `code_paths`; the cache *semantics* are a
batch-classifier concern. No traceability change.

---

## gap #1 — decompose passes no structured schema (P1 unblocker)

### Current state (confirmed)

`packages/daemon/src/implementation/decompose.ts` spawns the coordinator twice:
- first attempt: `spawnSession('coordinator', {...}, issueNumber, undefined, ...)`
  — **lines 26–40**, 4th arg `undefined` at **line 37**.
- retry: same call — **lines 52–66**, 4th arg `undefined` at **line 63**.

The 4th arg is `SpawnSessionOptions` (`runtime.ts:49–53`:
`{ jsonSchema?: string | object; agentDef?; costAttributionIssueNumbers? }`).
With no `jsonSchema`, the CLI adapter's `buildArgs()` never passes
`--json-schema` (cli.ts:53–55), so the coordinator is not constrained to emit a
`units` array. Result: intermittent `error_max_turns` with no parseable
structured output, `parseTaskGraph` fails ("missing units array"), and
`standard`-complexity issues stick.

The proven pattern is the classifier: `classifier.ts:58–67` passes
`{ jsonSchema: classificationJsonSchema }`; `classifier-schema.ts:32–34` derives
the JSON string via `JSON.stringify(z.toJSONSchema(Schema, { target: 'draft-07' }))`.

**Provider-contract facts (codex flag — verified empirically):**
- `z.toJSONSchema` (zod ^4.3.6) emits **`additionalProperties: false`** by
  default for `z.object`, recursively (verified: top-level and nested array
  items both get `additionalProperties: false`, plus a `required` array). So the
  schema is a STRICT contract — the coordinator's output must match the field
  set exactly or `--json-schema` enforcement rejects it.
- `prompts/coordinator.md` (lines 21–38) documents the exact wire shape: a
  top-level object with only `units`, each unit having `id, title, specIds,
  specContent, expectedArtifacts, dependencies, batchNumber, verificationCommand,
  context, estimatedChangeSize`. This is EXACTLY the `Unit` interface
  (`types.ts:526–537`), with `estimatedChangeSize` optional.
- The model emits only `{ units }`; `decompose.ts` injects `issueNumber` /
  `featureBranch` from args (parseTaskGraph), so the schema's top level is
  `{ units }` — NOT the illustrative `TaskGraphSchema` in
  `implementation-coordinator-ts.md:101` (which also lists issueNumber/
  featureBranch and uses `deps`/`batch` — that block is illustrative, not the
  wire contract).

### Chosen fix

1. New module `packages/daemon/src/implementation/task-graph-schema.ts` (mirrors
   `classifier-schema.ts`): a Zod `UnitSchema` whose fields are exactly the
   `Unit` interface (`estimatedChangeSize` optional, all else required), a
   `TaskGraphInputSchema = z.object({ units: z.array(UnitSchema) })`, and
   `taskGraphJsonSchema = JSON.stringify(z.toJSONSchema(TaskGraphInputSchema,
   { target: 'draft-07' }))`.
2. `decompose.ts`: pass `{ jsonSchema: taskGraphJsonSchema }` as the 4th arg to
   BOTH `spawnSession` calls (lines 37 and 63).

**Anti-drift / provider-contract guarantee (the codex-critical requirement):**
The schema is the SAME shape `task-graph.ts` validates and the coordinator
prompt documents. We enforce this with tests, not prose:
- the documented `coordinator.md` example unit must **pass** `UnitSchema`
  (parsed out of the prompt's ```json block);
- the `UnitSchema` key set must **equal** the `Unit` interface key set and the
  prompt example's key set (drift in any of the three fails the test);
- `task-graph.ts` keeps ownership of cross-unit semantics (unique IDs, sequential
  batches, dependency-ordering) that JSON Schema cannot express — `validateTaskGraph`
  is unchanged; the Zod schema governs only field shape.

`estimatedChangeSize` MUST be `.optional()` — it is optional in the `Unit`
interface (`types.ts:536`, `estimatedChangeSize?`) and the tolerant parser
(`decompose.ts:111–113`) treats it as optional. (Note: the `coordinator.md`
example *includes* `estimatedChangeSize` and does not label it optional — codex
correction; the schema's optionality is justified by the `Unit` contract, not the
prompt. A test asserts a unit omitting it still parses.) Marking it required
would make the contract stricter than the `Unit` type. We deliberately keep the
default `additionalProperties: false` (matches the proven classifier and the
prompt's exact field set) rather than loosening it — the anti-drift tests guard
the prompt↔schema↔type agreement that makes strict mode safe.

### Rejected alternative

A loose schema (`{ units: z.array(z.object({}).passthrough()) }` / `any`).
Rejected: it would technically supply a schema but not constrain the contract —
the coordinator could still omit `units`, defeating the purpose. The codex flag
is explicit: the schema must match the units/task-graph shape, not "an object."

### Out of scope / parked

`agent-discipline-prompts-ts.md:42` aspirationally calls for a `successCriteria`
field on units. It is NOT in `Unit`, the parser, or `coordinator.md`. Adding it
is a separate feature, not a mechanical fix — **parked** (see Open Questions).
The schema mirrors the IMPLEMENTED shape only.

### Governing specs

`STACK-AC-IMPLEMENTATION` (decompose.ts + the new schema file, both under the
`packages/daemon/src/implementation/` `code_paths` glob — no traceability change
needed) and `STACK-AC-AGENT-DISCIPLINE-PROMPTS` (decompose.ts + coordinator.md,
both already listed). Both DRAFT.

---

## gap #6 — detect git-lock contention masquerades as workspace corruption

### Current state (confirmed)

`packages/daemon/src/control-plane/phases.ts`:
- module-level `let repoGitLock = false` (**line 68**); `acquireRepoGitLock()`
  (**74–78**) is a non-blocking in-process boolean (returns `false` if held);
  `releaseRepoGitLock()` (80–82); `isRepoGitLocked()` (84–86); back-compat
  aliases `acquire/release/isDetectLock` (89–91).
- `detect` handler (**438–494**): `if (!acquireRepoGitLock())` (**439**) →
  records a `workspace-repair-needed` failure with
  `repairAction: 'recreate-workspace'`, `retryable: true` (**441–448**) and
  returns `'failure'`. The lock is released in `finally` (**492**) after
  `reconcileWorkspace()` (the checkout-mutating op, **466–472**).

`packages/daemon/src/control-plane/daemon.ts`: `processWorkRequest` is dispatched
**fire-and-forget** (not awaited) at three sites in the poll tick — ready work
(**1233**, gated loop 1196–1226), bug-fix (**1292**), feature-pipeline (**1352**).
`processWorkRequest` (def **2524**) does substantial async setup
(`saveRunState`, `insertRun`, `countStuckRunsForIssue`, `resolveTokenForRepo`,
`readAgencyConfig`, `createPhaseHandlers`) BEFORE the FSM reaches `detect`.

Because runs are fire-and-forget, runs race into `detect`. The loser's
`acquireRepoGitLock()` returns `false` and its run is failed as
`workspace-repair-needed` → `recreate-workspace`: a **destructive** repair path
triggered by *normal* contention. (Precision — codex round-3: the in-tick
`activeRuns` checks at the three fresh-work sites DO prevent same-tick
ready/bug/feature fanout at `maxConcurrentRuns=1`; the real `=1` hole is the
**crash-resumption** path, which increments `activeRuns` and resumes from
`run.phase` — possibly `detect` — WITHOUT a concurrency-limit check, plus
cross-poll timing.)

### Chosen fix — serialize the *detect phase* at the dispatch boundary, via ONE centralized gate covering ALL in-process detect entrants

Operator decision: **serialize-before-spawn** — a run must not be spawned into a
`detect` it cannot legally execute. Codex review surfaced three correctness
requirements the naive "gate the 3 dispatch sites + clear on detect.finally"
design fails; the mechanism below incorporates all three.

**(A) Gate every in-process spawn whose ENTRY phase is `detect`, not just the 3
fresh-work sites.** The in-process detect entrants are (verified by reading the
spawn sites):
- the ready/bug/feature **fresh-work** dispatch sites (daemon.ts 1233/1292/1352) —
  entry phase = `getStartPhase(selectVariant(request))`, which is `detect` for
  non-website variants;
- the **crash-resumption** path (`findIncompleteRuns` loop, daemon.ts ~1567–1660,
  `activeRuns++` at ~1587, `runPipeline` at ~1650) — resumes from `run.phase`,
  which **can be `detect`** if the run crashed during detect, WITHOUT a
  concurrency-limit check. Entry phase = `run.phase`.

The **parked-decision resume** (`reenterPipeline`, daemon.ts ~2217, called from
`resumeParkedRuns`) is NOT a detect entrant: it resets `run.phase` to a
post-detect decision phase (`l2-design`/`l2-gate`/`integrate`/`implement`, daemon.ts
~1964–1974 / ~2164–2174) before `runPipeline`, so it never re-runs `detect` — do
NOT gate it. (Codex round-1 flagged "resume → race into detect"; the precise
detect-entrant is the *crash-resumption* path, not `reenterPipeline`.)

Unified rule: **gate iff the run's entry phase === `detect`** — `getStartPhase(
variant)` for fresh work, `run.phase` for crash-resume. Centralize the gate into
ONE helper / guard applied at the fresh-work sites AND the crash-resumption spawn.
(`process-single.ts:147` calls `createPhaseHandlers` directly but runs in a
SEPARATE CLI process — the in-process gate and the existing per-process
`repoGitLock` neither see nor serialize it; cross-process serialization is out of
scope and pre-existing.)

**(B) Gate ONLY runs whose entry phase is `detect`.** The website variant starts
at `init`, not `detect` (`fsm.ts:91`, `getStartPhase`), so a website run would set
the gate but never reach `detect`, never fire `onDetectSettled`, and leak the
entry forever. Likewise a crash-resumed run re-entering at `implement`/`integrate`
must not be gated. The gate applies only when the entry phase (per (A)) is
`detect`; website / non-detect / post-detect-resume runs bypass it entirely.

**(C) Per-run idempotent release, fired by BOTH detect-settled AND a process
`.finally` backstop.** Setting the gate before `processWorkRequest` and clearing
it only in `detect`'s `finally` LEAKS whenever a run throws BEFORE the FSM reaches
detect — and there is a large pre-detect window: `saveRunState` (daemon.ts:2575),
`insertRun`, the retry-cap token resolution, `readAgencyConfig` (daemon.ts:2639),
and handler construction can all throw first → the repo is permanently blocked.
Mechanism:
- the gate is a `Set<repoKey>` (or `Map`). **Where it is checked/set matters
  (codex plan-review CRITICAL):** for fresh work, `claimWork` + `activeIssues.add`
  + `activeRuns++` already happen in the CLAIM loop (daemon.ts ~1219–1223) BEFORE
  the fire-and-forget dispatch (~1233). Setting/checking the gate at the dispatch
  site would let an issue get claimed (moved to `in-progress`) and counted, then
  the gate "skip" would STRAND that claim with no run/`finally` to undo it.
  Therefore the gate is **checked before `claimWork` and `add(repoKey)`'d at the
  commit point** (right after the successful claim + `activeRuns++`), per entrant:
  - **fresh-work claim loop (~1197–1226):** for each candidate compute
    `entersAtDetect = getStartPhase(selectVariant(request)) === 'detect'`; if
    `entersAtDetect && gate.has(repoKey)` → SKIP this candidate (do NOT claim it —
    it stays unclaimed for a later tick, no strand); on a committed claim, if
    `entersAtDetect`, `gate.add(repoKey)`. (Bug-fix ~1284 and feature-pipeline
    ~1344 claim+dispatch sites get the same treatment.)
  - **crash-resumption (~1567–1660):** no `claimWork` (the run is already owned in
    state) — `add(repoKey)` at `activeRuns++` (~1587) iff `run.phase === 'detect'`.
    BUT `findIncompleteRuns` is a **one-shot startup pass** (daemon.ts ~1559) — there
    is NO later tick to retry a skipped run (codex plan-review). So a gated
    crash-resume detect run must NOT be skip-and-dropped; instead **queue/defer**
    it: if `detectInFlight.has(repoKey)`, enqueue the launch and fire it when the
    gate clears (chain onto `releaseDetectGateOnce` / a per-repo FIFO), or process
    same-repo crash-resume detect runs serially. Every incomplete detect run must
    eventually launch exactly once.
- a **per-run** `releaseDetectGateOnce` closure (`let done=false; () => { if(!done){
  done=true; gate.delete(repoKey); } }`) is created at the commit point and
  carried to the dispatch (e.g. via a `Map<issueNumber, release>` or a small
  per-request struct), then threaded into `onDetectSettled` + the `.finally`
  backstop;
- it is passed as `onDetectSettled` into `createPhaseHandlers` → invoked in
  `detect`'s `finally` (EARLY release — frees the gate the moment detect finishes,
  preserving post-detect concurrency). **Order is load-bearing (codex
  plan-review): call `releaseRepoGitLock()` FIRST, THEN `onDetectSettled?.()`** —
  otherwise a FIFO-launched next crash-resume `detect` would call
  `acquireRepoGitLock()` (phases.ts:439) while the old lock is still held → false
  contention;
- AND it is invoked in a `.finally` that covers the ENTIRE per-run setup+spawn —
  not merely `runPipeline(...).finally`. This matters because the setup BEFORE
  `runPipeline` differs by path (codex round-2 #3):
  - **fresh-work:** the whole body is inside the async `processWorkRequest`, so the
    existing `processWorkRequest(...).catch(...).finally(...)` (daemon.ts ~1260)
    already covers a setup throw (an async-fn throw rejects the returned promise);
    attach `releaseDetectGateOnce` there.
  - **crash-resumption:** the setup (`activeRuns++`, `readAgencyConfig`, handler
    construction, daemon.ts ~1595–1643) runs INLINE in the `for` loop BEFORE
    `runPipeline` (~1650) exists — a throw there would escape before any
    `.finally` is attached and LEAK the gate. Correct shape (codex round-3
    CRITICAL — do NOT use an unconditional outer `finally`, which would release
    synchronously the instant the promise is created, BEFORE `detect` runs and
    settles, reopening the gate prematurely):
    ```ts
    try {
      ...inline setup...
      runPipeline(...)
        .then(...).catch(...)
        .finally(releaseDetectGateOnce);   // BACKSTOP: fires when the run settles
    } catch (setupErr) {
      releaseDetectGateOnce();             // ONLY on a synchronous setup throw
      ...handle setupErr...
    }
    ```
    The EARLY release still comes from `onDetectSettled` (detect's `finally`); the
    `runPipeline(...).finally` is the run-level backstop; the `catch` covers a
    setup throw. No outer `finally`.
- **Per-run idempotency is load-bearing:** because the gate is repo-keyed and
  ownerless, a run's late release must NOT delete a *later* run's entry. The
  `releaseDetectGateOnce` closure deletes at most once per run; once detect-settled
  has released, the run's backstop release is a no-op, and a subsequent run that
  re-`add`ed the same `repoKey` keeps its entry. (This is the bug the simple
  "clear on whole-run finally" design would introduce.)

**(D) Loud assertion + reconcile instrumentation (codex caveat).** With the gate
correct, two detects can no longer legally overlap. Keep the in-`detect`
`acquireRepoGitLock()` as a **post-gate assertion**: if ever contended (returns
`false`) the gate was bypassed — emit a loud, structured log ("detect lock
contended despite dispatch serialization — possible concurrent shared-worktree
mutation") instead of silently routing benign contention as corruption. Add
assertions/instrumentation around the checkout-mutating `reconcileWorkspace()`
call (phases.ts ~466) so a hidden concurrent mutation surfaces loudly rather than
being masked by the new serialization.

The `workspace-repair-needed` / `recreate-workspace` routing remains for GENUINE
reconcile failures (phases.ts 478–486); it is no longer reachable by mere lock
contention.

### Rejected alternatives

- **Blocking async lock-wait inside `detect`** (await the lock to free). REJECTED
  (operator): it parks promises that occupy run-capacity slots and hides
  scheduler bugs — the run has already consumed a slot by the time it reaches
  `detect`.
- **Whole-run per-repo serialization** (clear the gate on whole-run completion
  only). REJECTED: over-serializes (kills intra-repo post-detect concurrency) AND
  the ownerless repo-keyed clear would prematurely free a later run's gate entry
  (the per-run idempotent release in (C) is what makes early+backstop release
  safe).
- **Gate only the 3 fresh-work dispatch sites.** REJECTED (codex): misses the
  crash-resumption path (daemon.ts ~1567–1660) where a run resumes at
  `run.phase === 'detect'` → resumed/fresh runs still race into detect. The gate
  must cover every in-process spawn whose entry phase is `detect` (A).
- **Symptom-only: make contention a benign non-destructive failure** (re-route the
  contention branch away from `recreate-workspace`). REJECTED: treats the symptom
  — still spawns a doomed run + burns a claim/spawn cycle; the operator wants
  prevention (never enter an unexecutable detect).

### Governing specs + traceability

`STACK-AC-CONTROL-PLANE` (the dispatch gate in `daemon.ts` + detect in
`phases.ts`) and `STACK-AC-RECOVERABLE-FAILURE-ROUTING` (the failure-routing
change; already lists both files). **TRACEABILITY:** add
`packages/daemon/src/control-plane/daemon.ts` to `STACK-AC-CONTROL-PLANE`'s
`code_paths` per the operator instruction. Codex-accurate framing: `daemon.ts` is
already *covered* by the `packages/daemon/src/control-plane/` dir glob (line 523),
so this is a **redundant-but-harmless explicit listing** for governance
visibility — matching how `classifier.ts`/`classifier-schema.ts` are listed
explicitly despite the same glob. It passes the path-existence validator (file
exists). This is the ONLY traceability mutation in the batch.

---

## gap #7 — boot does not load `.env`; env validation is scattered and late

### Current state (confirmed)

`packages/daemon/src/main.ts` is the CLI/boot entrypoint (`start` action
**13–23**, calls `startDaemon(options.config)` at **18**). It does NOT load
`.env`. Required env is validated **scattered + late**, each throwing its own
error inside `startDaemon` (`daemon.ts:180`):
- `GITHUB_TOKEN` — hard-required at **daemon.ts:184–194** (step 0, BEFORE config
  load): `startDaemon` returns `err` if it is `undefined`/empty.
- `createDbClient()` at **daemon.ts:363** → reads `RUNFORGE_DATABASE_URL`
  (`packages/db/src/env.ts:18–21` throws if invalid).
- `readCredentialKey()` at **daemon.ts:365** → reads `ENCRYPTION_KEY`
  (`packages/db/src/credential-crypto.ts:19–21` throws if absent).

**Codex correction (verified):** `DAEMON_DATA_BACKEND` is **NOT required** —
`readDaemonDataBackendKind()` (`data/backend-kind.ts:11`) treats
`undefined`/empty/`'postgres'` as `'postgres'` and only throws on a *wrong*
non-postgres value. So the genuinely-required boot vars are **`GITHUB_TOKEN`,
`RUNFORGE_DATABASE_URL`, `ENCRYPTION_KEY`** (not `DAEMON_DATA_BACKEND`).

`formatStartupError` (main.ts:87) walks `.cause`, but the operator still sees ONE
missing var at a time (fix one, hit the next: GITHUB_TOKEN → DB URL → key).
`dotenv@17.3.1` is present in the pnpm store (transitive) but is NOT a direct
`@runforge/daemon` dependency.

### Chosen fix

1. **Add `dotenv` as a direct daemon dependency** (`packages/daemon/package.json`)
   and `pnpm install`.
2. **Load `.env` at boot in `main.ts` BEFORE `startDaemon`/`processSingleIssue`**
   using dotenv's **default no-override semantics** (`dotenv.config()` does NOT
   overwrite already-set `process.env` — deployment env wins; codex-flagged
   precedence requirement). Load inside the `start` (and `process`) command
   actions so importing `main.ts` in tests does not eagerly mutate env.
3. **Consolidated validation** as a pure helper in
   `packages/daemon/src/config.ts` (governed by `STACK-AC-CONVENTIONS`, tested by
   `config.test.ts`): `validateRequiredBootEnv(env): { ok: true } | { ok: false;
   missing: string[] }` collects ALL missing required vars — **`GITHUB_TOKEN`,
   `RUNFORGE_DATABASE_URL`, `ENCRYPTION_KEY`** (NOT `DAEMON_DATA_BACKEND`,
   which defaults to postgres; `workspaceRoot`/optional vars excluded) — and
   reports them in one message. `startDaemon` calls it FIRST (at step 0,
   **replacing** the existing scattered `GITHUB_TOKEN` block at daemon.ts:184–194)
   and returns a single `err` listing every missing var when any are absent —
   before `createDbClient`/`readCredentialKey` run.

Validation is presence-only; the existing readers keep their stricter format
checks (URL validity, 32-byte key decode) so we do not duplicate/drift those
rules. Folding the existing `GITHUB_TOKEN` early-return into the consolidated
check removes the scatter (the daemon currently fails on GITHUB_TOKEN first, then
DB URL, then key — one at a time). The single consolidated error covers the
common "fresh deploy missing several vars" case in one shot.

**Scope guard (codex round-2):** the 3-var consolidated gate is wired ONLY into
`startDaemon`. The `process <issue>` one-shot (`processSingleIssue` /
`process-single.ts`) keeps its own (lighter) requirements — do NOT impose the
daemon's DB/ENCRYPTION_KEY set on it. `main.ts` still loads `.env` in the
`process` action (harmless, no-override) so that command sees `.env` too.

### Rejected alternative

Put the consolidated validation in `daemon.ts` directly (new logic in a file
governed by other specs) or eagerly `import 'dotenv/config'` at module top.
Rejected: keeping the new pure logic in `config.ts` (CONVENTIONS) avoids any new
traceability need and is unit-testable without booting; per-action loading avoids
polluting test imports. The `startDaemon` call site is incidental wiring in an
already-governed file.

### Governing spec

`STACK-AC-CONVENTIONS` (DRAFT) owns `main.ts`, `config.ts`, `package.json` — all
already in `code_paths`. `daemon.ts` (the call site) is already governed
elsewhere. No traceability change. A short "Boot env loading" note will be added
to `conventions-ts.md` to keep the spec accurate (documents the new convention:
`.env` loaded no-override at boot; required vars validated once, up front).

---

## File topology

| File | gaps | change |
|---|---|---|
| `packages/daemon/src/session-runtime/adapters/cli.ts` | #3 | cost-field scan in `parseOutput()` |
| `packages/daemon/src/session-runtime/adapters/cli.test.ts` | #3 | `total_cost_usd` precedence tests |
| `packages/daemon/src/control-plane/daemon.ts` | #5, #6, #7 | cache gate; detect dispatch gate + signal; `validateRequiredBootEnv` call |
| `packages/daemon/src/control-plane/daemon.test.ts` | #5, #6, #7 | cache-skip + claim-loop dispatch-gate tests; #7 mock/env update (config.js mock + DB/KEY env) |
| `packages/daemon/src/control-plane/phases.ts` | #6 | detect-settled callback; post-gate assertion + reconcile instrumentation |
| `packages/daemon/src/control-plane/phases.test.ts` | #6 | detect serialization/assertion tests |
| `packages/daemon/src/implementation/decompose.ts` | #1 | pass `{ jsonSchema }` to both spawns |
| `packages/daemon/src/implementation/task-graph-schema.ts` | #1 | NEW Zod + JSON-schema module |
| `packages/daemon/src/implementation/task-graph-schema.test.ts` | #1 | NEW anti-drift + prompt-contract tests |
| `packages/daemon/src/implementation/decompose.test.ts` | #1 | update 4th-arg assertion |
| `prompts/coordinator.md` | #1 | (read-only contract anchor; edit only if drift test requires) |
| `packages/daemon/src/main.ts` | #7 | load `.env` (no-override) in actions |
| `packages/daemon/src/config.ts` | #7 | `validateRequiredBootEnv` helper |
| `packages/daemon/src/config.test.ts` | #7 | validation tests (all-missing aggregation) |
| `packages/daemon/package.json` | #7 | add `dotenv` dep |
| `pnpm-lock.yaml` | #7 | `pnpm install` updates the lockfile (commit it — frozen-lockfile CI) |
| `.specify/traceability.yml` | #6 | add `daemon.ts` to `STACK-AC-CONTROL-PLANE` |
| `.specify/stack/conventions-ts.md` | #7 | boot-env note (keep spec accurate) |

## Test strategy

Per-fix unit tests; run the affected spec's `test_paths`. All daemon tests run
via `pnpm --filter @runforge/daemon test` (vitest); typecheck via
`pnpm --filter @runforge/daemon typecheck`.

- **#3:** `cli.test.ts` — add: `total_cost_usd` parsed as `cost` with
  `costEstimated: false`; `total_cost_usd` wins over `cost_usd`/`cost`;
  `cost_usd`/`cost` still honored when `total_cost_usd` absent (existing tests
  stay green); a non-positive leading `total_cost_usd` (e.g. `0`; JSON cannot
  carry `NaN`, which `JSON.stringify` emits as `null`) falls through to a valid
  `cost_usd`. (#4 coverage: a parsed positive cost asserts `costEstimated:false`,
  proving budget input is real.) Specs: `STACK-AC-SESSION-PROVIDERS`,
  `STACK-AC-OPERATIONAL-SAFETY` test_paths.
- **#5:** `daemon.test.ts` — `preClassifyReadyWork` sets `preClassification` only
  for `classified: true && complexity !== undefined` items; leaves uncached:
  `classified:false` (rate-limited / empty `success:simple`) AND the
  `classified:true`-but-`complexity:undefined` fallback (classifier session
  failed → `success:simple` with no complexity). Spec: `STACK-AC-BATCH-CLASSIFIER`.
- **#1:** NEW `task-graph-schema.test.ts` — the `coordinator.md` example unit
  passes `UnitSchema`; schema key set == `Unit` keys == prompt-example keys
  (drift fails); `estimatedChangeSize` optional; emitted JSON schema is valid
  draft-07 with `additionalProperties:false`. `decompose.test.ts` — update the
  "passes variables" assertion (4th arg now `{ jsonSchema: expect.any(String) }`,
  was `undefined`); add: both spawns receive the schema. Specs:
  `STACK-AC-IMPLEMENTATION`, `STACK-AC-AGENT-DISCIPLINE-PROMPTS` test_paths.
- **#6:** `phases.test.ts` — detect invokes `onDetectSettled` in `finally` on both
  success and failure; a post-gate contended lock emits the loud instrumentation
  (not a silent `recreate-workspace`). `daemon.test.ts` — (a) a repo with detect
  in flight is not dispatched a second concurrent run; (b) the gate clears on the
  detect-settled signal, allowing the deferred run next tick; (c) **leak guard:**
  a run that throws BEFORE detect still frees the gate (via the `.finally`
  backstop); (d) **website variant bypass:** a website (start-phase `init`) run
  does NOT set/leak the gate; (e) the **crash-resumption** path is gated iff
  `run.phase === 'detect'`, and a crash-resumed run entering at a post-detect
  phase (e.g. `implement`) is NOT gated; `reenterPipeline` (parked-decision) is
  NOT a detect entrant and is not gated; (f) **queue/defer invariant:** two
  incomplete same-repo `phase:'detect'` startup runs — the second is deferred (not
  dropped) and launched EXACTLY ONCE after the first detect settles (lock released
  before `onDetectSettled`). Specs: `STACK-AC-CONTROL-PLANE`,
  `STACK-AC-RECOVERABLE-FAILURE-ROUTING` test_paths.
- **#7:** `config.test.ts` — `validateRequiredBootEnv` returns ALL missing of
  `{GITHUB_TOKEN, RUNFORGE_DATABASE_URL, ENCRYPTION_KEY}` at once; passes when
  all present; ignores `DAEMON_DATA_BACKEND` and other optional vars.
  **Existing-test impact (codex plan-review):** `daemon.test.ts` mocks
  `../config.js` to expose only `loadConfig` (line ~343) and sets only
  `GITHUB_TOKEN` (~522), with a test (~716) asserting `startDaemon` errors when
  `GITHUB_TOKEN` is missing. Wiring `validateRequiredBootEnv` into `startDaemon`
  REQUIRES: (1) the `../config.js` mock to also expose `validateRequiredBootEnv`
  (use `vi.mock('../config.js', async (importOriginal) => ({ ...(await
  importOriginal()), loadConfig: ... }))` to keep the REAL function), and (2) the
  test env setup to also set `RUNFORGE_DATABASE_URL` + `ENCRYPTION_KEY` so the
  happy-path `startDaemon` tests pass. The existing GITHUB_TOKEN-missing test then
  still passes (the consolidated error string contains `GITHUB_TOKEN`). `main.ts`
  load is a thin call; dotenv no-override is exercised indirectly. Specs:
  `STACK-AC-CONVENTIONS` (+ `daemon.test.ts` under the daemon glob).

Full regression gate before commit: `pnpm --filter @runforge/daemon typecheck`
+ `pnpm --filter @runforge/daemon test` + `pnpm --filter @runforge/daemon lint`.

## Risks (carrying codex's flags forward)

1. **Provider-contract schema (gap #1, HIGH).** A strict (`additionalProperties:
   false`) JSON schema that drifts from the coordinator's actual output would
   make `--json-schema` reject valid runs — converting an intermittent failure
   into a deterministic one. Mitigation: the schema is derived from the same
   `Unit` shape and pinned by the prompt-contract + key-set anti-drift tests;
   `estimatedChangeSize` is optional; the prompt's documented example must pass
   the schema in CI.
2. **Env precedence (gap #7, MEDIUM).** `.env` must not override
   already-set `process.env` (deployment env wins). Mitigation: dotenv default
   (no override) only — never `override: true`; loaded per-action to avoid test
   import pollution.
3. **Gap #6 concurrency-gate correctness (HIGHEST).** The gate must be
   deadlock-free and leak-free across every in-process detect entrant. Verified
   failure modes that the mechanism (above) must defeat, each with a named test:
   (a) **pre-detect leak** — a run throwing in the large pre-detect window
   (`saveRunState`/`insertRun`/token-resolution/`readAgencyConfig`/handler
   construction) must still free the gate via the `.finally` backstop;
   (b) **website leak** — website runs start at `init`, never reach detect, so
   they MUST bypass the gate (start-phase check);
   (c) **crash-resume race** — the crash-resumption path (daemon.ts ~1567–1660,
   which ignores the concurrency limit) must go through the same gate when
   `run.phase === 'detect'`, or a crash-resumed detect run still races a fresh
   one; `reenterPipeline` (~2217) is post-detect and is NOT gated;
   (d) **cross-run premature clear** — the per-run idempotent release must not let
   a finished run's late `.finally` delete a newer run's gate entry;
   (e) **process-single** runs in a SEPARATE process — the in-process gate (and
   the existing per-process `repoGitLock`) do not serialize it; unchanged/out of
   scope.
   Plus the wider-bug guard: keep the in-detect lock as a loud post-gate
   assertion + instrumentation around `reconcileWorkspace`; genuine reconcile
   failures still route to `workspace-repair-needed`. Gap #6 is the largest item
   and is NOT mechanical — it is a multi-entrant concurrency change (see Open
   Questions).
4. **Test fixture churn (gap #1, LOW).** `decompose.test.ts`'s positional 4th-arg
   assertion flips from `undefined` to the schema — must be updated or it fails.

## Open questions (parked — not blocking)

1. **Gap #6 scope (for the Operator).** Codex review showed gap #6 is materially
   larger than the other four "mechanical" fixes: it touches the fresh-work claim
   loop AND the crash-resumption path, needs entry-phase-aware gating at the
   claim/commit point, a per-run idempotent release, and a `.finally` backstop — a
   genuine multi-entrant concurrency change, not a one-file edit. The build order keeps it last and well-tested, but the Operator
   may prefer to **split gap #6 into its own PR** (the other four are independent
   and low-risk). Parked: not blocking; the batch can ship gaps #3/#5/#1/#7 even
   if #6 is deferred.
2. **`successCriteria` divergence (gap #1).** `agent-discipline-prompts-ts.md:42`
   calls for a `successCriteria` unit field that exists in neither `Unit`, the
   parser, nor `coordinator.md`. The schema mirrors the IMPLEMENTED shape only;
   resolving the L3-spec-vs-code divergence (add the field everywhere, or amend
   the spec) is a separate task. Parked.
3. **Process-wide vs cross-process detect serialization (gap #6).** The gate (and
   the pre-existing `repoGitLock`) are in-process only; `runforge process
   <issue>` running concurrently with the daemon is not serialized. Pre-existing
   condition, not introduced here — flagged for awareness.

## Traceability summary

- ADD `packages/daemon/src/control-plane/daemon.ts` to `STACK-AC-CONTROL-PLANE`
  `code_paths` (gap #6). Only mutation. File exists.
- New file `implementation/task-graph-schema.ts` is covered by
  `STACK-AC-IMPLEMENTATION`'s existing `packages/daemon/src/implementation/`
  glob — no explicit addition needed.
- No new spec IDs, no new L1/L2/L3 chains. `conventions-ts.md` gets an accuracy
  note (gap #7); no L3 spec contradicts any fix.
