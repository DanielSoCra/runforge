---
id: STACK-AC-VALIDATION
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-VALIDATION
code_paths:
  - packages/daemon/src/validation/
test_paths:
  - packages/daemon/src/validation/**/*.test.ts
---

# STACK-AC-VALIDATION — Validation Service (TypeScript)

## Pattern

**Gate chain with early exit.** Gates execute in order. Each gate returns `pass` or `fail` with structured findings. On first failure, the chain stops and enters a fix cycle. After fix, the entire chain restarts from gate 1. This is a simple sequential pipeline, not a parallel fan-out.

**Configurable commands for external operations.** Holdout runner, deployment, and test execution are configurable shell commands. The Validation Service invokes them via `child_process.spawn`, parses their output, and interprets exit codes. This decouples the validation logic from any specific test framework or deployment tool.

## Key Decisions

**Gate 1 (deterministic): Shell commands.** Runs a configured array of commands sequentially: test suite (`vitest run`), linter (`eslint --max-warnings 0`), type checker (`tsc --noEmit`), formatter check (`prettier --check`), and architecture fitness commands (custom scripts that check import boundaries). Each command's exit code determines pass/fail. Output is captured for fix context.

**Static analysis enforcement: ESLint rules + custom scripts.** Cyclomatic complexity via `eslint-plugin-complexity` (max 15 per function). Function length via custom rule (max 50 lines). File size via custom script (max 500 lines). These thresholds are configured in `config.validation.staticAnalysis` and enforced as part of gate 1.

**Architecture fitness: Custom shell scripts.** Scripts in `fitness/` directory that check structural invariants: `no-circular-deps.sh` (uses `madge --circular`), `boundary-check.sh` (greps for cross-boundary imports), `layer-separation.sh` (verifies no L3 tech names in L1/L2 specs). Each script exits 0 (pass) or 1 (fail with details on stdout).

**Gates 2-4 (intelligent): Session Runtime sessions.** Each gate spawns a fresh reviewer session with a structured rubric. The rubric is a JSON object with dimensions, each containing evaluation criteria and severity mappings. The reviewer returns findings as structured JSON via `--json-schema`.

**Warmup state: JSON file.** `state/warmup.json` containing completion count, graduated flag, consecutive correction count, and regression threshold. Updated by the Daemon Control Plane after full pipeline success (not by the Validation Service after review).

**Sampling: Deterministic random.** Use a seeded PRNG (seed = issue number) to decide if a work request is sampled. This makes sampling reproducible for debugging. Rate is configurable with a floor of 1%.

**Risk detection: Three-signal check.** Before determining the gate sequence, check: (1) label match — does the issue have a configured security-sensitive label? (checked via Octokit); (2) spec keyword match — does the spec content contain configured security keywords (e.g., `auth`, `credential`, `payment`)? (checked via regex); (3) artifact path match — do expected artifact locations overlap with configured security-sensitive path patterns? (checked via `minimatch`). Any single signal → include gate 4. Keyword list and path patterns are Operator-configurable.

**Warmup approval: Label-based hold.** When warmup or sampling requires Operator approval, apply a `needs-approval` label to the issue via Octokit and post a comment with the review summary. The pipeline pauses. The daemon's polling loop checks for label removal (Operator removes `needs-approval` to approve). On approval: continue pipeline. If the Operator also adds corrections as a comment with a structured marker, parse and route to Knowledge Service as operator corrections.

**Health polling: Interval + timeout.** After deployment, poll the health endpoint via `fetch()` at a configurable interval (default: 5 seconds) with `AbortController.timeout(config.deployTimeoutMs)`. If healthy within timeout: proceed. On timeout: return deployment failure. On each poll failure: log and continue polling until timeout.

**Holdout runner: Configurable command.** `config.validation.holdoutCommand` (e.g., `vitest run --config holdout.config.ts`). The command receives the branch ref as an environment variable. Output must be JSON: `{ scenarios: [{ id: string, passed: boolean }] }`. If no command is configured, holdout is skipped with a warning.

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
// Deterministic sampling
function shouldSample(issueNumber: number, rate: number): boolean {
  const hash = createHash('sha256').update(String(issueNumber)).digest();
  const value = hash.readUInt32BE(0) / 0xFFFFFFFF; // 0..1
  return value < rate;
}
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
// Architecture fitness check
const results = await Promise.all(
  fitnessScripts.map(script => runCommand(script, { cwd: branch }))
);
const failures = results.filter(r => !r.ok);
```

## Gotchas

- `vitest run` (no watch mode) is essential in CI/automation. `vitest` without `run` starts watch mode and hangs.
- ESLint with `--max-warnings 0` treats warnings as errors. This is intentional — the gate should fail on any warning.
- `tsc --noEmit` type-checks without producing output files. It's slow on large projects. Consider using `tsc --noEmit --incremental` with a `.tsbuildinfo` file to speed up re-checks.
- Holdout runner output parsing: if the command fails to produce valid JSON (crash, timeout), treat it as a holdout infrastructure failure, not a scenario failure. Log and escalate to the Operator.
- Reviewer session structured output: the `--json-schema` must match the `ReviewFindings` schema exactly. Schema drift between the validation service and the session causes parse failures. Validate the schema at startup.
- Sampling seed based on issue number means the same issue always gets the same sampling decision. This is good for reproducibility but means re-running a stuck issue doesn't change the sampling outcome. This is intentional — sampling is about coverage across issues, not per-attempt randomness.
- Architecture fitness scripts in `fitness/` should be tested independently with fixture repos that have known violations. Add integration tests that verify each script catches what it should.
- The `needs-approval` label polling approach means approval latency depends on the polling interval. For faster response, the Operator can also use the control API (`POST /approve/:issue`) which immediately unblocks the pipeline.
