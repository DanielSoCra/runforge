> **🗄 HISTORICAL (2026-06-02).** Implementation-complete execution log, kept for provenance. The active design is `docs/superpowers/specs/2026-03-25-daemon-pipeline-hardening-design.md`; the canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Daemon Pipeline Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix structural bugs causing infinite stuck retry loops and implement missing spec-driven pipeline handlers so L2→L3→implement works autonomously.

**Architecture:** Layer 1 (Tasks 1–4) adds pipeline safety rails + session registrations. Layer 2 (Tasks 5–8) implements spec pipeline handlers. All changes MUST ship in a single atomic commit due to handler validation requiring all handlers to exist. TDD throughout.

**Tech Stack:** TypeScript, Vitest, Octokit, Supabase, Zod

**Spec:** `docs/superpowers/specs/2026-03-25-daemon-pipeline-hardening-design.md`

---

### Task 1: Type foundations and config

Add new RunState fields, SessionType literals, PipelineResult outcome, config fields, session type registrations, and DB mappings. Merged with former Task 5 so typecheck passes (new SessionType literals require exhaustive switch updates in runtime.ts and run-writer.ts).

**Files:**
- Modify: `packages/daemon/src/types.ts:13,21-26,81-107`
- Modify: `packages/daemon/src/config.ts:8-161`
- Modify: `packages/daemon/src/control-plane/pipeline.ts:13-17`
- Modify: `packages/daemon/src/session-runtime/runtime.ts:61-161`
- Modify: `packages/daemon/src/supabase/run-writer.ts:15-33`
- Check: `packages/daemon/src/pipeline-dispatch/session-types.ts` (duplicate registry — add there too if it exists)

- [ ] **Step 1: Add `pausedAtPhase` and `l2GateNotified` to RunState**

In `packages/daemon/src/types.ts`, add to the `RunState` interface (after line ~107):

```typescript
// Gate parking (spec 1.4)
pausedAtPhase?: Phase;
l2GateNotified?: boolean;
```

- [ ] **Step 2: Add new SessionType literals**

In `packages/daemon/src/types.ts` line 21-26, add to the `SessionType` union:

```typescript
| 'l2-designer' | 'l3-generator' | 'compliance-reviewer'
```

- [ ] **Step 3: Add `'parked'` to PipelineResult outcome**

In `packages/daemon/src/control-plane/pipeline.ts` line 14, change:
```typescript
outcome: 'complete' | 'stuck' | 'paused' | 'error';
```
to:
```typescript
outcome: 'complete' | 'stuck' | 'paused' | 'error' | 'parked';
```

- [ ] **Step 4: Add config fields**

In `packages/daemon/src/config.ts`, add these fields to the Zod schema (inside the top-level object, near the other pipeline config):

```typescript
maxRunsPerIssue: z.number().int().min(1).default(3),
retryBackoffBaseMs: z.number().int().min(1000).default(60_000),
retryBackoffMaxMs: z.number().int().min(10_000).default(1_800_000),
```

- [ ] **Step 5: Add agent definitions to DEFAULT_AGENT_DEFS**

In `packages/daemon/src/session-runtime/runtime.ts`, add after the existing entries in `DEFAULT_AGENT_DEFS` (~line 161):

```typescript
'l2-designer': {
  name: 'l2-designer',
  description: 'Generates L2 architecture specs from L1 functional specs',
  systemPrompt: 'You are an L2 architecture spec designer. Use the spec-brainstorm-l2 and l2-spec-guardian skills. Generate or update the ARCH-* spec file in .specify/architecture/. Commit the result.',
  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  maxTurns: 30,
  timeoutMs: 300_000,
  budgetCap: 2,
},
'l3-generator': {
  name: 'l3-generator',
  description: 'Generates L3 stack-specific specs from approved L2 architecture specs',
  systemPrompt: 'You are an L3 spec generator. Use the spec-generate-l3 and l3-spec-guardian skills. Generate the STACK-* spec file in .specify/stack/. Run spec-review-compliance in inline mode as self-check. Commit the result.',
  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  maxTurns: 30,
  timeoutMs: 300_000,
  budgetCap: 2,
},
'compliance-reviewer': {
  name: 'compliance-reviewer',
  description: 'Reviews L3 specs for compliance with L1 and L2 specs',
  systemPrompt: 'You are a spec compliance reviewer. Use the spec-review-compliance skill to verify the L3 spec is consistent with L1 and L2. Report pass/fail with specific gaps found.',
  allowedTools: ['Read', 'Glob', 'Grep'],
  maxTurns: 15,
  timeoutMs: 180_000,
  budgetCap: 1,
},
```

- [ ] **Step 6: Add DB session type mapping**

In `packages/daemon/src/supabase/run-writer.ts`, in `toDbSessionType()` (~line 15), add cases:

```typescript
case 'l2-designer':
case 'l3-generator':         return 'planning';
case 'compliance-reviewer':  return 'validation';
```

Also check if `packages/daemon/src/pipeline-dispatch/session-types.ts` exists and has a parallel registry — if so, add the same types there.

- [ ] **Step 7: Run type-check**

Run: `cd packages/daemon && npx tsc --noEmit`
Expected: PASS (all new SessionType literals now have matching exhaustive switch cases)

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src/types.ts packages/daemon/src/config.ts packages/daemon/src/control-plane/pipeline.ts packages/daemon/src/session-runtime/runtime.ts packages/daemon/src/supabase/run-writer.ts
git commit -m "feat: add type foundations and session registrations for pipeline hardening"
```

---

### Task 2: Filter stuck and awaiting-review issues from work detection

Add `'stuck'` and `'awaiting-l2-review'` to exclusion lists in all work detection tiers.

**Files:**
- Modify: `packages/daemon/src/control-plane/work-detection.ts:48-118`
- Test: `packages/daemon/src/control-plane/work-detection.test.ts`

- [ ] **Step 1: Write failing tests for stuck exclusion**

In `packages/daemon/src/control-plane/work-detection.test.ts`, add to the existing test suite:

```typescript
describe('stuck/awaiting-l2-review label exclusion', () => {
  it('excludes stuck issues from detectFeaturePipelineWork tier 1', async () => {
    mockOctokit.issues.listForRepo.mockResolvedValue({
      data: [
        { number: 100, title: 'Ready', body: 'spec', labels: [{ name: 'feature-pipeline' }, { name: 'ready-to-implement' }, { name: 'stuck' }] },
      ],
    });
    const result = await detector.detectFeaturePipelineWork();
    expect(result.ok && result.value).toBeNull();
  });

  it('excludes stuck issues from detectBugFixWork', async () => {
    mockOctokit.issues.listForRepo.mockResolvedValue({
      data: [
        { number: 200, title: 'Bug', body: 'fix', labels: [{ name: 'review-finding' }, { name: 'auto-fix-approved' }, { name: 'stuck' }] },
      ],
    });
    const result = await detector.detectBugFixWork();
    expect(result.ok && result.value).toBeNull();
  });

  it('excludes awaiting-l2-review issues from detectFeaturePipelineWork', async () => {
    mockOctokit.issues.listForRepo.mockResolvedValue({
      data: [
        { number: 300, title: 'Parked', body: 'spec', labels: [{ name: 'feature-pipeline' }, { name: 'l2-approved' }, { name: 'awaiting-l2-review' }] },
      ],
    });
    const result = await detector.detectFeaturePipelineWork();
    expect(result.ok && result.value).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/control-plane/work-detection.test.ts`
Expected: 3 FAIL (stuck/awaiting issues not yet excluded)

- [ ] **Step 3: Add exclusions to work detection**

In `packages/daemon/src/control-plane/work-detection.ts`:

**detectBugFixWork** (~line 57): change `exclude: ['in-progress', 'blocked']` to:
```typescript
exclude: ['in-progress', 'blocked', 'stuck', 'awaiting-l2-review']
```

**detectFeaturePipelineWork** (~lines 82-85): add `'stuck'` and `'awaiting-l2-review'` to each tier's exclude array:
```typescript
{ labels: 'feature-pipeline,ready-to-implement', exclude: ['implementing', 'blocked', 'stuck', 'awaiting-l2-review'], workType: 'implementation' },
{ labels: 'feature-pipeline,l2-approved', exclude: ['l3-in-progress', 'blocked', 'stuck', 'awaiting-l2-review'], workType: 'l3-generate' },
{ labels: 'feature-pipeline,l2-in-progress', exclude: ['blocked', 'stuck', 'awaiting-l2-review'], workType: 'l2-brainstorm' },
{ labels: 'feature-pipeline,l1-approved', exclude: ['l2-in-progress', 'blocked', 'stuck', 'awaiting-l2-review'], workType: 'l2-brainstorm' },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/control-plane/work-detection.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/work-detection.ts packages/daemon/src/control-plane/work-detection.test.ts
git commit -m "fix: filter stuck and awaiting-l2-review issues from work detection"
```

---

### Task 3: Handler existence validation + parking interception in pipeline

Add pre-flight handler validation and the `pausedAtPhase` interception to `runPipeline()`.

**Files:**
- Modify: `packages/daemon/src/control-plane/pipeline.ts:40-187`
- Test: `packages/daemon/src/control-plane/pipeline.test.ts`

- [ ] **Step 1: Write failing test for handler validation**

In `packages/daemon/src/control-plane/pipeline.test.ts`, add:

```typescript
describe('handler existence validation', () => {
  it('returns stuck when transition table has phase with no handler', async () => {
    const table: TransitionTable = {
      detect: { success: { next: 'missing_phase' }, failure: { next: 'stuck' } },
      missing_phase: { success: { next: 'report' }, failure: { next: 'stuck' } },
      report: { success: { next: 'report' }, failure: { next: 'stuck' } },
    };
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success',
      report: async () => 'success',
      // missing_phase intentionally omitted
    };
    const run = makeRun({ phase: 'detect' });
    const result = await runPipeline(run, table, handlers, mockStateMgr, mockCostTracker);
    expect(result.outcome).toBe('stuck');
    expect(result.error).toContain('Missing handlers');
    expect(result.error).toContain('missing_phase');
  });
});
```

- [ ] **Step 2: Write failing test for parked outcome**

```typescript
describe('parked outcome', () => {
  it('returns parked when handler sets pausedAtPhase', async () => {
    const table: TransitionTable = {
      detect: { success: { next: 'report' }, failure: { next: 'stuck' } },
      report: { success: { next: 'report' }, failure: { next: 'stuck' } },
    };
    const handlers: PhaseHandlerMap = {
      detect: async (run) => {
        run.pausedAtPhase = 'detect';
        return 'success';
      },
      report: async () => 'success',
    };
    const run = makeRun({ phase: 'detect' });
    const result = await runPipeline(run, table, handlers, mockStateMgr, mockCostTracker);
    expect(result.outcome).toBe('parked');
    expect(run.phase).toBe('paused');
    expect(run.pausedAtPhase).toBe('detect');
  });

  it('budget-exceeded still returns paused (not parked)', async () => {
    const table: TransitionTable = {
      detect: { success: { next: 'report' }, failure: { next: 'stuck' } },
      report: { success: { next: 'report' }, failure: { next: 'stuck' } },
    };
    const handlers: PhaseHandlerMap = {
      detect: async () => 'budget-exceeded',
      report: async () => 'success',
    };
    const run = makeRun({ phase: 'detect' });
    const result = await runPipeline(run, table, handlers, mockStateMgr, mockCostTracker);
    expect(result.outcome).toBe('paused');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/control-plane/pipeline.test.ts`
Expected: 3 FAIL (validation and parking not implemented)

- [ ] **Step 4: Implement handler validation**

In `packages/daemon/src/control-plane/pipeline.ts`, at the top of `runPipeline()` (after line ~49, before the `while (true)` loop), add:

```typescript
// Pre-flight: validate all non-terminal phases have handlers
const missingHandlers: string[] = [];
for (const phase of Object.keys(table)) {
  if (phase === 'stuck' || phase === 'paused') continue;
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

- [ ] **Step 5: Implement parking interception**

In `packages/daemon/src/control-plane/pipeline.ts`, after the cost sync line (`run.cost = costTracker.getRunCost(...)`, line ~124) and BEFORE the global transition check (`const globalNext = applyGlobalTransition(event)`, line ~127), add:

```typescript
// Check if handler requested parking (e.g., l2-gate awaiting approval)
if (run.pausedAtPhase) {
  run.phase = 'paused';
  await stateMgr.saveRunState(run);
  void runWriter?.upsertRun(run.id, { current_phase: run.phase, phases: buildPhaseRecords(run) });
  return { outcome: 'parked', run };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/control-plane/pipeline.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/control-plane/pipeline.ts packages/daemon/src/control-plane/pipeline.test.ts
git commit -m "feat: add handler validation and parking interception to pipeline"
```

---

### Task 4: Parked outcome handling + backoff in daemon

Wire `'parked'` as no-op in `handleRunOutcome`, add retry backoff tracking, and add per-issue retry cap (DB-mode only).

**Files:**
- Modify: `packages/daemon/src/control-plane/daemon.ts:328-357,669-765`
- Test: `packages/daemon/src/control-plane/daemon.test.ts`

- [ ] **Step 1: Write failing test for parked outcome handling**

In `packages/daemon/src/control-plane/daemon.test.ts`, add a test verifying that `handleRunOutcome('parked', ...)` does NOT increment stuck count and does NOT pause the daemon. Adapt to the existing test structure in that file.

- [ ] **Step 2: Implement parked handling in handleRunOutcome**

In `packages/daemon/src/control-plane/daemon.ts`, in the `handleRunOutcome` function (~line 328), add a case before the `else` block:

```typescript
} else if (outcome === 'parked') {
  // Gate-parked run — no-op, don't increment stuck or pause daemon
  console.log(`[daemon] Run #${issueNumber} parked at gate, awaiting approval`);
```

- [ ] **Step 3: Add `toDbOutcome` mapping for parked**

In `packages/daemon/src/supabase/run-writer.ts`, update `toDbOutcome` (~line 9) to map `'parked'` to `'in-progress'` (parked runs are still in-progress from the DB perspective):

```typescript
if (outcome === 'parked') return 'in-progress';
```

- [ ] **Step 4: Add retry backoff map**

In `packages/daemon/src/control-plane/daemon.ts`, after `let consecutiveStuckCount = 0;` (~line 325), add:

```typescript
/** Per-issue backoff tracker — in-memory only, resets on restart. */
const stuckBackoff = new Map<string, { count: number; lastStuckAt: number }>();

function issueKey(owner: string, repo: string, issue: number): string {
  return `${owner}/${repo}#${issue}`;
}

function isBackedOff(key: string, config: Config): boolean {
  const entry = stuckBackoff.get(key);
  if (!entry) return false;
  const backoff = Math.min(config.retryBackoffBaseMs * Math.pow(2, entry.count - 1), config.retryBackoffMaxMs);
  return Date.now() - entry.lastStuckAt < backoff;
}
```

In `handleRunOutcome`, when outcome is `'stuck'`, also record backoff:

```typescript
const key = issueKey(owner, repoName, issueNumber);
const prev = stuckBackoff.get(key);
stuckBackoff.set(key, { count: (prev?.count ?? 0) + 1, lastStuckAt: Date.now() });
```

When outcome is successful (`else` branch), clear the backoff entry:

```typescript
stuckBackoff.delete(issueKey(owner, repoName, issueNumber));
```

- [ ] **Step 5: Add `releaseClaim` helper**

In `packages/daemon/src/control-plane/daemon.ts`, add a helper function:

```typescript
/** Remove all claim labels from an issue. Best-effort — ignores missing labels. */
async function releaseClaim(octokit: Octokit, owner: string, repo: string, issueNumber: number): Promise<void> {
  const claimLabels = ['in-progress', 'implementing', 'l2-in-progress', 'l3-in-progress', 'l3-review'];
  for (const label of claimLabels) {
    try {
      await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
    } catch { /* label may not exist — ignore */ }
  }
}
```

- [ ] **Step 6: Add per-issue retry cap (DB-mode only)**

In `processWorkRequest` (~line 669), after the claim and before `runPipeline()`, add:

```typescript
// Per-issue retry cap (DB-mode only)
if (runWriter) {
  const supabase = getSupabaseClient();
  if (supabase) {
    const { count } = await supabase
      .from('runs')
      .select('*', { count: 'exact', head: true })
      .eq('issue_number', request.issueNumber)
      .eq('repo_owner', owner)
      .eq('repo_name', repoName)
      .eq('outcome', 'stuck');
    if ((count ?? 0) >= config.maxRunsPerIssue) {
      console.warn(`[daemon] Issue #${request.issueNumber} hit retry cap (${count} stuck runs) — auto-blocking`);
      await octokit.issues.addLabels({ owner, repo: repoName, issue_number: request.issueNumber, labels: ['blocked'] });
      await octokit.issues.createComment({ owner, repo: repoName, issue_number: request.issueNumber,
        body: `**Auto-blocked:** this issue went stuck ${count} times. Needs human investigation.`,
      });
      await releaseClaim(octokit, owner, repoName, request.issueNumber);
      return;
    }
  }
}
```

- [ ] **Step 7: Add backoff check before claiming work**

In the poll loop, after each work detection call returns a candidate (before claiming), add:

```typescript
if (request && isBackedOff(issueKey(owner, repoName, request.issueNumber), config)) {
  console.log(`[daemon] Skipping #${request.issueNumber} — backed off`);
  continue; // or skip this candidate
}
```

- [ ] **Step 8: Run tests**

Run: `cd packages/daemon && npx vitest run src/control-plane/daemon.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add packages/daemon/src/control-plane/daemon.ts packages/daemon/src/control-plane/daemon.test.ts packages/daemon/src/supabase/run-writer.ts
git commit -m "feat: add parked outcome handling, retry backoff, and per-issue retry cap"
```

---

### Task 5: Spec chain refresh helper

Add `resolveCurrentSpecRefs()` to dynamically resolve the spec chain from traceability.yml.

**Files:**
- Modify: `packages/daemon/src/infra/spec-loader.ts:12-108`
- Test: `packages/daemon/src/infra/spec-loader.test.ts` (create if needed)

- [ ] **Step 1: Write failing test**

```typescript
describe('resolveCurrentSpecRefs', () => {
  it('finds L2/L3 specs linked to a given L1 ref via traceability.yml', async () => {
    // Mock a traceability.yml that links FUNC-AC-FOO → ARCH-AC-FOO → STACK-AC-FOO
    const specifyRoot = '/tmp/test-specify';
    // ... set up mock files or use vi.mock for fs
    const refs = await resolveCurrentSpecRefs(specifyRoot, ['FUNC-AC-FOO']);
    expect(refs).toContain('FUNC-AC-FOO');
    expect(refs).toContain('ARCH-AC-FOO');
    expect(refs).toContain('STACK-AC-FOO');
  });
});
```

- [ ] **Step 2: Implement resolveCurrentSpecRefs**

In `packages/daemon/src/infra/spec-loader.ts`, add:

```typescript
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml'; // same library used by extractCodePaths

/**
 * Resolves the full spec chain from traceability.yml, starting from base refs.
 * Walks children (downward) to find all L2/L3 specs linked to the given L1 refs.
 *
 * traceability.yml schema:
 *   SPEC-ID:
 *     parent: PARENT-SPEC-ID   # L2/L3 only
 *     children: [CHILD-IDS]    # optional
 *     code_paths: [...]         # L3 only
 *     status: draft|approved|deprecated
 */
export async function resolveCurrentSpecRefs(
  specifyRoot: string,
  baseRefs: string[],
): Promise<string[]> {
  const traceabilityPath = join(specifyRoot, 'traceability.yml');
  try {
    const content = await readFile(traceabilityPath, 'utf-8');
    const entries = loadYaml(content) as Record<string, { parent?: string; children?: string[]; status?: string }>;
    const allRefs = new Set(baseRefs);
    // Walk children downward from base refs
    let changed = true;
    while (changed) {
      changed = false;
      for (const [specId, entry] of Object.entries(entries)) {
        if (allRefs.has(specId)) {
          // Add children
          for (const child of entry.children ?? []) {
            if (!allRefs.has(child)) {
              allRefs.add(child);
              changed = true;
            }
          }
        }
        // Also add specs whose parent is in our set
        if (entry.parent && allRefs.has(entry.parent) && !allRefs.has(specId)) {
          allRefs.add(specId);
          changed = true;
        }
      }
    }
    return [...allRefs];
  } catch {
    return baseRefs; // Fallback: return original refs if traceability missing
  }
}
```

Note: check `extractCodePaths` in spec-loader.ts (~line 166) for the exact YAML import pattern used in this project — adapt if different from `js-yaml`.

- [ ] **Step 3: Run tests**

Run: `cd packages/daemon && npx vitest run src/infra/spec-loader`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/infra/spec-loader.ts packages/daemon/src/infra/spec-loader.test.ts
git commit -m "feat: add resolveCurrentSpecRefs for dynamic spec chain resolution"
```

---

### Task 6: Spec pipeline phase handlers (l2-design, l2-gate, l3-generate, l3-compliance, decompose)

Implement all 5 new handlers in `createPhaseHandlers()`. This is the largest task.

**Files:**
- Modify: `packages/daemon/src/control-plane/phases.ts:56-493`
- Modify: `packages/daemon/src/control-plane/spec-pipeline/variant.ts:53-69`
- Test: `packages/daemon/src/control-plane/phases.test.ts`

- [ ] **Step 1: Write failing tests for l2-design handler**

In `packages/daemon/src/control-plane/phases.test.ts`, add:

```typescript
describe('l2-design handler', () => {
  it('spawns l2-designer session with L1 spec content', async () => {
    mockRuntime.spawnSession.mockResolvedValue({ ok: true, value: { output: '', totalCost: 0.5, structuredData: null } });
    const { handlers } = createHandlers();
    const run = makeRun({ variant: 'spec-driven' });
    const result = await handlers['l2-design']!(run);
    expect(result).toBe('success');
    expect(mockRuntime.spawnSession).toHaveBeenCalledWith(
      'l2-designer',
      expect.objectContaining({ variables: expect.any(Object) }),
      expect.any(Number),
      expect.any(Object),
    );
  });

  it('returns failure when session fails', async () => {
    mockRuntime.spawnSession.mockResolvedValue({ ok: false, error: new Error('session failed') });
    const { handlers } = createHandlers();
    const result = await handlers['l2-design']!(makeRun());
    expect(result).toBe('failure');
  });
});
```

- [ ] **Step 2: Write failing tests for l2-gate handler**

```typescript
describe('l2-gate handler', () => {
  it('returns success when l2-approved label present', async () => {
    mockOctokit.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: 'l2-approved' }, { name: 'feature-pipeline' }],
    });
    const { handlers } = createHandlers();
    const run = makeRun();
    const result = await handlers['l2-gate']!(run);
    expect(result).toBe('success');
    expect(run.pausedAtPhase).toBeUndefined();
  });

  it('returns feedback when l2-rejected label present', async () => {
    mockOctokit.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: 'l2-rejected' }],
    });
    const { handlers } = createHandlers();
    const result = await handlers['l2-gate']!(makeRun());
    expect(result).toBe('feedback');
  });

  it('parks run and notifies when no approval label', async () => {
    mockOctokit.issues.listLabelsOnIssue.mockResolvedValue({ data: [] });
    mockOctokit.issues.addLabels.mockResolvedValue({});
    mockOctokit.issues.createComment.mockResolvedValue({});
    const { handlers } = createHandlers();
    const run = makeRun();
    const result = await handlers['l2-gate']!(run);
    expect(result).toBe('success');
    expect(run.pausedAtPhase).toBe('l2-gate');
    expect(run.l2GateNotified).toBe(true);
    expect(mockOctokit.issues.addLabels).toHaveBeenCalled();
    expect(mockOctokit.issues.createComment).toHaveBeenCalled();
  });

  it('does not re-notify when already notified', async () => {
    mockOctokit.issues.listLabelsOnIssue.mockResolvedValue({ data: [] });
    const { handlers } = createHandlers();
    const run = makeRun();
    run.l2GateNotified = true;
    await handlers['l2-gate']!(run);
    expect(run.pausedAtPhase).toBe('l2-gate');
    expect(mockOctokit.issues.addLabels).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Write failing tests for l3-generate and l3-compliance**

```typescript
describe('l3-generate handler', () => {
  it('spawns l3-generator session', async () => {
    mockRuntime.spawnSession.mockResolvedValue({ ok: true, value: { output: '', totalCost: 0.5, structuredData: null } });
    const { handlers } = createHandlers();
    const result = await handlers['l3-generate']!(makeRun({ variant: 'spec-driven' }));
    expect(result).toBe('success');
    expect(mockRuntime.spawnSession).toHaveBeenCalledWith(
      'l3-generator', expect.any(Object), expect.any(Number), expect.any(Object),
    );
  });
});

describe('l3-compliance handler', () => {
  it('spawns compliance-reviewer session', async () => {
    mockRuntime.spawnSession.mockResolvedValue({ ok: true, value: { output: 'PASS', totalCost: 0.3, structuredData: null } });
    const { handlers } = createHandlers();
    const result = await handlers['l3-compliance']!(makeRun({ variant: 'spec-driven' }));
    expect(result).toBe('success');
    expect(mockRuntime.spawnSession).toHaveBeenCalledWith(
      'compliance-reviewer', expect.any(Object), expect.any(Number), expect.any(Object),
    );
  });

  it('returns failure when compliance check fails', async () => {
    mockRuntime.spawnSession.mockResolvedValue({ ok: true, value: { output: 'FAIL: gaps found', totalCost: 0.3, structuredData: { passed: false } } });
    const { handlers } = createHandlers();
    const result = await handlers['l3-compliance']!(makeRun());
    expect(result).toBe('failure');
  });
});

describe('decompose handler', () => {
  it('returns success (trivial passthrough)', async () => {
    const { handlers } = createHandlers();
    const result = await handlers.decompose!(makeRun());
    expect(result).toBe('success');
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/control-plane/phases.test.ts`
Expected: Multiple FAIL (handlers don't exist yet)

- [ ] **Step 5: Implement the handlers in phases.ts**

In `packages/daemon/src/control-plane/phases.ts`, inside `createPhaseHandlers()` return object (after `detect:` handler, before `classify:`), add the 4 spec pipeline handlers + decompose:

```typescript
'l2-design': async (run: RunState): Promise<PhaseEvent> => {
  console.log(`[l2-design] Generating L2 spec for #${workRequest.issueNumber}`);
  const cwd = repoRoot ?? process.cwd();
  const specifyRoot = join(cwd, '.specify');
  let specContent = '';
  try {
    specContent = await loadSpecContent(workRequest.specRefs, specifyRoot);
  } catch (e) {
    console.warn(`[l2-design] Failed to load L1 spec content:`, e);
  }
  const result = await runtime.spawnSession('l2-designer', {
    variables: {
      issue_body: workRequest.body,
      issue_title: workRequest.title,
      spec_content: specContent,
      spec_refs: workRequest.specRefs.join(', '),
    },
  }, workRequest.issueNumber, undefined, runWriter, runId);
  if (!result.ok) {
    console.error(`[l2-design] Session failed:`, result.error.message);
    return 'failure';
  }
  // Refresh spec refs after generation
  try {
    const refreshed = await resolveCurrentSpecRefs(specifyRoot, workRequest.specRefs);
    run.specRefs = refreshed;
  } catch (e) {
    console.warn(`[l2-design] Spec chain refresh failed:`, e);
  }
  return 'success';
},

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

  if (!run.l2GateNotified) {
    await octokit.issues.addLabels({ owner, repo, issue_number: workRequest.issueNumber, labels: ['awaiting-l2-review'] });
    await octokit.issues.createComment({ owner, repo, issue_number: workRequest.issueNumber,
      body: '**L2 spec generated.** Please review the ARCH-* spec and add `l2-approved` or `l2-rejected` label.',
    });
    run.l2GateNotified = true;
  }

  console.log(`[l2-gate] Awaiting L2 approval for #${workRequest.issueNumber}, parking`);
  run.pausedAtPhase = 'l2-gate';
  return 'success';
},

'l3-generate': async (run: RunState): Promise<PhaseEvent> => {
  console.log(`[l3-generate] Generating L3 spec for #${workRequest.issueNumber}`);
  const cwd = repoRoot ?? process.cwd();
  const specifyRoot = join(cwd, '.specify');
  // Refresh spec refs to include the approved L2 spec
  let specRefs = run.specRefs ?? workRequest.specRefs;
  try {
    specRefs = await resolveCurrentSpecRefs(specifyRoot, workRequest.specRefs);
    run.specRefs = specRefs;
  } catch (e) {
    console.warn(`[l3-generate] Spec chain refresh failed:`, e);
  }
  let specContent = '';
  try {
    specContent = await loadSpecContent(specRefs, specifyRoot);
  } catch (e) {
    console.warn(`[l3-generate] Failed to load spec content:`, e);
  }
  const result = await runtime.spawnSession('l3-generator', {
    variables: {
      issue_body: workRequest.body,
      issue_title: workRequest.title,
      spec_content: specContent,
      spec_refs: specRefs.join(', '),
    },
  }, workRequest.issueNumber, undefined, runWriter, runId);
  if (!result.ok) {
    console.error(`[l3-generate] Session failed:`, result.error.message);
    return 'failure';
  }
  // Refresh spec refs after L3 generation
  try {
    const refreshed = await resolveCurrentSpecRefs(specifyRoot, workRequest.specRefs);
    run.specRefs = refreshed;
  } catch (e) {
    console.warn(`[l3-generate] Spec chain refresh failed:`, e);
  }
  return 'success';
},

'l3-compliance': async (run: RunState): Promise<PhaseEvent> => {
  console.log(`[l3-compliance] Running compliance review for #${workRequest.issueNumber}`);
  const cwd = repoRoot ?? process.cwd();
  const specifyRoot = join(cwd, '.specify');
  const specRefs = run.specRefs ?? workRequest.specRefs;
  let specContent = '';
  try {
    specContent = await loadSpecContent(specRefs, specifyRoot);
  } catch (e) {
    console.warn(`[l3-compliance] Failed to load spec content:`, e);
  }
  const result = await runtime.spawnSession('compliance-reviewer', {
    variables: {
      spec_content: specContent,
      spec_refs: specRefs.join(', '),
    },
  }, workRequest.issueNumber, undefined, runWriter, runId);
  if (!result.ok) {
    console.error(`[l3-compliance] Session failed:`, result.error.message);
    return 'failure';
  }
  // Check structured output for pass/fail
  const data = result.value.structuredData as { passed?: boolean } | null;
  if (data && data.passed === false) {
    console.log(`[l3-compliance] Compliance check failed — looping back to l3-generate`);
    return 'failure';
  }
  return 'success';
},

decompose: async (_run: RunState): Promise<PhaseEvent> => {
  // Trivial passthrough — preserves existing feature variant behavior
  return 'success';
},
```

Also add the import for `resolveCurrentSpecRefs`:
```typescript
import { loadSpecContent, loadImplementationContent, resolveCurrentSpecRefs } from '../infra/spec-loader.js';
```

- [ ] **Step 6: Remove dead `unchanged` transition from variant.ts**

In `packages/daemon/src/control-plane/spec-pipeline/variant.ts`, line ~59, remove the `unchanged: { next: 'l2-gate' },` line from the `l2-gate` entry.

- [ ] **Step 7: Run all tests**

Run: `cd packages/daemon && npx vitest run src/control-plane/phases.test.ts src/control-plane/spec-pipeline/variant.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src/control-plane/phases.ts packages/daemon/src/control-plane/phases.test.ts packages/daemon/src/control-plane/spec-pipeline/variant.ts
git commit -m "feat: implement spec pipeline handlers (l2-design, l2-gate, l3-generate, l3-compliance, decompose)"
```

---

### Task 7: Parked-run resume scan in daemon

Add the poll loop scan that resumes parked runs when approval labels are added.

**Files:**
- Modify: `packages/daemon/src/control-plane/daemon.ts`
- Test: `packages/daemon/src/control-plane/daemon.test.ts`

- [ ] **Step 1: Write failing test for resume scan**

In `packages/daemon/src/control-plane/daemon.test.ts`, add a test that verifies: given a run in state dir with `phase: 'paused'` and `pausedAtPhase: 'l2-gate'`, when the issue has `l2-approved` label, the daemon resumes the run by resetting its phase and re-entering the pipeline.

- [ ] **Step 2: Implement resume scan**

In `packages/daemon/src/control-plane/daemon.ts`, add a function `resumeParkedRuns()` and call it at the end of each poll cycle (after the normal work detection pass):

```typescript
async function resumeParkedRuns(): Promise<void> {
  // Check local state for parked runs — use findIncompleteRuns() (StateManager API)
  // and filter for parked state. If findIncompleteRuns doesn't return paused runs,
  // scan the state directory directly: readdir + readFile for *.json files.
  const stateFiles = await readdir(stateDir).catch(() => []);
  const parkedRuns: RunState[] = [];
  for (const file of stateFiles.filter(f => f.endsWith('.json'))) {
    try {
      const data = JSON.parse(await readFile(join(stateDir, 'runs', file), 'utf-8'));
      if (data.phase === 'paused' && data.pausedAtPhase) parkedRuns.push(data);
    } catch { continue; }
  }
  const parked = parkedRuns[0]; // Limit to 1 per cycle
  if (!parked) return;

  // Limit to 1 per cycle
  if (parked.pausedAtPhase === 'l2-gate') {
    const { data: labels } = await octokit.issues.listLabelsOnIssue({
      owner: parked.repoOwner!, repo: parked.repoName!,
      issue_number: parked.issueNumber,
    });
    const labelNames = labels.map(l => l.name);

    if (labelNames.includes('l2-approved') || labelNames.includes('l2-rejected')) {
      console.log(`[daemon] Resuming parked run #${parked.issueNumber} — gate condition met`);
      // Remove awaiting-l2-review label
      try {
        await octokit.issues.removeLabel({
          owner: parked.repoOwner!, repo: parked.repoName!,
          issue_number: parked.issueNumber, name: 'awaiting-l2-review',
        });
      } catch { /* label might not exist */ }

      parked.phase = 'l2-gate'; // Reset to gate phase
      parked.pausedAtPhase = undefined;
      await stateMgr.saveRunState(parked);

      // Re-enter pipeline
      // ... reuse existing resume logic from findIncompleteRuns path
    }
  }
}
```

Integrate into the poll loop at the end of the tick function.

- [ ] **Step 3: Run tests**

Run: `cd packages/daemon && npx vitest run src/control-plane/daemon.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/control-plane/daemon.ts packages/daemon/src/control-plane/daemon.test.ts
git commit -m "feat: add parked-run resume scan to daemon poll loop"
```

---

### Task 8: Full integration test and variant test updates

Update existing tests affected by the changes and run the full suite.

**Files:**
- Modify: `packages/daemon/src/control-plane/spec-pipeline/variant.test.ts`
- Modify: `packages/daemon/src/control-plane/phases.integration.test.ts`

- [ ] **Step 1: Update variant.test.ts for removed `unchanged` transition**

In `packages/daemon/src/control-plane/spec-pipeline/variant.test.ts`, find any test that references the `unchanged` event on `l2-gate` and remove or update it.

- [ ] **Step 2: Run full daemon test suite**

Run: `cd packages/daemon && npx vitest run`
Expected: ALL PASS (2027+ tests)

- [ ] **Step 3: Run typecheck**

Run: `cd packages/daemon && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "test: update integration tests for pipeline hardening changes"
```

---

### Execution Order and Dependencies

```
Task 1 (types/config/session registration) ← foundation for everything
  ↓
Task 2 (work detection) ← independent from 3-4, can parallelize
Task 3 (pipeline validation + parking) ← depends on 1
Task 4 (daemon parked handling + backoff + retry cap) ← depends on 1, 3
Task 5 (spec chain refresh) ← independent
  ↓
Task 6 (all handlers) ← depends on 1, 5 — MUST ship with 3 (atomicity)
  ↓
Task 7 (resume scan) ← depends on 4, 6
Task 8 (integration tests) ← depends on all above
```

**Critical atomicity:** Tasks 3 + 6 must be in the final build together. Handler validation (Task 3) will fail if handlers from Task 6 don't exist yet. During development, run tests per-task, but ensure both land before deploying.
