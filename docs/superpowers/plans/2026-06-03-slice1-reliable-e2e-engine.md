# Slice 1 — Reliable End-to-End Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The autonomous daemon takes a fresh L1 issue all the way to a **merged PR** — L0/L1 → L2 → operator approves at the gate → L3 → review → integrate — reliably and with automated end-to-end + smoke proof.

**Architecture:** Fix the gate livelock (approval auto-merges the L2 proposal, then advances), make in-container git credentials durable, consolidate the validated-but-unmerged work, then prove the whole loop with an e2e test + a one-command smoke. Spec: `docs/superpowers/specs/2026-06-03-company-os-vision-and-roadmap-design.md` §7.

**Tech Stack:** TypeScript daemon (`packages/daemon`), Vitest, Octokit, GitHub Issues/PRs, Docker, self-hosted CI.

**Method:** every code task is `/sparring-driven-development` (failing test first, implementer ≠ tester). `/deep-review` before each merge. Tests + smoke are acceptance, not optional.

---

### Task 1: Consolidate — deep-review + merge the validated work

Four PRs are validated but unmerged; they must land (clean `main`) before the engine fixes.

**Files:** none (review/merge ops). PRs: runforge #709 (workspace clone-on-startup + token-sync), #710 (gate1 baseline), #711 (l2-designer output paths); pm-cockpit #7 (answerable inbox: colon-id 404 + inline cards + timeout).

- [ ] **Step 1:** `/deep-review` #711 (smallest, prompt-only) → address findings → merge.
- [ ] **Step 2:** `/deep-review` #709 → address → merge. Rebase #710 on the new main.
- [ ] **Step 3:** `/deep-review` #710 → address → resolve any `config.ts` conflict (workspaceRoot vs baselinePreexistingFailures are different keys) → merge.
- [ ] **Step 4:** `/deep-review` pm-cockpit #7 → merge.
- [ ] **Step 5:** Verify each repo's `main` is green in CI (`gh run list --limit 1`). Pull `main` locally; rebase `feat/company-os-phase0` onto it.

**Acceptance:** both repos green on `main`; #709/#710/#711/#7 merged; #41 closed.

---

### Task 2: Fix #49a — `l2-approved` auto-merges the L2 proposal and advances (no re-park livelock)

**Files:**
- Modify: `packages/daemon/src/control-plane/phases.ts:490-522` (the `l2-approved` branch)
- Test: `packages/daemon/src/control-plane/phases.test.ts` (l2-gate suite)

- [ ] **Step 1: Write the failing test** — drive the l2-gate handler with `l2-approved` present and the proposal PR **open (not merged)**; assert it MERGES the proposal then advances (returns `success` with `pausedAtPhase` cleared), and does NOT post the "L2 Proposal Not Merged" comment.

```ts
it('l2-approved auto-merges the open L2 proposal and advances (no re-park) — #49', async () => {
  const merge = vi.fn().mockResolvedValue({ data: { merged: true } });
  const octokit = makeOctokit({ labels: ['l2-approved'], pulls: { merge } });
  // reconcileDeliveredArtifact reports an OPEN (unmerged) proposal PR #42:
  const run = makeRun({ phase: 'l2-gate', phaseArtifacts: { 'l2-design': { pullRequestNumber: 42, pullRequestUrl: 'https://github.com/o/r/pull/42' } } });
  const handlers = createPhaseHandlers(/* …with octokit… */);
  const ev = await handlers['l2-gate'](run);
  expect(merge).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 42 }));
  expect(run.pausedAtPhase).toBeUndefined();
  expect(ev).toBe('success');
});
```

- [ ] **Step 2: Run it — verify it fails** — `pnpm --dir packages/daemon exec vitest run src/control-plane/phases.test.ts -t "auto-merges"` → FAIL (currently re-parks, never merges).
- [ ] **Step 3: Implement** — in the `if (reconciled.status !== 'merged')` block, attempt a merge of the recorded proposal PR (squash, into `config.branches.staging`); on success, fall through to advance; only re-park (with the existing comment) if the merge is genuinely impossible (e.g. conflicts), and in that case set a `delivery-repair-needed`-style note rather than a silent forever-park.

```ts
if (reconciled.status !== 'merged') {
  const prNum = run.phaseArtifacts?.['l2-design']?.pullRequestNumber;
  if (prNum !== undefined) {
    const merged = await mergeProposal(octokit, owner, repo, prNum, config.branches.staging);
    if (merged.ok) { run.pausedAtPhase = undefined; run.l2MergeBlockedNotified = undefined; return 'success'; }
  }
  run.pausedAtPhase = 'l2-gate';
  // …existing one-shot "not merged / cannot auto-merge" notify…
  return 'success';
}
```
Add `mergeProposal()` helper (`octokit.pulls.merge`, `merge_method: 'squash'`, map a 405/409 to `{ ok:false, reason }`).

- [ ] **Step 4: Run tests — verify pass** (+ the existing l2-gate tests still pass).
- [ ] **Step 5: Commit** `fix(l2-gate): auto-merge approved L2 proposal then advance — kills the re-park livelock (#49)`.

---

### Task 3: Fix #49b — dedupe parked-run resume (no double `resuming #N`)

**Files:**
- Modify: `packages/daemon/src/control-plane/daemon.ts:1455` (`resumeParkedRuns`)
- Test: `packages/daemon/src/control-plane/daemon.test.ts`

- [ ] **Step 1: Failing test** — fire `resumeParkedRuns()` twice concurrently for the same parked run; assert the resume body runs once (an in-flight `Set<issueNumber>` guard).

```ts
it('resumeParkedRuns processes a run once under concurrent ticks (#49)', async () => {
  /* seed one parked run with l2-approved; spy on the re-enter call */
  await Promise.all([resumeParkedRuns(), resumeParkedRuns()]);
  expect(reenterSpy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run — verify fails** (currently can double-process).
- [ ] **Step 3: Implement** — wrap per-issue resume in an `inFlightResumes = new Set<number>()` guard: skip if present, `add` before, `delete` in `finally`.
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit** `fix(daemon): guard resumeParkedRuns against concurrent double-resume (#49)`.

---

### Task 4: Make in-container git credentials durable (gap-8 / #43)

P7 set up the credential store only on the clone path; on `force-recreate` the clone persists (volume) but `$HOME` doesn't → push fails. Move credential setup to run every boot in container mode.

**Files:**
- Modify: `packages/daemon/src/control-plane/workspace-bootstrap.ts` (`ensureWorkspaceRepo`)
- Test: `packages/daemon/src/control-plane/workspace-bootstrap.test.ts`

- [ ] **Step 1: Failing test** — `config.workspaceRoot` set + repoRoot already a git repo (reuse path) → assert `ensureGitCredentials` still wrote `.git-credentials` + `credential.helper store` (not skipped).
- [ ] **Step 2: Run — fails** (today credentials only set when cloning).
- [ ] **Step 3: Implement** — extract `ensureGitCredentials(config, deps)`; call it whenever `config.workspaceRoot !== undefined`, before the is-git-repo branch; keep token out of repo config (store helper). Native (no workspaceRoot) untouched.
- [ ] **Step 4: Run — pass** (+ the 6 existing bootstrap tests).
- [ ] **Step 5: Commit** `fix(daemon): set up git credentials on every container boot, not just clone (#43)`. Close #43.

---

### Task 5: E2E — a real feature reaches a merged PR autonomously

**Files:**
- Create: `packages/daemon/test/e2e/full-pipeline.e2e.test.ts` (gated behind `RUN_E2E=1`; uses a throwaway repo)

- [ ] **Step 1:** Write an e2e that: seeds a fresh issue (`feature-pipeline,l1-approved` + a tiny L1 in the scaffolded `runforge-example`), starts the daemon (Docker, the rebuilt image with Tasks 2–4), approves the l2-gate via the intent path, and **polls until a PR is merged** (`gh pr list --state merged`) or fails after a bounded timeout. Assert final issue labels include `complete`/closed.
- [ ] **Step 2:** Run locally with `RUN_E2E=1` → expect PASS (the loop completes L0→L3→merged).
- [ ] **Step 3:** Wire it into CI as a nightly/manual job (not the fast gate).
- [ ] **Step 4: Commit** `test(e2e): autonomous run reaches a merged PR end-to-end`.

---

### Task 6: Smoke — one command proves the loop is alive

**Files:**
- Create: `packages/daemon/scripts/smoke-engine.sh`; add `"smoke:engine"` to `packages/daemon/package.json`.

- [ ] **Step 1:** Script: bring up the Docker daemon (P7 image) against `runforge-example`; assert `/health` = healthy and the boot log shows the workspace line; create a throwaway issue; wait for it to reach `l2-gate` (decision emitted) within N min; print PASS/FAIL; tear down.
- [ ] **Step 2:** Run `pnpm --dir packages/daemon smoke:engine` → PASS.
- [ ] **Step 3: Commit** `chore(smoke): one-command engine smoke (boot → run → l2-gate)`. Document it in `docs/running-the-daemon-in-docker.md`.

---

### Task 7: Re-run the live pilot end-to-end + close out

- [ ] **Step 1:** Rebuild the daemon image (Tasks 2–4). Run a fresh issue on `runforge-example`; approve the l2-gate from the cockpit (the answerable inbox from #7); watch it advance L2-merge → L3 → review → merged.
- [ ] **Step 2:** Confirm via `gh` the PR merged + issue closed. Capture the cockpit screenshots.
- [ ] **Step 3:** Close #49, #43, #41. Update the spec §7 acceptance as met.
- [ ] **Step 4: Commit/PR** the Slice-1 branch → `/deep-review` → merge to `main`.

---

## Self-review
- **Spec coverage (§7):** consolidate (T1), fix #49 (T2+T3), gap-8 (T4), e2e (T5), smoke (T6), live proof (T7). ✓
- **Placeholders:** none — each code task names file+test+approach; bug-fix tasks reproduce-then-fix (exact fix code shown for T2/T3/T4).
- **Type consistency:** `mergeProposal`/`ensureGitCredentials`/`inFlightResumes` introduced once, used consistently.
- **Out of scope (later slices):** the goal primitive (Slice 2), cockpit v2 real build (Slice 3), multiplayer (Slice 4), acme wiring + side-project reconcile (Slice 5).
