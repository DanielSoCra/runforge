# Learnings — why no spec-pipeline run ever shipped (and the fixes)

**Date:** 2026-06-04
**Context:** First sustained live drive of the spec-driven pipeline (L2→L3→…) on
`DANIELSOCRAHANDLEZZ/runforge-example` through the pm-cockpit decision loop. The engine
had a long history of runs going `stuck` at $0. Driving it live surfaced three
*deterministic* engine bugs (each blocked every spec-authoring run) plus several
operational gotchas. All three code fixes are TDD'd on `feat/company-os-phase0`.

> Read this before debugging a `stuck` spec run or "No/Out-of-scope changed
> artifacts" — you are probably hitting one of these.

## The three deterministic blockers (in pipeline order)

### 1. Containment marked the whole `.specify/` tree read-only
- **Symptom:** l2-designer/l3-generator run, then `Artifact delivery failed: No
  changed artifacts`. Worker transcript shows `PreToolUse:Write hook error: Write
  blocked on read-only path: .specify/architecture/ARCH-*.md` and the worker
  honourably reporting `BLOCKED`.
- **Root cause:** `DEFAULT_POLICY.readOnlyPaths` includes `.specify/**`, but the
  l2-designer's *only* valid output is `.specify/architecture/**` and the
  l3-generator's is `.specify/stack/**` — both inside the read-only tree. The
  policy was applied uniformly (`runtime.ts` hardcoded `DEFAULT_POLICY`).
- **Fix:** `ContainmentPolicy.writableExceptions` (relaxes read-only only — never
  `blockedPaths`, so scenarios/methodology holdout stays protected) +
  `policyForAgentType()` granting each authoring role its own output dirs. Honoured
  in BOTH enforcement copies (`containment-hooks.ts` + the generated hook script).
  Commit `1ebb5ee`.

### 2. `parsePorcelainPath` ate the leading dot of modified files
- **Symptom:** `Out-of-scope artifact changes for l2-design: specify/traceability.yml`
  — note the **missing leading dot**. The untracked ARCH file passed; the modified
  `traceability.yml` failed.
- **Root cause:** `runCommand` (lib/process.ts) `.trim()`s all command output. For
  `git status --porcelain=v1`, that strips the LEADING space of an unstaged-modified
  entry (`" M <path>"`) when it is the first line → `"M <path>"`. `parsePorcelainPath`
  then did a fixed `line.slice(3)` and ate the path's first char (`.specify` →
  `specify`). Because `.specify/traceability.yml` is *modified* (not untracked) on
  every l2/l3 delivery and sorts first, this failed **every** spec delivery.
- **Fix:** parse trim-robustly — strip ≤2 status cols + the one separator space via
  `line.replace(/^.{0,2}[ \t]/, '')` instead of `slice(3)`. Correct whether or not
  the line was left-trimmed. Same fix in the second copy (`runtime-source.ts`).
  Commit on `feat/company-os-phase0` ("trim-robust porcelain parse").

### 3. l3-generator prompt never named its output path
- **Symptom:** L3 stuck with `Out-of-scope artifact changes: l3-staging/.specify/
  implementation/IMPL-NOTES-DIGEST.md, l3-staging/traceability-delta.md`.
- **Root cause:** unlike `l2-designer.md` ("Write to `.specify/architecture/ARCH-…`
  at exactly that path"), `l3-generator.md` only said "Write the L3 spec." The model
  guessed plausible-but-wrong paths. Delivery (`isAllowedArtifactPath`) accepts only
  `.specify/stack/**` + `.specify/traceability.yml`.
- **Fix:** name the path (`.specify/stack/STACK-<DOMAIN-KEY>.md`), reuse the L2
  DOMAIN-KEY, edit traceability in place, + the same critical-output-discipline block
  l2-designer carries. Commit `49644db`. Prompts are mounted into the container, so
  this needs only a daemon **recreate**, not an image rebuild.

**Meta-lesson:** every spec-authoring role's prompt MUST name its exact output path,
and that path MUST match `isAllowedArtifactPath()` in `spec-pipeline/delivery.ts`.
When adding a new authoring phase, update prompt + `isAllowedArtifactPath` +
`SPEC_AUTHORING_WRITABLE_PATHS` (containment-hooks.ts) together.

## Operational gotchas (containerized pilot)

- **Budget caps throttle to zero.** `dailyBudget`/`perRunBudget` are USD reservation
  caps even on a subscription (no real $). `perRunBudget: 2` is too small for a
  60-turn worker's reservation → every session fails `per-run-budget-exceeded`
  before starting. Use generous caps for the subscription pilot (e.g. 500/50).
- **Subscription token expires (~hours).** The container mounts a copied Keychain
  credential (`sync-claude-creds.sh`); it does NOT self-refresh (by design, to avoid
  rotating the shared refresh token). If the wall clock outlives the token, every
  worker gets `401 Invalid authentication credentials` → `No changed artifacts` →
  stuck. Re-sync before a run; install the creds-sync launchd job
  (`scripts/com.runforge.creds-sync.plist`) for sustained operation. Verify with a
  direct API call before blaming the pipeline.
- **Default model matters.** With no `roleModels`, the headless CLI uses a weak-ish
  default; the l2-designer wrote `test` to README instead of a spec. Pinning roles to
  `claude-opus-4-8` (via `roleModels: {<role>: {model: "claude-opus-4-8"}}`) both
  fixes quality AND makes failures legible (Opus reports `BLOCKED` clearly instead of
  flailing).
- **Restarting the pm-cockpit watcher needs two env vars.** The intent socket
  (`~/.agents/pm/intent-e2e.sock`) lives in the watcher process; if it dies, gate
  approvals fail with `ERR connect ENOENT …intent-e2e.sock`. Restart with
  `PM_PROTECTED_KEY=$(head -c 32 /dev/urandom | base64) PM_GH_TOKEN=$(gh auth token)
  node packages/watcher/__pilot-watcher.mjs` — it crashes on boot without
  `PM_PROTECTED_KEY` (32-byte base64; any valid key works since pilot decisions carry
  no PHI) and can't write the approve effect without `PM_GH_TOKEN`. Socket path + repos
  come from `~/.agents/pm/registry.yaml`.
- **Two daemons.** A host launchd daemon (`com.runforge.daemon`, runs from
  `.worktrees/runtime-current`) can coexist with the container daemon on :3847 — they
  may target different repos. Confirm which one owns your repo before reading
  `/api/runs` (the host one answered :3847 for me while the *container* ran the work).

## Proven live (2026-06-04)

Two clean runs (#12 NOTES-DIGEST, #17 RSS-FEED) took a goal **L0→L3 end-to-end**:
L2 design → deliver PR → park at l2-gate → cockpit approve → **auto-merge (#49)** →
l3-generate → **L3 PR merged** (`.specify/stack/STACK-RSS-FEED.md`, PR #19, after the
prompt fix) → l3-compliance → implement, where the worker **wrote real feature code**
(`test/feed/*.test.ts`, `package.json`, `tsconfig.json`). The decision loop
(emit → ingest → cockpit answer → resume) closed on a real run.

## 5th blocker — implement-phase scope (FIXED) + the full tail (PROVEN e2e)

The implement worker scaffolded a greenfield feature, then the **post-session scope
audit** failed it with `Scope violation detected: write-outside-permitted …`. Three
facets, all because `workerScope.writePaths = ['src/**','packages/**','tests/**']` was
too narrow for greenfield:
1. **`node_modules/**`** — `pnpm install` writes it (hundreds of paths). It's a
   build artifact, never a deliverable. The example repo has no `.gitignore`, so
   `git status` surfaced node_modules and the audit failed it.
2. **root config** — `package.json`, `tsconfig.json`, `pnpm-lock.yaml`: a greenfield
   feature must create these; the old scope forbade root files.
3. **`test/` vs `tests/`** — the worker wrote `test/feed/*.test.ts`; the scope allowed
   only `tests/**`.

**Fix (on `fix/implement-greenfield-scope`, TDD, 2688 tests green):**
- `workerScope` broadened to a greenfield surface: `readPaths/writePaths = ['**/*']`,
  `denyPaths = ['.specify/**']` (real containment = worktree boundary + review gate +
  `policy.blockedPaths` merged by `resolveDirectoryScope`). `scope-registry.ts`.
- `scope-audit.ts` ignores build artifacts regardless of `.gitignore`:
  `isIgnoredArtifactPath()` drops any path with a `node_modules/.git/.next/.turbo/
  coverage` segment from `collectChangedPaths`.
- `worktree.ts` `ensureBuildArtifactExcludes()` seeds the **shared** git excludes
  (`<common-git-dir>/info/exclude`) with `node_modules/`, `.pnpm-store/`, `workspaces/`,
  `dist/`, `build/`, `.next/`, `.turbo/`, `coverage/` at `createWorktree` — so the
  implement auto-commit never stages artifacts, the diff-size limit never trips on
  them, and they never linger as merge-tripping clutter.

**PROVEN live, full tail e2e (#23 FUNC-TAGS, 2026-06-04):**
`detect → l2-gate (cockpit approve) → l3-generate → l3-compliance → implement (real
code) → review (passed, 0 fix cycles) → holdout → integrate (merged feature/23 → main)
→ report → complete`. The delivered feature — `src/tags/{tag,tagIndexer,tagPage}.ts`
plus `test/tags/*.test.ts` — was independently cloned and run: **22/22 tests pass,
`tsc --noEmit` clean**. The diff was 671/757 lines (vs the pre-fix 866752 artifact
bloat), confirming the exclusion fix. This is the first time a goal went L0 → merged
feature on main autonomously.

## Known, still-open

- **Duplicate resume handler (benign, re-observed on #23).** `resumeParkedRuns()` has no
  re-entrancy guard; concurrent invocations both process the same l2-gate park — one wins
  the auto-merge, the loser hits `405 Merge already in progress` (`PUT …/pulls/24/merge`)
  and logs `Parked run #23 finished: parked`. The winner advances, so it's benign and
  self-heals, but add an in-flight guard (the "+ duplicate handler" half of the #49 work).
  Only fires at l2-gate parks. Seen again live on #23 — confirmed still present.
- **Residual implement-merge `fatal: stash failed` (transient, self-heals).** On #23's
  *first* implement attempt the unit-merge failed with `Merge failed for issue-23: git
  failed (128): fatal: stash failed`; the automatic re-implement attempt succeeded and
  the run completed. That message comes **only** from git's autostash (`die("stash
  failed")` in merge/rebase/pull), yet `merge.autoStash` is unset in repo/global/system
  config AND `runCommand`'s sanitized env (PATH/HOME/TERM/LANG/TMPDIR only) can't inject
  it — and a plain `git merge --no-ff` with a dirty untracked file reproduces clean
  (exit 0) on the same git 2.39.5. So this is a **non-deterministic transient** (likely a
  race between the worker's in-container worktree/index activity and the merge), not a
  config bug. It self-heals via the implement retry, so it's not blocking. **Proposed
  defensive fix (needs a reliable repro first):** pass `-c merge.autoStash=false` to the
  merge in `worktree.ts:mergeWorktree` (kills the only code path that can emit this
  message) and/or ensure repoRoot is clean before the unit-merge. Not done yet — TDD has
  no RED test without a repro, so it is filed rather than hacked in blind.
- **Stale clone.** The daemon only fetches origin/main when *it* merges, not before
  reconciling a workspace — externally-pushed specs are invisible until a manual
  `git -C /app/repo fetch origin main && git reset --hard origin/main`. Make the
  daemon fetch origin/main before each workspace reconcile.
- **Re-running a spec conflicts.** Re-deriving an L2/L3 for a spec whose artifact is
  already merged produces a merge-conflict PR (#14/#15). Each *new* feature has a unique
  DOMAIN-KEY → no conflict; to re-test, use a NEW FUNC-* spec (added FUNC-RSS-FEED).
- **Moot-supersede only clears UNANSWERED closed parks.** An answered park whose PR is
  closed/unmergeable becomes a zombie that re-parks every cycle and (with the 1-resume/
  cycle cap) can starve newer parks. Cleared by removing its run-state file.

## The proven recipe (goal → shipped, through the gate)

1. Bump budget caps; ensure a fresh token (`sync-claude-creds.sh` + API auth check).
2. Pin creative roles to `claude-opus-4-8` via `roleModels`.
3. Seed an issue `feature-pipeline` + `l1-approved` laddering a FUNC-* L1 spec.
4. Worker designs L2 → daemon delivers PR → parks at l2-gate (`decision-request`).
5. Approve via the watcher intent socket (`{type:"answer", decision_id, chosen_option:"approve", …}`) — the daemon auto-merges the L2 PR (#49) and advances to L3.
