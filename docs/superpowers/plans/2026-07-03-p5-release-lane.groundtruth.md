# P5 release-lane — verified ground truth (2026-07-03 @ origin/main 0f729f0)

Recon vs approved L1 `.specify/functional/release.md` (FUNC-AC-RELEASE v2). Every claim file:line-verified.

## Substrate map (REAL / PARTIAL / ABSENT)

1. **`scripts/release.sh` — REAL but daemon-only.** Releases from `main`, tags `release-<sha>`, restarts `com.autoclaude.daemon` via `launchctl kickstart -k` (release.sh:10,37-39,62-63). Dry-run default; `--confirm` = Operator approval (:12-19,46-49). Fail-closed preflight (on-main/clean/HEAD==origin/main :24-33) + fail-safe rollback to prior release-* tag on failed restart (:63-71). ZERO deployment param, never reads `productionReleasePath`, no ledger. **REAL for the platform's own single deployment; ABSENT as a generalizable per-deployment mechanism.** Good REFERENCE for exactly ONE of the three shapes (platform-performs-promotion).

2. **`DeploymentProfile.landing` — landsOn/requiredChecks REAL; `productionReleasePath` validated-but-INERT.** types.ts:63-73, schema.ts:95-105. `landsOn` consumed (landing-target.ts, pr-delivery.ts, integrate). `requiredChecks` consumed (awaitRequiredChecks). **`productionReleasePath` = `z.string().min(1)` (schema.ts:98) — free string, ZERO non-test readers, NOT the 3 shapes, not in the `DeclaredDatum` per-field union (types.ts:230-243 exposes `landing` whole).** Must be upgraded to a discriminated 3-shape declaration AND actually consumed.

3. **Release proposal PARTIAL / ledger ABSENT.** `control-plane/release.ts` (`aggregateReleaseNotes` + `createReleaseProposal`) is a SINGLE-platform-repo staging→production PR opener (release.ts:77-124), wired daemon.ts:2123-2133, `POST /release` (server.ts:205-215), dashboard "Approve production release" button. Mismatches vs L1v2: (a) "since last release" NOT computed — caller never passes `since` (release.ts:85), aggregates ALL-time `complete` records; (b) single-trunk model ⇒ `createReleaseProposal` returns `single-trunk-not-applicable` and does nothing (release.ts:96-104) → effectively inert; (c) NO ledger persistence, NO released-SHA marker (greps empty). **Proposal = vestigial; ledger = net-new.**

4. **Production-release Operator decision — PARTIAL, STRONGEST REUSE.** `DecisionRequest` (decision-protocol/src/decision-request.ts:23-47) is FLAT — no `kind` discriminator; decisions distinguished by `phase`+`options`. Three builders already emit it: buildMergeDecisionRequest (phase 'integrate'), buildReversalDecisionRequest, buildDeploymentBudgetDecisionRequest. Raise→publish→notify seam fully REAL + reusable (phases.ts:2664-2699: `decisionManager.ledger().raise(sanitized)` → `resolveDecisionPublisher().ensure` → `ledger.notify`, wrapped in `sanitizeDecisionRequest` + `withGovernedDecisionMarking`). **P5 adds a 4th builder (phase 'release', options approve/reject) + reuses the decision infra wholesale.** "Never earns autonomy" = net-new policy (bypass earn-in), but transport is free.

5. **`deploy` phase — REAL but ORTHOGONAL.** FSM integrate→deploy→test (fsm.ts). Handler phases.ts:2715-2748 → `runDeploy` (validation/deploy.ts:134-193) = per-issue post-merge smoke deploy (configured `deployCommand` + `healthCheckUrl` poll w/ SSRF guards), skipped if unset. NOT production promotion, NOT Operator-gated, NOT ledgered, NOT profile-driven. **Not a substrate P5 builds on** (shares only the name).

6. **Per-deployment "since last release" — ABSENT (pure net-new).** No per-deployment released-SHA marker; only anchor is release.sh's `git describe --tags 'release-*'` on the platform's OWN repo. No per-deployment trunk-diff / last-release marker / aggregation.

## Build vs reuse
- **REUSE:** DecisionRequest protocol + raise/publish/notify seam (item 4 — load-bearing); `productionReleasePath` field + `readDeclaredData('landing')` hook; `release.sh` as reference for the platform-performs shape; dashboard release UI shell (rewire — its button currently only PROPOSES via POST /release, semantics must change to per-event approval).
- **BUILD NET-NEW (no substrate):** (a) per-deployment release LEDGER persistence; (b) per-deployment last-released marker + since-last-release trunk aggregation; (c) per-deployment release PROPOSAL assembly (current one is single-repo/all-time/PR-model); (d) the 3-shape declared-path EXECUTOR (platform-performs / trigger-automated / record-only) with preview-before-change + fail-safe on prod-mutating shapes; (e) the "always raises, never earns autonomy" policy gate.
- **L1 reqs with NO reusable substrate (the buildable core):** L1(a) per-deployment since-last-release aggregation; L1(c) 3-shape executor incl. record-only + fail-safe; L1(f) per-deployment release ledger.

## Spec status (must rewrite for v2)
- ARCH-AC-RELEASE (`.specify/architecture/release.md`) = draft v1 **platform-instance-only — STALE vs L1 v2.** Rewrite for per-deployment / 3-shape / ledger.
- STACK-AC-RELEASE (`.specify/stack/release-sh.md`) = draft v1, code_paths→scripts/release.sh (bash). The v2 orchestration (proposal/ledger/decision-builder/3-shape executor) is DAEMON TS → new `release-ts.md`. Decide: retarget STACK-AC-RELEASE to release-ts.md (TS orchestration) and either retire release-sh.md or keep it as the platform-performs-shape reference.
- traceability.yml:1656-1672 already carries FUNC/ARCH/STACK-AC-RELEASE.
