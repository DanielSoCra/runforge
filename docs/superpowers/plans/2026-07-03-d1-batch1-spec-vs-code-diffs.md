# D1 batch 1 — spec-vs-code diff package (ratify-after-diff)

Prepared for the Operator's ratify-after-diff review of the first 4 L1 (`FUNC-AC-*`) specs. All four
were `status: draft` in `.specify/traceability.yml` at the time of review. This package exists so
ratification is a verification act, not a leap of trust — every requirement row below was checked
against the then-current `main` snapshot `d17a976` (worktree `p1-build`), not inferred from file
names or spec prose. Treat it as a historical snapshot unless the rows are refreshed against a
newer `main`. This is the #774 "spec claims more than code delivers" check, applied per-spec.

Read-only exercise. Nothing in `.specify/` or the codebase was modified to produce this package.

**How to read a table row:** `Verdict` is MATCH (code visibly implements the claim, real call
chain traced), PARTIAL (implemented but with a real deviation, missing sub-condition, or not
fully wired into the live path), or GAP (no code implements it, it's dead/unwired code, or it
contradicts the spec). PARTIAL and GAP rows both get expanded in the "Gaps and partials" detail
section immediately below each table — that's the part worth reading closely before ratifying.

---

## FUNC-AC-PIPELINE — Autonomous Pipeline Orchestration

Spec: `.specify/functional/pipeline-orchestration.md` | status: draft | version: 2

| Requirement | Live-code evidence | Verdict |
|---|---|---|
| Work request detection & claiming | `daemon.ts:1604-1655` polls `detector.detectReadyWork()` (`work-detection.ts:27` — GitHub `labels:'ready'`), then `detector.claimWork()` before dispatch; `activeIssues`/`activeRuns` mark it underway | MATCH |
| Complexity classification (simple/standard/complex) | `classifier-schema.ts:18` enum `simple\|standard\|complex`; `classifier.ts:36` `classify()` spawns a session, parsed via zod; wired into `phases.ts:1214`, also batch-precomputed via `daemon.ts:3600` `preClassifyReadyWork` → `batch-classifier.ts` | MATCH |
| Complexity-based routing (simple fewer rounds / standard default / complex extra rounds) | Review-gate count differs by complexity (`validation/gates.ts:144` `selectGates()`), but the "full decomposition" claim is dead: `variants.ts:14-22` never selects the `'feature'` variant that has a real decompose transition — every non-bug/non-website/non-spec-driven request gets `'feature-simple'`, whose `decompose` handler (`phases.ts:1205-1210`) is a no-op | PARTIAL |
| Bug routing | `variants.ts:17,20` routes bug label/type → `'bug'` variant; `fsm.ts:51-59` `bugTransitions` skips classify/decompose/holdout | MATCH |
| Configurable workflow variants (Operator-defined) | `workflow-registry.ts`/`dag-executor.ts` form a complete, tested DAG-interpreter scaffold with **zero non-test callers**; `pipeline.ts:135` only reads a fixed builtin for run-state mirroring, not execution; no config surface exposes Operator-defined variants at all | GAP |
| Crash resumption & single-instance enforcement | Resumption via `state.ts:36` `findIncompleteRuns()` + `daemon.ts:2348-2357` `launchResumeRun`; single-instance via `server.ts:560-577` exclusive port listen + `EADDRINUSE` abort | MATCH |
| Completion / delivery / verification | `phases.ts:2409` `report` handler closes+labels issue, notifies; `phases.ts:2332` `deploy` runs pre-production deploy; `phases.ts:2367` `test` runs post-deploy tests | MATCH |
| State transitions incl. re-entry (stuck / needs-spec-update) | `phase-labels.ts` mirrors visible phase labels; `phases.ts:1349-1365` applies `needs-human`/`needs-spec-update`/`stuck`/`blocked`; `operator-retry.ts:197` resets stuck issues from scratch | MATCH |
| Operator controls: status / pause / resume | `daemon.ts:1933` `getStatus()` returns counts/cost/uptime but **not per-issue current phase** in that payload (phase data exists but is surfaced via a separate DB/dashboard path); `pause()`/`resume()` (`daemon.ts:2001,2064`) are real and correctly gate new-work claiming while letting active work finish | PARTIAL |
| Operator retry of a stuck request | `operator-retry.ts:197-330` is real and reachable via `POST /retry/:issue`, but scoped to `config.repo` (the legacy "seed repo") only — no path for repos onboarded dynamically via `RepoManager`/DB multi-repo mode | PARTIAL |
| Operator notification | `notify()` fires on completion, stuck, auto-pause (budget/consecutive-stuck), and rate-limit/containment transitions via `fsm.ts:105-111` | MATCH |
| Production release (prepare + wait for approval) | `release.ts:38` aggregates notes + opens a staging→production PR for Operator approval — real logic — but `daemon.ts:2138` gates the whole `/release` handler on `config.repo` being set; in DB-backed multi-repo mode (no seed repo) the endpoint is `undefined` (HTTP 501) | PARTIAL |

### Gaps and partials (detail)

**Complexity-based routing — "full decomposition" is dead code.** The classifier and variant selector never invoke the pipeline shape (`'feature'` variant with a real `decompose` transition) that Standard/Complex routing promises. Only the review-gate-count differentiation is real; decomposition itself is a no-op regardless of classification.

**Configurable workflow variants — unwired scaffolding.** A complete DAG-interpreter (`dag-executor.ts`, `workflow-registry.ts`) exists and is unit-tested but has zero production callers and no config surface. This scenario describes a feature that doesn't exist end-to-end yet.

**Operator status omits per-issue phase**, and **retry/release are seed-repo-scoped** — both real but narrower in reach than the spec's prose implies; for fleets running multiple repos without a legacy seed repo configured, Operator retry and production release are simply unavailable.

**Verdict: RATIFY-WITH-NOTED-GAPS**
Core lifecycle (detection → classify → gate-scaling → bug-routing → delivery → completion → crash-resume → single-instance → notification) is solidly wired end-to-end with real traced call chains. The gaps are scoped, not catastrophic: one wholly aspirational scenario (configurable workflow variants), one dead decomposition path, and three Operator-surface scenarios (status, retry, release) that work but only for the legacy single-repo configuration.

---

## FUNC-AC-QUALITY — Quality Assurance and Validation

Spec: `.specify/functional/quality-assurance.md` | status: draft | version: 4

| Requirement | Live-code evidence | Verdict |
|---|---|---|
| Review-gate sequence & fix cycle (gate1→gate4, re-run from cycle start) | `gates.ts:144-163` `selectGates`; `review.ts:20-99` `runReview` loops gates and re-runs the full chain on fix; wired at `phases.ts:1630-1694` | MATCH |
| Simple/high-risk routing (complexity → gate depth, risk forces gate4) | `gates.ts:144-163` + `risk-detection.ts:16-35` `isRiskSensitive`, called at `phases.ts:1549,1680` | MATCH |
| Static analysis hard gate (complexity/length/size thresholds, strict typing) | `config.ts:289-299` declares `staticAnalysis` thresholds but **nothing reads them** outside config.ts/tests; gate1 (`gates.ts:78-142`) only shells out to configured commands (vitest/tsc/eslint) — no dedicated threshold enforcement exists | GAP |
| Architecture fitness functions (circular deps, boundaries, layering) | `fitness/*.sh` scripts are correct and shipped in the Docker image, but **zero references anywhere in `packages/daemon/src`**, not in default gate1 commands or CI — never invoked | GAP |
| Structured rubric & reviewer independence | `reviewer-session.ts:13-31,91-258` spawns a fresh session per gate with only diff/specs/rubric injected, never the implementer's transcript | MATCH |
| Holdout validation + Type A/B/C failure routing | `holdout.ts:17-55` wired at `phases.ts:1791`; failure routes through `diagnose()`/`routeDiagnosis()` (`phases.ts:1808-1930`) to fix-cycle/needs-spec-update/needs-human | MATCH |
| Holdout scenario management (external storage, structural isolation) | Holdout command externally configured (`config.ts:282-288`); structural inaccessibility enforced via `containment-hooks.ts:251` `blockedPaths` including `.specify/scenarios/**`, correctly deferred to FUNC-AC-SAFETY as the spec itself cross-references | MATCH |
| Pre-production verification & deploy | `deploy.ts` polls health with `AbortSignal.timeout` + SSRF-hardened checks (`deploy.ts:200-214`), wired at `phases.ts:2345` | MATCH |
| Post-deployment test + fix loop | `post-deploy-test.ts:50-103` called at `phases.ts:2379-2383` **without a `fixHandler`**, so its internal bounded retry never executes; unlike `phase:'review'`/`phase:'holdout'`, no code compares accumulated test-phase fix attempts against `maxTestFixAttempts` | PARTIAL |
| Test output truncation | `truncateFailureOutput` (`post-deploy-test.ts:28-48`) windows around FAIL/Error, config-driven line count | MATCH |
| Diminishing returns & graduated escalation | `review.ts:63-82` diminishing-returns logic is fully implemented and unit-tested but its **only production call site never passes the option** (`phases.ts:1692-1694`); `maxFixCycles` graduated escalation is genuinely wired (`phases.ts:1753`) | PARTIAL |
| Trust-calibration signal production (sampling, warmup, minimum floor, withdrawal) | `sampling.ts`/`warmup.ts` have **zero callers anywhere** outside their own files/tests. The live autonomy track record the lane engine actually consumes (`LaneTrackRecord` in `lane-engine/earn-in.ts:10-27`) is a separate, unrelated mechanism not fed by this code at all | GAP |
| Trust-calibration deferral to MERGE-DECISION/VERIFIER-GATE (QA feeds, never grants autonomy) | Gate/holdout results correctly flow into `decideMerge` (`phases.ts:2152`); verifier-gate's fail-closed "must demonstrably fail" check lives in `lane-engine/verifier-gate/evaluate.ts:10-30` — QUALITY's own code never grants autonomy itself | MATCH |
| Review modes (assigned QA vs proactive + work-detection boundary + auto-fix-approved bypass) | Assigned QA and the work-detection boundary/bypass (`work-detection.ts:275-387`) are genuinely live, but the two files this spec's own traceability names for proactive review (`validation/proactive-reviewer.ts`, `proactive-scheduler.ts`) have **zero callers** — the real live scheduler is a different, untraced module (`coordination/review-scheduler.ts`) | PARTIAL |
| Traceability: ARCH-AC-ADVERSARIAL-REVIEWER | No `code_paths` anywhere under this L2 node or any descendant. The "independent review/structured rubric" behavior it names is fully realized by `STACK-AC-AGENT-DISCIPLINE-REVIEW`, parented under a **different, sibling** L2 (`ARCH-AC-AGENT-DISCIPLINE`) — a genuine dangling traceability node | GAP (traceability) |

### Gaps and partials (detail)

**Static analysis thresholds and architecture fitness functions are both unenforced (2 GAPs).** The config schema and the fitness scripts exist and are individually correct, but nothing in the codebase actually invokes either — complexity/length/size limits are enforced only incidentally by whatever the target repo's own lint config happens to check, and structural drift (circular deps, boundary violations) is caught by nothing automatically today.

**Trust-calibration sampling/warmup is dead code, and it's not merely "deferred outward" — it's orphaned.** The spec's periodic-sampling, sampling-floor, and correction-withdrawal scenarios describe a subsystem (`sampling.ts`, `warmup.ts`) with no production callers. The actual autonomy signal the lane engine consumes (`cleanMerges`/`bounceFreeDays` in `earn-in.ts`) is a completely different, untraced mechanism. This is the most consequential gap in this spec: the described trust-calibration machinery and the real one are two different pieces of code.

**Post-deploy fix loop and diminishing-returns are both implemented-but-unwired (2 PARTIALs)** at their one production call site each — real logic, real tests, but the option/handler that would activate them in production is never passed.

**Proactive review traced files are dead**, though the behavior itself is real — it just lives in an untraced module (`coordination/review-scheduler.ts`), meaning traceability.yml points at the wrong files for this scenario.

**ARCH-AC-ADVERSARIAL-REVIEWER is a genuine dangling L2 node** — no code_paths, and the behavior it names lives entirely under a sibling L2 outside this spec's own child tree.

**Verdict: RATIFY-WITH-NOTED-GAPS**
The core review pipeline (gates, holdout+diagnosis routing, deploy/post-deploy, knowledge injection, work-detection boundary, safety-deferred trust calibration) is genuinely wired end-to-end and matches the spec closely. The gaps cluster in enumerable, well-isolated areas — static analysis enforcement, architecture fitness, diminishing-returns wiring, and the entire sampling/warmup subsystem — that are worth fixing but don't undermine the spec's overall shape.

---

## FUNC-AC-SAFETY — Operational Safety and Containment

Spec: `.specify/functional/operational-safety.md` | status: draft | version: 1

| Requirement | Live-code evidence | Verdict |
|---|---|---|
| Daily budget + per-task cap as two independent hard breakers | `cost.ts:57-89` `checkBudget` returns both exceed reasons; `daemon.ts:1441-1454` pauses + notifies on daily-budget outcome | MATCH |
| Approaching-limit decision (continue/defer/extend) + threshold floor + bounded one-time extension + never overrides hard breaker | No match anywhere for approaching-limit/extension logic. `cost.ts`/`deployment-budget.ts` are both purely binary proceed/no-proceed — no threshold config, no decision surface, no extension mechanism, no risk/compliance/production-release gating | GAP |
| Configurable execution substrate (direct API vs subscription-CLI) | `adapters/index.ts:11-20` — `createAdapter('sdk')` and `adapterClass === 'programmatic-api'` both literally `throw new Error("...not yet implemented")`. Only the subscription/CLI path exists | GAP |
| Subscription-aware concurrency, session resume, cost-tier routing | `window-scheduler/headroom.ts`,`filter-rank.ts` implement real rolling-usage headroom ranking; `resume-state.ts:66` prefers resume | MATCH |
| Budget reset (24h window) | `cost.ts:179-193` `maybeResetDaily`/`resetDaily` | MATCH |
| Environment isolation + protected workspace exclusions | `containment-hooks.ts:249-256` blocks holdout/methodology/operational-state/own-implementation paths; "restricted external network access" is only a Bash-command substring blocklist (`curl`/`wget`/etc.), not OS/network-level isolation | PARTIAL |
| Access blocking with explicit denial + read-vs-write scrutiny | `generate-containment-script.ts:186-254` PreToolUse hook exits 2 with an explicit reason; `readOnlyPaths` enforced only for write tools | MATCH |
| Specification integrity + behavioral-constraint prohibitions in instructions | `.specify/**` write-blocked structurally; `FACTORY_RULES.md:6-11` states prohibitions, loaded into every prompt — "own implementation" prohibition is structurally enforced but not stated as explicit prose | MATCH (structural guarantee holds; textual coverage incomplete) |
| Operation content inspection / exfiltration blocking | `containment-hooks.ts:257-280` blocks curl/wget/nc/ssh/scp/git/interpreters, plus variable-indirection and subshell-evasion detection | MATCH |
| Large response offloading | `offload.ts:12-34` `maybeOffload` is implemented but imported **only by its own test file** — no production caller | GAP (dead code) |
| Within-session repetition detection | `repetition.ts:9-34` `createRepetitionDetector` implemented but imported **only by its own test file** — no production caller | GAP (dead code) |
| Post-task audit | `audit.ts:33-60` wired at `runtime.ts:631-648`, but prohibited-resource path-reference scanning was explicitly **removed** (false positives); only blocked-command evidence (advisory, not escalated) and credential-leak (fatal, escalated) remain | PARTIAL |
| Task timeout | `adapters/cli.ts:429-437` real SIGTERM→SIGKILL(5s grace) on configured timeout | MATCH |
| Concurrency limit enforcement | `daemon.ts:1560,1615,1714,1797` gate against configured concurrency limit before claiming new work | MATCH |
| Auto-pause after consecutive stuck failures | `daemon.ts:1456-1502` tracks `consecutiveStuckCount` vs threshold, pauses + notifies | MATCH |
| Rate limit detection + escalating backoff + automatic resume | `rate-limiter.ts:24-85` doubling backoff capped at max, auto-clears on expiry; wired via `runtime.ts:525,687` | MATCH |
| Safe state persistence + mid-phase recovery + circular-fix detection (3+) | `json-store.ts:6-17` atomic write-temp-then-rename; `pipeline.ts` saves run state at ~12 transition points; `error-hash.ts:24-40` circular-error detection at threshold 3, wired at `pipeline.ts:417-419` | MATCH |
| Graceful shutdown + orphaned work cleanup | `daemon.ts:3445-3448` SIGTERM/SIGINT drain mode; `daemon.ts:715-720` `markInProgressRunsStuck()` on boot | MATCH |
| Transient operational-data-dependency outage tolerance + observability + repeated-degradation escalation | `startup-retry.ts:41-85` bounded retry; `degraded-server.ts:25-88` real degraded HTTP responses; `daemon.ts:3516-3567` notify-once escalation — real and genuinely wired, but the category taxonomy (`config-reader.ts:20-23,190-205`) only distinguishes `unreachable`/`rejected`, not the spec's 3rd named example ("mismatched stored shape") as its own category | PARTIAL |
| Startup credential resolution (all-or-nothing) | `config.ts:639-648` `validateRequiredBootEnv`, called first in `daemon.ts:277-280`, refuses to start if any required credential is missing | MATCH |
| Atomic credential reload | No reload mechanism found anywhere — no SIGHUP handler, no credential-snapshot swap code | GAP |
| Credential isolation from intelligent actors | `GITHUB_TOKEN` never appears in `session-runtime/`; `adapters/cli.ts:115-138` excludes it from the spawned-session env; containment blocks raw `git`/`curl`/`wget` inside the session | MATCH |

### Gaps and partials (detail)

**Approaching-limit decision / bounded extension is the most severe gap in the whole package.** This is the spec's most mechanism-heavy, specific scenario cluster (threshold floor, three-way decision, verification+risk+compliance-gated one-time extension) — and zero code implements any of it. `cost.ts`/`deployment-budget.ts` remain simple binary breakers. This is exactly the "not-yet-built capability described as if it exists" pattern the review was designed to catch.

**Configurable execution substrate is also fully aspirational** — the "direct programmatic control" adapter path throws `"not yet implemented"` at the point of use; only the subscription/CLI path is real, despite the spec presenting both as already-supported, symmetric options.

**Large response offloading and within-session repetition detection are both dead code** — correctly implemented and unit-tested in isolation, but neither has any production caller; no PostToolUse hook exists in the codebase to invoke them.

**Post-task audit** only escalates on credential leaks now; prohibited-resource path scanning was deliberately removed for false positives, narrowing "violations trigger immediate escalation" to a subset of what the spec describes.

**Environment isolation**'s network restriction is a command-substring blocklist, not infrastructure-level isolation — any non-blocklisted network-capable binary bypasses it.

**Atomic credential reload has no implementation at all.**

**Verdict: RATIFY-WITH-NOTED-GAPS**
This is not a hollow spec — the guarantees that matter most day-to-day (hard daily/per-task budget breakers that actually pause+notify, containment path/command blocking, credential isolation from autonomous sessions, circular-fix detection, graceful shutdown, and the recently-built degraded-startup tolerance) are genuinely wired end-to-end. But the approaching-limit/bounded-extension subsystem and the "direct programmatic control" execution substrate are pure aspiration with zero code, and two containment mechanisms (response offloading, repetition detection) are dead code never wired into the live tool-call path. These should be visible to the Operator before draft→approved, not discovered later.

---

## FUNC-AC-OPERATOR-AUTH — Operator Identity and Authorization Ownership

Spec: `.specify/functional/operator-auth.md` | status: draft | version: 1

**Central question — is auth now project-owned?** Yes. Better Auth (`packages/auth/`,
`packages/dashboard/lib/auth/better-auth.ts`) owns identity/session in project-controlled
Postgres tables (`authUsers`, `authSessions`, `authAccounts`, `authVerifications` —
`packages/db/src/schema.ts:104-186`), and role authorization is decided in application code
(`roleAllows`, `packages/auth/src/roles.ts:11-17`) against a project-owned `teamMembers` table —
not database RLS. GitHub OAuth is used only as a login credential provider to Better Auth, not as
the identity/authorization owner. No live Supabase dependency remains: the only repo-wide hits
are negative-assertion tests that explicitly reject Supabase config/backend values.

| Requirement | Live-code evidence | Verdict |
|---|---|---|
| Operator signs in → role-scoped views | `app/(dashboard)/layout.tsx:13-26` gates all dashboard pages via `requireDashboardUser()`; `team/page.tsx:13`, `settings/page.tsx:12` conditionally render admin controls via `isDashboardAdmin()` | MATCH |
| Administrator's privileged change accepted | `actions/repos.ts`, `settings.ts`, `api-keys.ts`, `github-connections.ts`, `team.ts` all call `requireDashboardAdmin()` first, then mutate | MATCH |
| Viewer's privileged change refused, nothing changes | `require-session.ts:157-160` — `roleAllows(role,'admin')` throws a 403 before any DB call in every action file above; unit test confirms the refusal | MATCH |
| Unauthenticated access refused (views + changes) | `require-session.ts:130-132` throws 401 with no session; API routes and the dashboard layout both refuse cleanly on that throw | MATCH |
| Named local-only convenience mode, explicit local declaration | `packages/auth/src/local-bypass.ts:27-47` requires `LOCAL_AUTH_BYPASS=true`; the legacy `AUTH_DISABLED` switch is explicitly *ignored* (`reason: 'legacy-auth-disabled-ignored'`) — confirming the old all-or-nothing bypass was retired, not kept as a second path | MATCH |
| Convenience mode refused if any production indicator | `local-bypass.ts:49-65` `findProductionIndicator` checks 9 env signals (NODE_ENV, VERCEL_ENV, RAILWAY_ENVIRONMENT, FLY_APP_NAME, K_SERVICE, etc.), test-covered | MATCH |
| Existing operators keep equivalent access, documented continuity | `better-auth.ts:157-201` `reconcileOperatorAccess` preserves first-admin/invite semantics going forward, but there is no concrete "prior operator → new role" migration artifact or continuity doc — and the old Supabase-Auth setup never modeled its own users/roles table to migrate *from* | PARTIAL |
| First operator gets admin automatically; later operators only by invitation under admin control | `better-auth.ts:184-199` — `membershipCount === 0` grants admin; otherwise requires a matching pending, non-expired invitation row, and `createInvitation` itself requires `requireDashboardAdmin()` | MATCH |

### Gaps and partials (detail)

**Existing-operator continuity (PARTIAL, the only non-MATCH row).** The code delivers functional equivalence going forward (same admin/viewer meaning, same first-admin/invite mechanism), but there's no concrete migration artifact mapping prior operators to new roles, and no changelog documenting who kept what access. This is plausibly because the app never modeled its own users/roles table under Supabase-Auth (identity lived entirely inside Supabase's managed schema) and no governed production deployment has happened yet (per prior findings: "deployment #0 ungoverned") — so there may be nothing concrete to migrate yet. Treat this as **not yet exercised against real prior operators**, not as disproven, but it does not meet the Success Criteria's "documented, verified equivalent access" bar as written.

### Traceability note

`STACK-AC-OPERATOR-AUTH.code_paths` lists `packages/dashboard/app/(auth)/**`, which does not
exist on disk. The real sign-in/route surface lives at `packages/dashboard/app/login/page.tsx`,
`packages/dashboard/app/auth/login/route.ts`, and `packages/dashboard/app/api/auth/[...all]/route.ts`
— none of which are listed under this node (the first two are only listed under the separate
`STACK-AC-DASHBOARD` node). This is a documentation/traceability gap, not a code gap — the code
exists and is correctly reachable, just mis-indexed in `traceability.yml`.

**Verdict: RATIFY-WITH-NOTED-GAPS**
The core migration claim is true and well-verified end-to-end — Supabase/RLS is genuinely
retired, Better Auth + app-layer `roleAllows` genuinely enforces every privileged action
pre-mutation, and local-bypass is genuinely production-gated. 7 of 8 scenarios are solid MATCHes
with unit-test coverage of the exact refusal paths. Only the "existing operators keep access"
continuity scenario is unproven, and traceability.yml has one path-list error — neither is a
blocking correctness or security gap.

---

## Summary

| Spec | Verdict | Rows | MATCH | PARTIAL | GAP | Non-MATCH count |
|---|---|---|---|---|---|---|
| FUNC-AC-PIPELINE | RATIFY-WITH-NOTED-GAPS | 12 | 7 | 4 | 1 | 5 |
| FUNC-AC-QUALITY | RATIFY-WITH-NOTED-GAPS | 15 | 8 | 3 | 4 (incl. 1 traceability-only) | 7 |
| FUNC-AC-SAFETY | RATIFY-WITH-NOTED-GAPS | 22 | 14 | 3 | 5 | 8 |
| FUNC-AC-OPERATOR-AUTH | RATIFY-WITH-NOTED-GAPS | 8 | 7 | 1 | 0 | 1 |
| **Total** | | **57** | **36** | **11** | **10** | **21** |

All four specs land at the same verdict: **ratify-with-noted-gaps** — none is a false-green
READY-TO-RATIFY, and none has a gap severe enough to warrant NEEDS-FIX-FIRST (no safety-critical
guarantee is actually broken; the hard budget breaker, containment blocking, and credential
isolation all genuinely hold). The gaps are real, scoped, and worth fixing, but they don't
invalidate ratifying the specs as accurate descriptions of intended behavior with known
implementation debt.

### The 3 most important gaps

1. **FUNC-AC-SAFETY — Approaching-limit budget decision is entirely unimplemented.** The spec's
   most mechanism-heavy scenario cluster (threshold floor, three-way continue/defer/extend
   decision, bounded one-time extension gated by verification+risk+compliance) has zero code.
   Only a binary hard-stop breaker exists (`cost.ts`, `deployment-budget.ts`). This is the
   textbook "spec describes a not-yet-built capability as if it exists" case.

2. **FUNC-AC-QUALITY — The trust-calibration sampling/warmup subsystem is dead code, disconnected
   from the real autonomy signal.** `sampling.ts`/`warmup.ts` have no production callers; the
   autonomy track record the lane engine actually consumes (`earn-in.ts`'s `cleanMerges`/
   `bounceFreeDays`) is a separate, untraced mechanism. The spec's periodic-sampling and
   corrections-withdraw-autonomy scenarios describe a subsystem that isn't reachable from any
   live pipeline path.

3. **FUNC-AC-SAFETY — Configurable execution substrate is half-real.** The "direct programmatic
   control" (API-billing) adapter path throws `"not yet implemented"` at the point of use; only
   the subscription/CLI path is live, despite the spec presenting both as already-supported,
   symmetric options.

Honorable mentions: FUNC-AC-QUALITY's static-analysis thresholds and architecture-fitness
functions are both fully unenforced (config/scripts exist, nothing invokes them); FUNC-AC-SAFETY's
large-response-offloading and within-session-repetition-detection are both correctly implemented
but never wired into a production hook path; FUNC-AC-PIPELINE's configurable workflow variants are
unwired scaffolding.
