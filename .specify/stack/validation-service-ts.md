---
id: STACK-AC-VALIDATION
type: stack-specific
domain: runforge
status: draft
version: 3
layer: 3
stack: typescript
references: ARCH-AC-VALIDATION
code_paths:
  - packages/daemon/src/validation/
  - packages/daemon/src/validation/review.ts
  - packages/daemon/src/validation/gates.ts
  - packages/daemon/src/validation/reviewer-session.ts
  - packages/daemon/src/validation/risk-detection.ts
  - packages/daemon/src/validation/sampling.ts
  - packages/daemon/src/validation/warmup.ts
  - packages/daemon/src/validation/holdout.ts
  - packages/daemon/src/validation/deploy.ts
  - packages/daemon/src/validation/post-deploy-test.ts
  - packages/daemon/src/validation/proactive-reviewer.ts
  - packages/daemon/src/validation/proactive-scheduler.ts
  - packages/daemon/src/validation/knowledge-injector.ts
  - packages/daemon/src/infra/spec-loader.ts
test_paths:
  - packages/daemon/src/validation/**/*.test.ts
  - packages/daemon/src/infra/spec-loader.test.ts
---

# STACK-AC-VALIDATION — Validation Service (TypeScript)

## Pattern

**Gate chain with early exit.** Gates execute in order. Each gate returns `pass` or `fail` with structured findings. On first failure, the chain stops and enters a fix cycle. After fix, the entire chain restarts from gate 1. This is a simple sequential pipeline, not a parallel fan-out.

**Fix cycle with diminishing returns.** On gate failure, delegate the fix to the Implementation Coordinator, then re-run the entire gate chain from gate 1 (not from the failed gate). Track finding counts per cycle. After a minimum number of cycles (default: 2), compare finding counts — if improvement drops below a threshold (default: 20%) for two consecutive cycles, escalate early with reason `diminishing-returns` rather than exhausting max cycles.

**Configurable commands for external operations.** Holdout runner, deployment, and test execution are configurable shell commands. The Validation Service invokes them via `child_process.spawn`, parses their output, and interprets exit codes. This decouples the validation logic from any specific test framework or deployment tool.

**Gate sequence from complexity + risk.** The gate sequence is determined by combining complexity classification and risk signals. Simple → gates 1-2, standard → gates 1-3, complex → gates 1-4. If any risk signal fires (label, keyword, or path match), gate 4 is included regardless of complexity. The sequence uses the maximum of complexity-required and risk-required gates.

**Two review modes: assigned QA and proactive review.** The Validation Service supports two independent review modes that share review capabilities (code analysis, quality checks, security evaluation) but differ in trigger and output. Assigned QA review is a pipeline gate — the Control Plane dispatches it for a specific work item. Proactive codebase review is self-directed — a scheduler triggers scans across codebase areas on a cadence.

**Knowledge injection at review start.** Before spawning an assigned QA reviewer session, the Validation Service queries the Knowledge Service for active records matching the reviewed area's artifact paths. Matched records are injected into the reviewer session's context so the reviewer can focus on known problem areas.

**Proactive review as scheduled scan.** A scheduler triggers proactive reviews on a configurable cadence (default: 20 minutes). Each cycle selects a codebase area, spawns a reviewer session that scans broadly for issues (bugs, spec drift, security concerns, quality regression), and records findings as GitHub issues labeled `review-finding` and as knowledge records.

**Work detection boundary: review-finding exclusion.** Issues labeled `review-finding` are excluded from executable work scans. They are signal inputs for the Tech Lead, not work items. A `review-finding` only becomes executable work when the Tech Lead proposes remediation, the PO approves, the operator approves, and a new issue with executable labels is created.

## Key Decisions

**Gate 1 (deterministic): Shell commands.** Runs a configured array of commands sequentially: test suite (`vitest run`), linter (`eslint --max-warnings 0`), type checker (`tsc --noEmit`), formatter check (`prettier --check`), and architecture fitness commands (custom scripts that check import boundaries). Each command's exit code determines pass/fail. Output is captured for fix context.

**Static analysis enforcement: ESLint rules + custom scripts.** Cyclomatic complexity via `eslint-plugin-complexity` (max 15 per function). Function length via custom rule (max 50 lines). File size via custom script (max 500 lines). These thresholds are configured in `config.validation.staticAnalysis` and enforced as part of gate 1.

**Architecture fitness: Custom shell scripts.** Scripts in `fitness/` directory that check structural invariants: `no-circular-deps.sh` (uses `madge --circular`), `boundary-check.sh` (greps for cross-boundary imports), `layer-separation.sh` (verifies no L3 tech names in L1/L2 specs). Each script exits 0 (pass) or 1 (fail with details on stdout).

**Gates 2-4 (intelligent): Session Runtime sessions.** Each gate spawns a fresh reviewer session via Session Runtime with no shared state from implementation or prior reviews (reviewer independence). The rubric is immutable to the session — the reviewer cannot alter its evaluation criteria. The reviewer independently reads implementation artifacts and verifies claims, never relying on the implementer's account.

**Evaluation rubric structure: Zod schemas.** Each intelligent gate uses a typed rubric defined via Zod. Gate 2 (spec compliance) dimensions: acceptance criteria coverage, behavioral correctness, constraint adherence. Gate 3 (quality) dimensions: maintainability, pattern consistency, test quality, convention alignment. Gate 4 (security) dimensions: injection resistance, authentication completeness, data validation, concurrency safety. Each dimension produces findings with severity (critical, major, minor).

**Reviewer session error handling: Retry once, then escalate.** If a reviewer session times out, treat as gate failure, re-spawn a fresh session. If the second attempt also times out, escalate. If a reviewer produces unstructured output (fails `ReviewFindings` schema validation), retry once with the same rubric. If the second attempt also fails, escalate.

**Warmup state: JSON file.** `state/warmup.json` containing completion count, graduated flag, consecutive correction count, and regression threshold (default: 3). Updated by the Daemon Control Plane after full pipeline success (not by the Validation Service after review).

**Warmup regression: Consecutive correction trigger.** When the Operator provides corrections on sampled reviews, the consecutive correction count increments. When it reaches the regression threshold (default: 3), the graduated flag resets to false and the completion count resets to zero — the system must re-earn trust through a fresh warmup period.

**Sampling: Deterministic random.** Use a seeded PRNG (seed = issue number) to decide if a work request is sampled. This makes sampling reproducible for debugging. Rate is configurable with a floor of 1%.

**Risk detection: Three-signal check.** Before determining the gate sequence, check: (1) label match — does the issue have a configured security-sensitive label? (checked via Octokit); (2) spec keyword match — does the spec content contain configured security keywords (e.g., `auth`, `credential`, `payment`)? (checked via regex); (3) artifact path match — do expected artifact locations overlap with configured security-sensitive path patterns? (checked via `minimatch`). Any single signal → include gate 4. Keyword list and path patterns are Operator-configurable.

**Warmup approval: Label-based hold.** When warmup or sampling requires Operator approval, apply a `needs-approval` label to the issue via Octokit and post a comment with the review summary. The pipeline pauses. The daemon's polling loop checks for label removal (Operator removes `needs-approval` to approve). On approval: continue pipeline. If the Operator also adds corrections as a comment with a structured marker, parse and route to Knowledge Service as operator corrections.

**Holdout runner: Configurable command.** `config.validation.holdoutCommand` (e.g., `vitest run --config holdout.config.ts`). The command receives the branch ref as an environment variable. Output must be JSON: `{ scenarios: [{ id: string, passed: boolean }] }`. If no command is configured, holdout is skipped with a warning. On failure, return failed scenario identifiers to the Control Plane — the Control Plane delegates to the Bug Diagnosis Service for Type A/B/C classification. The Validation Service does not interpret holdout failures.

**Integration review: Final check before promotion.** After all gates pass and holdout succeeds, a final integration review verifies the work is ready for promotion. This is a lightweight check orchestrated by the Control Plane — the Validation Service reports gate/holdout results and the Control Plane decides whether to proceed to deployment.

**Deployment: Configurable command with retry.** `config.validation.deployCommand` triggers deployment. After deployment, poll the health endpoint via `fetch()` at a configurable interval (default: 5 seconds) with `AbortController.timeout(config.deployTimeoutMs)`. On timeout: retry deployment up to `config.validation.maxDeployAttempts` (default: 2). If all attempts fail, escalate.

**Post-deployment testing: Command execution with fix loop.** `config.validation.testCommands` is an array of shell commands run against the deployed environment. On failure, truncate output to the relevant failure excerpt (scan backwards for failure markers, take surrounding context, configurable via `config.validation.failureExcerptLines`, default: 50) to prevent context flooding. Delegate fix to Implementation Coordinator, re-deploy, re-test. Bounded by `config.validation.maxTestFixAttempts`.

**Knowledge injection: Query before reviewer spawn.** The `KnowledgeInjector` calls `KnowledgeService.matchRecords(artifactPaths, 'review')` to retrieve active records whose artifact patterns match the reviewed area. The results are formatted as a `## Known Issues` section prepended to the reviewer session's context. Only `active` lifecycle records targeting the `review` session type (per PolicyRegistry) are injected. Hit counts are incremented by the Knowledge Service on match.

**Assigned QA reviewer write-back: Candidate observations.** After an assigned QA reviewer session completes, any issues it discovers beyond the pass/fail verdict are persisted as candidate observations via `KnowledgeService.storeRecord()` with `recordType: 'review_finding'`, `originType: 'autonomous'`, and `lifecycleStatus: 'candidate'`. Candidate records require Operator approval before becoming permanent knowledge (see STACK-AC-KNOWLEDGE candidate lifecycle). The reviewer session's structured output includes a `discoveredIssues` array alongside the gate verdict; the Validation Service extracts these and stores each as a separate knowledge record.

**Proactive reviewer: Session Runtime session with exploratory rubric.** The proactive reviewer spawns a Session Runtime session with an exploratory rubric (not the same rubric as assigned QA gates 2-4). Dimensions: spec-code drift, dead code, security regression, convention violations, test coverage gaps. The session receives the codebase area path and recent git activity (last N commits touching that area, default: 20) as context.

**Proactive scheduler: Codebase area rotation.** The `ProactiveScheduler` maintains a `state/proactive-review.json` file tracking: last review timestamp per codebase area, review cycle index, and a configurable area list derived from the project's top-level source directories. Each cycle picks the area with the oldest `lastReviewedAt` timestamp (round-robin with staleness priority). Areas are derived from `config.validation.proactiveAreas` or auto-detected from `src/*/` subdirectories.

**Proactive finding output: GitHub issue + knowledge record.** Each finding from a proactive review creates: (1) a GitHub issue via Octokit with label `review-finding` and structured body (severity, location, description, evidence), and (2) a knowledge record via `KnowledgeService.storeRecord()` with `recordType: 'review_finding'` and `originType: 'autonomous'`. The issue body includes a link to the knowledge record ID for traceability.

**Work detection boundary: Label exclusion in work scanner.** The work detection query (in Control Plane, see STACK-AC-CONTROL-PLANE) filters out issues with the `review-finding` label. This is enforced at the query level — `review-finding` issues are never returned by the executable work scan. The exclusion is a negative label filter in the Octokit `listForRepo` call.

**Proactive review throttling: Signal ratio.** The proactive scheduler checks `config.validation.proactiveMaxConcurrent` (default: 1) before spawning a new review. If a proactive review session is already running, the cycle is skipped. Additionally, if the daemon's active worker count exceeds `config.validation.proactiveThrottleThreshold` (default: 80% of max agents), proactive reviews are deferred to avoid competing for resources with pipeline work.

**Config extension for review modes.** New settings in `config.validation`: `proactiveIntervalMs` (default: 1200000 — 20 minutes), `proactiveAreas` (optional string array — auto-detected if absent), `proactiveMaxConcurrent` (default: 1), `proactiveThrottleThreshold` (default: 0.8), `proactiveRecentCommits` (default: 20). Validated via Zod on startup.

## Examples

```typescript
// Gate chain execution
async function runGates(gates: Gate[], branch: string): Promise<GateResult> {
  for (const gate of gates) {
    const result = await gate.execute(branch);
    if (!result.passed) return { passed: false, failedGate: gate, findings: result.findings };
  }
  return { passed: true };
}
```

```typescript
// Gate sequence: complexity map + risk override
const gates = complexityGates[complexity]; // simple→[1,2], standard→[1,2,3], complex→[1,2,3,4]
if (isRiskSensitive && !gates.includes('security')) gates.push('security');
```

```typescript
// Diminishing returns: compare finding counts across cycles
const improvement = (prevFindings - result.findingCount) / prevFindings;
stalledCount = improvement < threshold ? stalledCount + 1 : 0;
if (stalledCount >= 2) return { escalated: true, reason: 'diminishing-returns' };
```

```typescript
// Deterministic sampling
function shouldSample(issueNumber: number, rate: number): boolean {
  const hash = createHash('sha256').update(String(issueNumber)).digest();
  const value = hash.readUInt32BE(0) / 0xFFFFFFFF; // 0..1
  return value < rate;
}
```

```typescript
// Test output truncation for fix context
const lines = output.split('\n');
const failIdx = lines.findLastIndex(l => /FAIL|Error|AssertionError/.test(l));
return lines.slice(Math.max(0, failIdx - maxLines), failIdx + maxLines).join('\n');
```

```typescript
// Holdout runner invocation
const proc = spawn('sh', ['-c', config.holdoutCommand], {
  env: { ...process.env, BRANCH_REF: branch },
});
const output = JSON.parse(await collectStdout(proc));
const failures = output.scenarios.filter((s: any) => !s.passed);
```

```typescript
// Knowledge injection before reviewer session
async function injectKnowledge(artifactPaths: string[], ks: KnowledgeService): Promise<string> {
  const records = await ks.matchRecords(artifactPaths, 'review');
  if (!records.length) return '';
  return '## Known Issues\n' + records.map(r => `- ${r.description}`).join('\n');
}
```

```typescript
// Proactive scheduler — pick stalest area
function pickNextArea(state: ProactiveState, areas: string[]): string {
  return areas.reduce((oldest, area) =>
    (state.lastReviewedAt[area] ?? 0) < (state.lastReviewedAt[oldest] ?? 0) ? area : oldest
  );
}
```

```typescript
// Proactive finding — create GitHub issue + knowledge record
async function recordFinding(f: Finding, octokit: Octokit, ks: KnowledgeService): Promise<void> {
  const issue = await octokit.rest.issues.create({
    ...repoParams, title: f.title, body: f.body, labels: ['review-finding'],
  });
  await ks.storeRecord({ recordType: 'review_finding', sourceId: `issue-${issue.data.number}`, ... });
}
```

## Gotchas

- `vitest run` (no watch mode) is essential in CI/automation. `vitest` without `run` starts watch mode and hangs.
- ESLint with `--max-warnings 0` treats warnings as errors. This is intentional — the gate should fail on any warning.
- `tsc --noEmit` type-checks without producing output files. It's slow on large projects. Consider using `tsc --noEmit --incremental` with a `.tsbuildinfo` file to speed up re-checks.
- Holdout runner output parsing: if the command fails to produce valid JSON (crash, timeout), treat it as a holdout infrastructure failure, not a scenario failure. Log and escalate to the Operator.
- Reviewer session structured output: the `--json-schema` must match the `ReviewFindings` schema exactly. Schema drift between the validation service and the session causes parse failures. Validate the schema at startup.
- Sampling seed based on issue number means the same issue always gets the same sampling decision. This is intentional — sampling is about coverage across issues, not per-attempt randomness.
- Architecture fitness scripts in `fitness/` should be tested independently with fixture repos that have known violations.
- The `needs-approval` label polling approach means approval latency depends on the polling interval. For faster response, the Operator can also use the control API (`POST /approve/:issue`) which immediately unblocks the pipeline.
- Diminishing returns escalation should log a distinct reason (`diminishing-returns` vs `max-cycles-exceeded`) so the Operator can distinguish structural problems from complex-but-tractable ones.
- Post-deployment test output truncation must preserve the failure-relevant lines — scan backwards from the end to find the failure marker, then take context around it. Do not just take the last N lines.
- Reviewer session timeout retries use a fresh session each time — never retry with the same session that timed out.
- Warmup regression resets both the graduated flag and the completion count. A system that regresses must complete the full warmup again, not just one successful review.
- Knowledge injection must happen before the reviewer session is spawned — not mid-session. The injected context is part of the initial prompt, not a follow-up message.
- Knowledge `matchRecords` increments hit counts on the matched records. Do not call it speculatively — only call when actually spawning a reviewer session.
- Proactive review sessions must not use the same rubric as assigned QA gates. The exploratory rubric is broader (finds new issues) while gate rubrics are focused (verifies specific criteria). Mixing them produces noisy gate reviews or shallow explorations.
- Proactive scheduler `lastReviewedAt` uses wall-clock timestamps. If the daemon restarts, it resumes from persisted state — the stalest area gets reviewed first, not the area that was in progress at shutdown.
- `review-finding` label exclusion in work detection is a query-time filter, not a post-filter. Including then removing creates a TOCTOU window where the Coordinator might briefly see the issue as executable work.
- Proactive review throttling checks active worker count at schedule time. If the threshold is exceeded, the cycle is skipped entirely — it does not queue for later. The next scheduled cycle will re-check.
- Proactive findings create both a GitHub issue and a knowledge record. If the Octokit call succeeds but the knowledge store write fails (or vice versa), log the inconsistency but do not retry — the next proactive scan will rediscover the issue and dedup via knowledge store similarity matching.
- Assigned QA reviewer write-back uses `lifecycleStatus: 'candidate'` — not `active`. This ensures discovered issues require Operator approval before injection into future sessions. Proactive findings enter as `active` (autonomous origin) because they are already independently verified by the scheduled scan.
