// finding-dismissal/apply-consumer.test.ts — the LOAD-BEARING consumer contract.
// Pure: a ledger fake (with a generic-reconcile simulator) + a recording octokit
// fake + (a recording or REAL) learning service over a temp dir. No real GitHub /
// Postgres / timers.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommentLike } from '../decision-escalation/resume-consumer.js';
import { buildDecisionResponseComment } from '../decision-escalation/answer-publisher.js';
import { OperatorLearningService } from '../../operator-learning/index.js';
import { FakeFindingLedger } from './__fixtures__/fake-ledger.js';
import {
  runFindingDismissalConsumer,
  type ConsumerLearning,
  type ConsumerOctokit,
} from './apply-consumer.js';
import { buildFindingDismissalDecisionId } from './build-request.js';
import type { ReviewCategory } from '../../coordination/review-scheduler.js';

const OWNER = 'acme';
const REPO = 'widgets';
const SRC = (n: number) => `https://github.com/${OWNER}/${REPO}/issues/${n}`;
/** Repo-scoped finding decision id for this test's repo. */
const fid = (n: number, cat: ReviewCategory, epoch = 1): string =>
  buildFindingDismissalDecisionId(OWNER, REPO, n, cat, epoch);

// --- recording octokit fake (labels = idempotent Set; comments grow + paginate) ---
function makeOctokit(
  perIssue: Record<number, { state?: string; comments?: CommentLike[] }>,
  events?: string[],
): {
  octokit: ConsumerOctokit;
  labels: Map<number, Set<string>>;
  auditCount: () => number;
} {
  const labels = new Map<number, Set<string>>();
  const comments = new Map<number, CommentLike[]>();
  for (const [n, cfg] of Object.entries(perIssue)) {
    comments.set(Number(n), [...(cfg.comments ?? [])]);
  }
  let audit = 0;
  const octokit: ConsumerOctokit = {
    issues: {
      get: async ({ issue_number }) => ({
        data: { state: perIssue[issue_number]?.state ?? 'open' },
      }),
      // Honour per_page/page so the consumer's pagination loop is exercised.
      listComments: async ({ issue_number, per_page, page }) => {
        const all = comments.get(issue_number) ?? [];
        const pp = per_page ?? all.length;
        const pg = page ?? 1;
        const start = (pg - 1) * pp;
        return { data: all.slice(start, start + pp) };
      },
      addLabels: async ({ issue_number, labels: toAdd }) => {
        const set = labels.get(issue_number) ?? new Set<string>();
        for (const l of toAdd) set.add(l);
        labels.set(issue_number, set);
        events?.push(`addLabels:${issue_number}:${toAdd.join(',')}`);
        return undefined;
      },
      createComment: async ({ issue_number, body }) => {
        const list = comments.get(issue_number) ?? [];
        list.push({ body });
        comments.set(issue_number, list);
        if (body.includes('finding-dismissal:verdict:')) audit += 1;
        events?.push(`createComment:${issue_number}`);
        return undefined;
      },
    },
  };
  return { octokit, labels, auditCount: () => audit };
}

function recordingLearning(events: string[], sink?: ConsumerLearning): ConsumerLearning {
  return {
    observeDecisionAnswer: async (input) => {
      events.push(`observe:${input.sourceDecisionId}:${input.chosenOption}:${input.decisionClass}`);
      if (sink) await sink.observeDecisionAnswer(input);
    },
  };
}

/** Build a valid Operator DecisionResponse comment the consumer's parser recognizes. */
function operatorAnswer(decisionId: string, choice: 'approve' | 'reject'): CommentLike {
  return { body: buildDecisionResponseComment(decisionId, choice, 'k1') };
}

describe('runFindingDismissalConsumer — happy path', () => {
  it('drives verdict → observe → answer → terminalize, IN THAT (durable-first) ORDER', async () => {
    const events: string[] = [];
    const id = fid(42, 'correctness');
    const ledger = new FakeFindingLedger(events);
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    const { octokit, labels } = makeOctokit(
      { 42: { state: 'open', comments: [operatorAnswer(id, 'reject')] } },
      events,
    );

    const applied = await runFindingDismissalConsumer({
      ledger,
      octokit,
      operatorLearning: recordingLearning(events),
      owner: OWNER,
      repo: REPO,
    });

    expect(applied).toBe(1);
    // DURABLE-FIRST: verdict (label + audit), then observe, then ledger answer,
    // then terminalize. The answer comes AFTER the durable artifacts so a generic
    // reconcile can never terminalize before they are written.
    expect(events).toEqual([
      'addLabels:42:dismissed',
      'createComment:42',
      `observe:${id}:reject:finding_dismissal:correctness`,
      `answer:${id}:reject`,
      `advanceToResumed:${id}`,
    ]);
    expect(labels.get(42)).toEqual(new Set(['dismissed']));
    expect(await ledger.statusOf(id)).toBe('resumed');
  });

  it('approve → kept label + observed as approve', async () => {
    const events: string[] = [];
    const id = fid(7, 'performance');
    const ledger = new FakeFindingLedger(events);
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(7), options: ['approve', 'reject'] });
    const { octokit, labels } = makeOctokit(
      { 7: { state: 'open', comments: [operatorAnswer(id, 'approve')] } },
      events,
    );
    await runFindingDismissalConsumer({
      ledger,
      octokit,
      operatorLearning: recordingLearning(events),
      owner: OWNER,
      repo: REPO,
    });
    expect(labels.get(7)).toEqual(new Set(['kept']));
    expect(events).toContain(`observe:${id}:approve:finding_dismissal:performance`);
  });

  it('NEVER answers/terminalizes before the verdict + observation are written', async () => {
    const events: string[] = [];
    const id = fid(42, 'security');
    const ledger = new FakeFindingLedger(events);
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    const { octokit } = makeOctokit({ 42: { state: 'open', comments: [operatorAnswer(id, 'reject')] } }, events);
    await runFindingDismissalConsumer({
      ledger,
      octokit,
      operatorLearning: recordingLearning(events),
      owner: OWNER,
      repo: REPO,
    });
    const labelIdx = events.indexOf('addLabels:42:dismissed');
    const observeIdx = events.findIndex((e) => e.startsWith(`observe:${id}`));
    const answerIdx = events.indexOf(`answer:${id}:reject`);
    const advanceIdx = events.indexOf(`advanceToResumed:${id}`);
    // verdict + observe strictly precede the ledger answer; terminalize is last.
    expect(answerIdx).toBeGreaterThan(labelIdx);
    expect(answerIdx).toBeGreaterThan(observeIdx);
    expect(advanceIdx).toBeGreaterThan(answerIdx);
  });
});

describe('runFindingDismissalConsumer — generic-reconcile race (the CRITICAL)', () => {
  it('a reconcile firing right AFTER ledger.answer() terminalizes the row but does NOT lose verdict/observe', async () => {
    const events: string[] = [];
    const id = fid(42, 'correctness');
    const ledger = new FakeFindingLedger(events);
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    const { octokit, labels, auditCount } = makeOctokit(
      { 42: { state: 'open', comments: [operatorAnswer(id, 'reject')] } },
      events,
    );
    // Simulate the daemon's generic outbox reconcile firing the instant the row
    // becomes `answered_pending_source_write` (the real race: reconcile runs every
    // tick BEFORE this consumer and drives that row to `resumed`).
    const realAnswer = ledger.answer.bind(ledger);
    ledger.answer = async (decisionId, opt, who) => {
      const r = await realAnswer(decisionId, opt, who);
      await ledger.reconcile(); // ← terminalizes the row out from under the consumer
      return r;
    };

    const applied = await runFindingDismissalConsumer({
      ledger,
      octokit,
      operatorLearning: recordingLearning(events),
      owner: OWNER,
      repo: REPO,
    });

    // The verdict + observation were written BEFORE answer(), so even though the
    // reconcile terminalized the row mid-flight, NOTHING is lost.
    expect(applied).toBe(1);
    expect(labels.get(42)).toEqual(new Set(['dismissed']));
    expect(auditCount()).toBe(1);
    expect(events.filter((e) => e.startsWith(`observe:${id}`))).toHaveLength(1);
    // The row IS terminal (reconcile took it there); the consumer's own
    // advanceToResumed was a harmless no-op.
    expect(await ledger.statusOf(id)).toBe('resumed');
    expect(events).toContain(`reconcile-resumed:${id}`);
  });

  it('a reconcile firing BETWEEN verdict and observe (row still notified) is a no-op; the apply completes', async () => {
    const events: string[] = [];
    const id = fid(42, 'correctness');
    const ledger = new FakeFindingLedger(events);
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    const { octokit, labels } = makeOctokit(
      { 42: { state: 'open', comments: [operatorAnswer(id, 'reject')] } },
      events,
    );
    // Fire a generic reconcile right before the observe step. At that point the row
    // is still `notified` (answer hasn't run), so reconcile can't terminalize it.
    const learning: ConsumerLearning = {
      observeDecisionAnswer: async (input) => {
        await ledger.reconcile(); // no-op: nothing is answered yet
        events.push(`observe:${input.sourceDecisionId}:${input.chosenOption}:${input.decisionClass}`);
      },
    };

    const applied = await runFindingDismissalConsumer({
      ledger,
      octokit,
      operatorLearning: learning,
      owner: OWNER,
      repo: REPO,
    });

    expect(applied).toBe(1);
    expect(labels.get(42)).toEqual(new Set(['dismissed']));
    expect(events.filter((e) => e.startsWith(`observe:${id}`))).toHaveLength(1);
    expect(events).not.toContain(`reconcile-resumed:${id}`); // reconcile did nothing
    expect(await ledger.statusOf(id)).toBe('resumed');
  });
});

describe('runFindingDismissalConsumer — pending / no-op cases', () => {
  it('a finding with no DecisionResponse yet stays pending (no answer/verdict)', async () => {
    const events: string[] = [];
    const id = fid(42, 'correctness');
    const ledger = new FakeFindingLedger(events);
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    const { octokit, labels } = makeOctokit({ 42: { state: 'open', comments: [] } }, events);
    const applied = await runFindingDismissalConsumer({
      ledger,
      octokit,
      operatorLearning: recordingLearning(events),
      owner: OWNER,
      repo: REPO,
    });
    expect(applied).toBe(0);
    expect(events).toEqual([]); // no verdict, no observe, no answer, no terminalize
    expect(labels.get(42)).toBeUndefined();
    expect(await ledger.statusOf(id)).toBe('notified'); // still pending
  });

  it('a closed/moot finding is SUPERSEDED (terminalized without applying)', async () => {
    const events: string[] = [];
    const id = fid(42, 'correctness');
    const ledger = new FakeFindingLedger(events);
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    // Even with an operator answer present, a closed issue is superseded, not applied.
    const { octokit, labels } = makeOctokit(
      { 42: { state: 'closed', comments: [operatorAnswer(id, 'reject')] } },
      events,
    );
    await runFindingDismissalConsumer({
      ledger,
      octokit,
      operatorLearning: recordingLearning(events),
      owner: OWNER,
      repo: REPO,
    });
    expect(events).toEqual([`supersede:${id}`]);
    expect(labels.get(42)).toBeUndefined();
    expect(await ledger.statusOf(id)).toBe('superseded');
  });
});

describe('runFindingDismissalConsumer — comment pagination', () => {
  it('finds a DecisionResponse on page 2 (past the first 100 comments)', async () => {
    const events: string[] = [];
    const id = fid(42, 'correctness');
    const ledger = new FakeFindingLedger(events);
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    // 100 filler comments (a full first page) then the operator's answer on page 2.
    const filler: CommentLike[] = Array.from({ length: 100 }, (_, i) => ({ body: `noise ${i}` }));
    const { octokit, labels } = makeOctokit(
      { 42: { state: 'open', comments: [...filler, operatorAnswer(id, 'reject')] } },
      events,
    );
    const applied = await runFindingDismissalConsumer({
      ledger,
      octokit,
      operatorLearning: recordingLearning(events),
      owner: OWNER,
      repo: REPO,
    });
    expect(applied).toBe(1);
    expect(labels.get(42)).toEqual(new Set(['dismissed']));
    expect(await ledger.statusOf(id)).toBe('resumed');
  });
});

describe('runFindingDismissalConsumer — selection (disjoint from resumeParkedRuns)', () => {
  it('processes ONLY finding-dismissal rows; an l2-gate / integrate row is untouched', async () => {
    const events: string[] = [];
    const findingId = fid(42, 'correctness');
    const ledger = new FakeFindingLedger(events);
    // A run-bound l2-gate row + an integrate row also sit in pending() — these are
    // resumeParkedRuns' job and the consumer must NEVER drive them.
    ledger.seed({ decision_id: 'issue-9:l2-gate:1', status: 'notified', source_url: SRC(9), options: ['approve', 'reject'] });
    ledger.seed({ decision_id: 'issue-5:integrate:1', status: 'notified', source_url: SRC(5), options: ['approve', 'reject'] });
    ledger.seed({ decision_id: findingId, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    const { octokit } = makeOctokit(
      {
        42: { state: 'open', comments: [operatorAnswer(findingId, 'reject')] },
        // even if the run issues had answers, they must not be answered by THIS consumer
        9: { state: 'open', comments: [operatorAnswer('issue-9:l2-gate:1', 'approve')] },
        5: { state: 'open', comments: [operatorAnswer('issue-5:integrate:1', 'approve')] },
      },
      events,
    );
    await runFindingDismissalConsumer({
      ledger,
      octokit,
      operatorLearning: recordingLearning(events),
      owner: OWNER,
      repo: REPO,
    });
    // ONLY the finding row was answered + terminalized.
    expect(events.filter((e) => e.startsWith('answer:'))).toEqual([`answer:${findingId}:reject`]);
    expect(await ledger.statusOf('issue-9:l2-gate:1')).toBe('notified'); // untouched
    expect(await ledger.statusOf('issue-5:integrate:1')).toBe('notified'); // untouched
    expect(await ledger.statusOf(findingId)).toBe('resumed');
  });

  it('ignores a finding row whose source_url belongs to a different repo', async () => {
    const events: string[] = [];
    const id = fid(42, 'correctness');
    const ledger = new FakeFindingLedger(events);
    ledger.seed({ decision_id: id, status: 'notified', source_url: 'https://github.com/other/repo/issues/42', options: ['approve', 'reject'] });
    const { octokit } = makeOctokit({ 42: { state: 'open', comments: [operatorAnswer(id, 'reject')] } }, events);
    const applied = await runFindingDismissalConsumer({
      ledger,
      octokit,
      operatorLearning: recordingLearning(events),
      owner: OWNER,
      repo: REPO,
    });
    expect(applied).toBe(0);
    expect(events).toEqual([]);
  });
});

describe('runFindingDismissalConsumer — crash-before-terminalize replay (real learning service)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finding-dismissal-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-applies idempotently and a DUPLICATE observe does NOT inflate confidence', async () => {
    const id = fid(42, 'correctness');
    const ledger = new FakeFindingLedger();
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    const { octokit, labels, auditCount } = makeOctokit({
      42: { state: 'open', comments: [operatorAnswer(id, 'reject')] },
    });

    // REAL learning service over a temp dir — the dedup-by-sourceDecisionId is the
    // production preference engine, not a fake.
    const learning = new OperatorLearningService({
      logPath: join(dir, 'observations.jsonl'),
      proposalDir: join(dir, 'proposals'),
    });
    await learning.init();

    // RUN 1: crash AFTER the durable writes + answer, BEFORE terminalize
    // (advanceToResumed throws once). The verdict + observation are already durable.
    const realAdvance = ledger.advanceToResumed.bind(ledger);
    let crashed = false;
    ledger.advanceToResumed = async (decisionId: string) => {
      if (!crashed) {
        crashed = true;
        throw new Error('simulated crash before terminalize');
      }
      return realAdvance(decisionId);
    };
    await runFindingDismissalConsumer({ ledger, octokit, operatorLearning: learning, owner: OWNER, repo: REPO });
    // Row is NOT terminal — it survived the crash for re-processing.
    expect(await ledger.statusOf(id)).toBe('answered_pending_source_write');

    // RUN 2: replay completes the durable chain.
    await runFindingDismissalConsumer({ ledger, octokit, operatorLearning: learning, owner: OWNER, repo: REPO });
    expect(await ledger.statusOf(id)).toBe('resumed');

    // Idempotent labels (single entry) + single audit comment despite two runs.
    expect(labels.get(42)).toEqual(new Set(['dismissed']));
    expect(auditCount()).toBe(1);

    // The DUPLICATE observe (one per run) is deduped by sourceDecisionId → exactly
    // one counted observation, so confidence is NOT inflated.
    const pref = await learning.getPreference('finding_dismissal:correctness', `${OWNER}/${REPO}`);
    expect(pref.evidenceSummary.totalObservations).toBe(1);
    expect(pref.evidenceSummary.distinctSources).toBe(1);
    expect(pref.mostFrequentChoice).toBe('reject');
  });
});
