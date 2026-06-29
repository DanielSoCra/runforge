import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  retryStuckIssue,
  stripDecisionBlock,
  type OperatorRetryDeps,
  type ParkedRunInfo,
} from './operator-retry.js';
import { StateManager } from './state.js';
import type { RunState } from '../types.js';
import { inferRetryRestoration } from './work-detection.js';
import {
  BLOCK_START,
  BLOCK_END,
} from './decision-escalation/github-block-notifier.js';

// ── Test doubles ─────────────────────────────────────────────────────────────

type IssueOp =
  | { op: 'get' }
  | { op: 'addLabels'; labels: string[] }
  | { op: 'removeLabel'; name: string }
  | { op: 'update'; body: string }
  | { op: 'createComment'; body: string };

interface FakeIssue {
  labels: string[];
  body: string;
}

interface FakeOctokitOptions {
  /** Throw a generic error from these ops (simulates a GitHub failure). */
  throwOn?: Partial<Record<IssueOp['op'], boolean>>;
  /** removeLabel throws `{status:404}` for these label names (absent label). */
  removeLabel404?: string[];
  /** removeLabel throws a generic (non-404) error for these label names. */
  removeLabelThrows?: string[];
}

function makeOctokit(issue: FakeIssue, opts: FakeOctokitOptions = {}) {
  const ops: IssueOp[] = [];
  const octokit = {
    issues: {
      async get(): Promise<{ data: { body: string; labels: Array<{ name: string }> } }> {
        ops.push({ op: 'get' });
        if (opts.throwOn?.get === true) throw new Error('get failed');
        return {
          data: { body: issue.body, labels: issue.labels.map((name) => ({ name })) },
        };
      },
      async addLabels(args: { labels: string[] }): Promise<unknown> {
        ops.push({ op: 'addLabels', labels: args.labels });
        if (opts.throwOn?.addLabels === true) throw new Error('addLabels failed');
        for (const label of args.labels) {
          if (!issue.labels.includes(label)) issue.labels.push(label);
        }
        return {};
      },
      async removeLabel(args: { name: string }): Promise<unknown> {
        ops.push({ op: 'removeLabel', name: args.name });
        if (opts.removeLabel404?.includes(args.name) === true) {
          throw Object.assign(new Error('Label does not exist'), { status: 404 });
        }
        if (opts.removeLabelThrows?.includes(args.name) === true) {
          throw new Error(`removeLabel ${args.name} failed`);
        }
        if (opts.throwOn?.removeLabel === true) throw new Error('removeLabel failed');
        issue.labels = issue.labels.filter((label) => label !== args.name);
        return {};
      },
      async update(args: { body: string }): Promise<unknown> {
        ops.push({ op: 'update', body: args.body });
        if (opts.throwOn?.update === true) throw new Error('update failed');
        issue.body = args.body;
        return {};
      },
      async createComment(args: { body: string }): Promise<unknown> {
        ops.push({ op: 'createComment', body: args.body });
        if (opts.throwOn?.createComment === true) throw new Error('createComment failed');
        return {};
      },
    },
  };
  return { octokit, ops, issue };
}

function makeDeps(
  octokit: ReturnType<typeof makeOctokit>['octokit'],
  overrides: Partial<OperatorRetryDeps> = {},
): OperatorRetryDeps {
  return {
    octokit,
    owner: 'o',
    repo: 'r',
    clearBackoff: vi.fn(),
    clearInMemoryRunState: vi.fn(),
    deleteRunState: vi.fn().mockResolvedValue(undefined),
    findParkedRuns: vi.fn<() => Promise<ParkedRunInfo[]>>().mockResolvedValue([]),
    log: vi.fn(),
    ...overrides,
  };
}

const ISSUE = 42;

function indexOfOp(ops: IssueOp[], match: (op: IssueOp) => boolean): number {
  return ops.findIndex(match);
}

// ── inferRetryRestoration ────────────────────────────────────────────────────

describe('inferRetryRestoration', () => {
  it('standard (only stuck) → ready, strips in-progress', () => {
    const result = inferRetryRestoration(['stuck']);
    expect(result).toEqual({
      ok: true,
      plan: { workType: 'standard', entryLabel: 'ready', removeActiveLabels: ['in-progress'] },
    });
  });

  it('bug (review-finding) → review-finding kept', () => {
    const result = inferRetryRestoration(['review-finding', 'stuck']);
    expect(result.ok && result.plan.entryLabel).toBe('review-finding');
  });

  it('feature-impl (feature-pipeline + implementing) → ready-to-implement', () => {
    const result = inferRetryRestoration(['feature-pipeline', 'implementing', 'stuck']);
    expect(result.ok && result.plan.entryLabel).toBe('ready-to-implement');
    expect(result.ok && result.plan.removeActiveLabels).toContain('implementing');
  });

  it('l3-generate (feature-pipeline + l2-approved + l3-in-progress) → l2-approved', () => {
    const result = inferRetryRestoration([
      'feature-pipeline',
      'l2-approved',
      'l3-in-progress',
      'stuck',
    ]);
    expect(result.ok && result.plan.entryLabel).toBe('l2-approved');
    expect(result.ok && result.plan.removeActiveLabels).toContain('l3-in-progress');
  });

  it('l3-generate not yet started (only l2-approved) → l2-approved', () => {
    const result = inferRetryRestoration(['feature-pipeline', 'l2-approved', 'stuck']);
    expect(result.ok && result.plan.entryLabel).toBe('l2-approved');
  });

  it('l2-in-progress tier → l2-in-progress (entry IS the claim label)', () => {
    const result = inferRetryRestoration(['feature-pipeline', 'l2-in-progress', 'stuck']);
    expect(result.ok && result.plan.entryLabel).toBe('l2-in-progress');
    expect(result.ok && result.plan.removeActiveLabels).toEqual([]);
  });

  it('l1-approved tier (l1-approved + l2-in-progress claim) → l1-approved, strips l2-in-progress', () => {
    const result = inferRetryRestoration([
      'feature-pipeline',
      'l1-approved',
      'l2-in-progress',
      'stuck',
    ]);
    expect(result.ok && result.plan.entryLabel).toBe('l1-approved');
    expect(result.ok && result.plan.removeActiveLabels).toContain('l2-in-progress');
  });

  it('indeterminate feature-pipeline (no tier label, no history) → not ok', () => {
    const result = inferRetryRestoration(['feature-pipeline', 'stuck']);
    expect(result.ok).toBe(false);
  });

  it('indeterminate feature-pipeline + l2-brainstorm history → still not ok (ambiguous tier)', () => {
    const result = inferRetryRestoration(['feature-pipeline', 'stuck'], 'l2-brainstorm');
    expect(result.ok).toBe(false);
  });

  it('feature-pipeline + implementation history (no tier label) → ready-to-implement', () => {
    const result = inferRetryRestoration(['feature-pipeline', 'stuck'], 'implementation');
    expect(result.ok && result.plan.entryLabel).toBe('ready-to-implement');
  });
});

// ── stripDecisionBlock ───────────────────────────────────────────────────────

describe('stripDecisionBlock', () => {
  const block = `${BLOCK_START}\n\`\`\`json\n{"x":1}\n\`\`\`\n${BLOCK_END}`;

  it('absent markers → absent', () => {
    expect(stripDecisionBlock('just human text').kind).toBe('absent');
  });

  it('exactly one balanced block → stripped, human content preserved', () => {
    const result = stripDecisionBlock(`Human context here.\n\n${block}`);
    expect(result.kind).toBe('stripped');
    if (result.kind === 'stripped') {
      expect(result.body).toContain('Human context here.');
      expect(result.body).not.toContain(BLOCK_START);
      expect(result.body).not.toContain(BLOCK_END);
    }
  });

  it('two start markers → ambiguous (fail-closed, no truncation)', () => {
    const result = stripDecisionBlock(`${block}\n\n${block}`);
    expect(result.kind).toBe('ambiguous');
  });

  it('unbalanced (start without end) → ambiguous', () => {
    expect(stripDecisionBlock(`prefix ${BLOCK_START} no end`).kind).toBe('ambiguous');
  });
});

// ── Admission order ──────────────────────────────────────────────────────────

describe('retryStuckIssue — admission', () => {
  it('blocked WITHOUT stuck (auto-capped) → 409, not 404, no mutations', async () => {
    const { octokit, ops } = makeOctokit({ labels: ['blocked', 'feature-pipeline'], body: '' });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(409);
    expect(ops.some((o) => o.op !== 'get')).toBe(false);
  });

  it('blocked AND stuck → 409', async () => {
    const { octokit } = makeOctokit({ labels: ['blocked', 'stuck'], body: '' });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(409);
  });

  it('manual blocked (no stuck) → 409', async () => {
    const { octokit } = makeOctokit({ labels: ['blocked'], body: '' });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(409);
  });

  it('decision-request label → 409 answer-the-decision', async () => {
    const { octokit, ops } = makeOctokit({ labels: ['decision-request'], body: '' });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(409);
    expect((result.body as { error: string }).error).toMatch(/awaiting an Operator decision/);
    expect(ops.some((o) => o.op !== 'get')).toBe(false);
  });

  it('active l2-gate park → 409 even if stuck label present', async () => {
    const { octokit } = makeOctokit({ labels: ['feature-pipeline', 'stuck'], body: '' });
    const deps = makeDeps(octokit, {
      findParkedRuns: vi
        .fn<() => Promise<ParkedRunInfo[]>>()
        .mockResolvedValue([{ issueNumber: ISSUE, pausedAtPhase: 'l2-gate' }]),
    });
    const result = await retryStuckIssue(deps, ISSUE);
    expect(result.status).toBe(409);
  });

  it('active integrate park → 409', async () => {
    const { octokit } = makeOctokit({ labels: ['feature-pipeline', 'stuck'], body: '' });
    const deps = makeDeps(octokit, {
      findParkedRuns: vi
        .fn<() => Promise<ParkedRunInfo[]>>()
        .mockResolvedValue([{ issueNumber: ISSUE, pausedAtPhase: 'integrate' }]),
    });
    const result = await retryStuckIssue(deps, ISSUE);
    expect(result.status).toBe(409);
  });

  it('a parked run for a DIFFERENT issue does not block this retry', async () => {
    const { octokit } = makeOctokit({ labels: ['stuck'], body: '' });
    const deps = makeDeps(octokit, {
      findParkedRuns: vi
        .fn<() => Promise<ParkedRunInfo[]>>()
        .mockResolvedValue([{ issueNumber: 999, pausedAtPhase: 'l2-gate' }]),
    });
    const result = await retryStuckIssue(deps, ISSUE);
    expect(result.status).toBe(200);
  });

  it('not stuck, not blocked, not a decision → 404', async () => {
    const { octokit, ops } = makeOctokit({ labels: ['ready'], body: '' });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(404);
    expect(ops.some((o) => o.op !== 'get')).toBe(false);
  });

  it('findParkedRuns failure → 503 fail-closed, no mutations', async () => {
    const { octokit, ops } = makeOctokit({ labels: ['stuck'], body: '' });
    const deps = makeDeps(octokit, {
      findParkedRuns: vi.fn<() => Promise<ParkedRunInfo[]>>().mockRejectedValue(new Error('db down')),
    });
    const result = await retryStuckIssue(deps, ISSUE);
    expect(result.status).toBe(503);
    expect(ops.some((o) => o.op !== 'get')).toBe(false);
  });

  it('octokit.get failure → 503, nothing touched', async () => {
    const { octokit } = makeOctokit({ labels: ['stuck'], body: '' }, { throwOn: { get: true } });
    const deps = makeDeps(octokit);
    const result = await retryStuckIssue(deps, ISSUE);
    expect(result.status).toBe(503);
    expect(deps.clearBackoff).not.toHaveBeenCalled();
  });
});

// ── Tier restore ─────────────────────────────────────────────────────────────

describe('retryStuckIssue — tier restore', () => {
  it('standard stuck → ready restored, stuck gone', async () => {
    const { octokit, issue } = makeOctokit({ labels: ['stuck'], body: '' });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ retrying: ISSUE });
    expect(issue.labels).toContain('ready');
    expect(issue.labels).not.toContain('stuck');
  });

  it('feature-impl stuck → ready-to-implement, implementing+stuck gone', async () => {
    const { octokit, issue } = makeOctokit({
      labels: ['feature-pipeline', 'implementing', 'stuck'],
      body: '',
    });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    expect(issue.labels).toEqual(expect.arrayContaining(['feature-pipeline', 'ready-to-implement']));
    expect(issue.labels).not.toContain('implementing');
    expect(issue.labels).not.toContain('stuck');
  });

  it('l3-generate stuck → l2-approved, l3-in-progress+stuck gone', async () => {
    const { octokit, issue } = makeOctokit({
      labels: ['feature-pipeline', 'l2-approved', 'l3-in-progress', 'stuck'],
      body: '',
    });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    expect(issue.labels).toContain('l2-approved');
    expect(issue.labels).not.toContain('l3-in-progress');
    expect(issue.labels).not.toContain('stuck');
  });

  it('l2-in-progress stuck → l2-in-progress kept, stuck gone', async () => {
    const { octokit, issue } = makeOctokit({
      labels: ['feature-pipeline', 'l2-in-progress', 'stuck'],
      body: '',
    });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    expect(issue.labels).toContain('l2-in-progress');
    expect(issue.labels).not.toContain('stuck');
  });

  it('l1-approved stuck → l1-approved restored, l2-in-progress+stuck gone', async () => {
    const { octokit, issue } = makeOctokit({
      labels: ['feature-pipeline', 'l1-approved', 'l2-in-progress', 'stuck'],
      body: '',
    });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    expect(issue.labels).toContain('l1-approved');
    expect(issue.labels).not.toContain('l2-in-progress');
    expect(issue.labels).not.toContain('stuck');
  });

  it('bug stuck → review-finding kept, stuck gone', async () => {
    const { octokit, issue } = makeOctokit({ labels: ['review-finding', 'stuck'], body: '' });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    expect(issue.labels).toContain('review-finding');
    expect(issue.labels).not.toContain('stuck');
  });

  it('indeterminate work type → 409, NO labels touched', async () => {
    const { octokit, ops } = makeOctokit({ labels: ['feature-pipeline', 'stuck'], body: '' });
    const deps = makeDeps(octokit);
    const result = await retryStuckIssue(deps, ISSUE);
    expect(result.status).toBe(409);
    expect(ops.some((o) => o.op !== 'get')).toBe(false);
    expect(deps.clearBackoff).not.toHaveBeenCalled();
  });
});

// ── Decision body-block stripping ────────────────────────────────────────────

describe('retryStuckIssue — decision body-block', () => {
  const block = `${BLOCK_START}\n\`\`\`json\n{"x":1}\n\`\`\`\n${BLOCK_END}`;

  it('lingering block → body edited to strip the marker region', async () => {
    const { octokit, issue, ops } = makeOctokit({
      labels: ['feature-pipeline', 'l2-in-progress', 'stuck'],
      body: `Original human body.\n\n${block}`,
    });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    expect(ops.some((o) => o.op === 'update')).toBe(true);
    expect(issue.body).toContain('Original human body.');
    expect(issue.body).not.toContain(BLOCK_START);
  });

  it('no block in body → update is never called', async () => {
    const { octokit, ops } = makeOctokit({
      labels: ['feature-pipeline', 'l2-in-progress', 'stuck'],
      body: 'plain body',
    });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    expect(ops.some((o) => o.op === 'update')).toBe(false);
  });

  it('ambiguous markers → fail-closed: 409, body NOT truncated, stuck remains', async () => {
    const { octokit, issue, ops } = makeOctokit({
      labels: ['feature-pipeline', 'l2-in-progress', 'stuck'],
      body: `${block}\n\n${block}`,
    });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(409);
    expect(ops.some((o) => o.op === 'update')).toBe(false);
    // entry label may be restored, but the item must remain stuck (safe).
    expect(issue.labels).toContain('stuck');
  });
});

// ── From-scratch: parked-run cleanup ─────────────────────────────────────────

describe('retryStuckIssue — from-scratch reset', () => {
  it('clears backoff, in-memory claim, and persisted run state (no resume)', async () => {
    const { octokit } = makeOctokit({ labels: ['stuck'], body: '' });
    const deps = makeDeps(octokit);
    const result = await retryStuckIssue(deps, ISSUE);
    expect(result.status).toBe(200);
    expect(deps.clearBackoff).toHaveBeenCalledWith(ISSUE);
    expect(deps.clearInMemoryRunState).toHaveBeenCalledWith(ISSUE);
    expect(deps.deleteRunState).toHaveBeenCalledWith(ISSUE);
  });

  it('in-memory reset failure → 503, GitHub UNTOUCHED, item still stuck', async () => {
    const { octokit, ops, issue } = makeOctokit({ labels: ['stuck'], body: '' });
    const deps = makeDeps(octokit, {
      deleteRunState: vi.fn().mockRejectedValue(new Error('fs error')),
    });
    const result = await retryStuckIssue(deps, ISSUE);
    expect(result.status).toBe(503);
    expect(ops.some((o) => o.op !== 'get')).toBe(false);
    expect(issue.labels).toContain('stuck');
  });
});

// ── Commit ordering + partial-failure safety ─────────────────────────────────

describe('retryStuckIssue — ordering & strand-safety', () => {
  it('entry label is added BEFORE stuck is removed', async () => {
    const { octokit, ops } = makeOctokit({ labels: ['stuck'], body: '' });
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    const addIdx = indexOfOp(ops, (o) => o.op === 'addLabels');
    const removeStuckIdx = indexOfOp(ops, (o) => o.op === 'removeLabel' && o.name === 'stuck');
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(removeStuckIdx).toBeGreaterThan(addIdx);
  });

  it('failure removing stuck → item still stuck+entry, never label-less, 503', async () => {
    const { octokit, issue } = makeOctokit(
      { labels: ['stuck'], body: '' },
      { removeLabelThrows: ['stuck'] },
    );
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(503);
    expect(issue.labels).toContain('ready'); // entry restored
    expect(issue.labels).toContain('stuck'); // still excluded → safe
  });

  it('failure adding entry label → item still stuck (no entry), 503', async () => {
    const { octokit, issue } = makeOctokit(
      { labels: ['stuck'], body: '' },
      { throwOn: { addLabels: true } },
    );
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(503);
    expect(issue.labels).toContain('stuck');
  });
});

// ── Best-effort audit + 404 tolerance + double retry ─────────────────────────

describe('retryStuckIssue — tolerance', () => {
  it('audit-comment failure does NOT fail the retry (still 200)', async () => {
    const { octokit, issue } = makeOctokit(
      { labels: ['stuck'], body: '' },
      { throwOn: { createComment: true } },
    );
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    expect(issue.labels).not.toContain('stuck');
  });

  it('removeLabel 404 for an absent active label is tolerated (200)', async () => {
    const { octokit, issue } = makeOctokit(
      { labels: ['feature-pipeline', 'implementing', 'stuck'], body: '' },
      { removeLabel404: ['implementing'] },
    );
    const result = await retryStuckIssue(makeDeps(octokit), ISSUE);
    expect(result.status).toBe(200);
    expect(issue.labels).not.toContain('stuck');
  });

  it('double retry → second call 404 (no longer stuck)', async () => {
    const { octokit } = makeOctokit({ labels: ['stuck'], body: '' });
    const deps = makeDeps(octokit);
    const first = await retryStuckIssue(deps, ISSUE);
    expect(first.status).toBe(200);
    const second = await retryStuckIssue(deps, ISSUE);
    expect(second.status).toBe(404);
  });
});

// ── Daemon adapter: REAL strict parked-run reader (not the pure mock) ─────────
//
// Regression for the IMPORTANT finding: the fail-closed-on-parked-run-error
// path was DEAD in production because the daemon wired the lenient
// `stateMgr.findParkedRuns()` (swallows scan/read failures → []). These tests
// exercise the REAL injected path the daemon now uses — `findParkedRunsStrict()`
// — through a real StateManager + a temp run store, proving the 503 actually
// fires on an unreadable store (and that a clean store still proceeds).

describe('retryStuckIssue — daemon adapter (strict parked-run reader)', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeStateManager(): Promise<{ sm: StateManager; runsDir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'op-retry-state-'));
    tmpDirs.push(dir);
    const sm = new StateManager(dir);
    await sm.initialize(); // creates <dir>/runs
    return { sm, runsDir: join(dir, 'runs') };
  }

  // Wire findParkedRuns EXACTLY as daemon.ts does — through findParkedRunsStrict.
  function adapterDeps(
    octokit: ReturnType<typeof makeOctokit>['octokit'],
    sm: StateManager,
  ): OperatorRetryDeps {
    return makeDeps(octokit, {
      findParkedRuns: async () =>
        (await sm.findParkedRunsStrict()).map((run) => ({
          issueNumber: run.issueNumber,
          pausedAtPhase: run.pausedAtPhase,
        })),
    });
  }

  it('unreadable run store (corrupt run file) → 503, NO GitHub mutations, stays stuck', async () => {
    const { sm, runsDir } = await makeStateManager();
    // A corrupt run file makes the strict scan throw (parse failure) — exactly
    // the production case the lenient reader silently turned into [].
    await writeFile(join(runsDir, '7.json'), '{ not json');
    const { octokit, ops, issue } = makeOctokit({ labels: ['feature-pipeline', 'stuck'], body: '' });

    const result = await retryStuckIssue(adapterDeps(octokit, sm), ISSUE);

    expect(result.status).toBe(503);
    expect(ops.some((o) => o.op !== 'get')).toBe(false); // no mutations
    expect(issue.labels).toContain('stuck'); // fail-closed: still stuck
  });

  it('clean run store (no parked runs) → strict reader returns [] → retry proceeds (200)', async () => {
    const { sm } = await makeStateManager();
    const { octokit, issue } = makeOctokit({ labels: ['stuck'], body: '' });

    const result = await retryStuckIssue(adapterDeps(octokit, sm), ISSUE);

    expect(result.status).toBe(200);
    expect(issue.labels).not.toContain('stuck');
  });

  it('strict reader sees an active l2-gate park on disk → 409 (does not re-admit)', async () => {
    const { sm } = await makeStateManager();
    const parked: RunState = {
      id: 'run-1',
      issueNumber: ISSUE,
      title: 't',
      phase: 'paused',
      pausedAtPhase: 'l2-gate',
      variant: 'feature',
      phaseCompletions: {},
      checkpoints: [],
      cost: 0,
      perRunBudget: 0,
      fixAttempts: [],
      errorHashes: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await sm.saveRunState(parked);
    const { octokit, ops } = makeOctokit({ labels: ['feature-pipeline', 'stuck'], body: '' });

    const result = await retryStuckIssue(adapterDeps(octokit, sm), ISSUE);

    expect(result.status).toBe(409);
    expect(ops.some((o) => o.op !== 'get')).toBe(false);
  });
});
