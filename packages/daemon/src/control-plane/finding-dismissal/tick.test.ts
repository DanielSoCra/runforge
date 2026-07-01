// finding-dismissal/tick.test.ts — the daemon-facing orchestrator wiring.
// Asserts the two NEW behaviors: (1) the apply-consumer runs even when the
// allowlist is EMPTY (so answered decisions never dangle — IMPORTANT-2), and the
// emit scan is skipped then; (2) the review-finding list is PAGINATED (MINOR).
// Pure: a fake Octokit + the FakeFindingLedger + a learning fake. No real GitHub.
import { describe, it, expect } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { CommentLike } from '../decision-escalation/resume-consumer.js';
import { buildDecisionResponseComment } from '../decision-escalation/answer-publisher.js';
import { FakeFindingLedger } from './__fixtures__/fake-ledger.js';
import { runFindingDismissalTick } from './tick.js';
import { buildFindingDismissalDecisionId } from './build-request.js';
import type { ConsumerLearning } from './apply-consumer.js';
import type { EmitLearning } from './emit.js';

const OWNER = 'acme';
const REPO = 'widgets';
const SRC = (n: number) => `https://github.com/${OWNER}/${REPO}/issues/${n}`;

interface TickOctokitOpts {
  findingsByPage?: Record<number, Array<{ number: number; labels: string[] }>>;
  issueState?: Record<number, string>;
  comments?: Record<number, CommentLike[]>;
  /** When set, `issues.listForRepo` REJECTS (simulates a transient GitHub error). */
  listForRepoThrows?: boolean;
}

function makeTickOctokit(opts: TickOctokitOpts): {
  octokit: Octokit;
  listForRepoCalls: () => number;
  labels: Map<number, Set<string>>;
} {
  let listForRepoCalls = 0;
  const labels = new Map<number, Set<string>>();
  const octokit = {
    paginate: undefined,
    issues: {
      listForRepo: async ({ page }: { page?: number }) => {
        listForRepoCalls += 1;
        if (opts.listForRepoThrows === true) {
          throw new Error('transient GitHub error on listForRepo');
        }
        return { data: opts.findingsByPage?.[page ?? 1] ?? [] };
      },
      get: async ({ issue_number }: { issue_number: number }) => ({
        data: { state: opts.issueState?.[issue_number] ?? 'open', body: '' },
      }),
      update: async () => undefined,
      listComments: async ({ issue_number }: { issue_number: number }) => ({
        data: opts.comments?.[issue_number] ?? [],
      }),
      addLabels: async ({ issue_number, labels: toAdd }: { issue_number: number; labels: string[] }) => {
        const set = labels.get(issue_number) ?? new Set<string>();
        for (const l of toAdd) set.add(l);
        labels.set(issue_number, set);
        return undefined;
      },
      createComment: async () => undefined,
    },
  } as unknown as Octokit;
  return { octokit, listForRepoCalls: () => listForRepoCalls, labels };
}

/**
 * The real OperatorLearningService carries BOTH the consumer (observe) and emit
 * (getPreference) surfaces; the tick dep now requires both. `getPreference` defaults
 * to a 'surface' (no pre-fill) preference unless a `pref` is supplied.
 */
const learningSink = (
  sink: string[],
  pref: { rung: 'surface' | 'pre-fill' | 'propose-ask-less'; mostFrequentChoice?: string; confidence: number } = {
    rung: 'surface',
    confidence: 0.9,
  },
): ConsumerLearning & EmitLearning => ({
  observeDecisionAnswer: async (input) => {
    sink.push(`${input.decisionClass}:${input.chosenOption}`);
  },
  getPreference: async () => pref,
});

describe('runFindingDismissalTick — consumer runs regardless of allowlist (IMPORTANT-2)', () => {
  it('with an EMPTY allowlist, still DRAINS an answered finding decision (emit is skipped)', async () => {
    const id = buildFindingDismissalDecisionId(OWNER, REPO, 42, 'correctness', 1);
    const ledger = new FakeFindingLedger();
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    const observed: string[] = [];
    const { octokit, listForRepoCalls, labels } = makeTickOctokit({
      issueState: { 42: 'open' },
      comments: { 42: [{ body: buildDecisionResponseComment(id, 'reject', 'k1') }] },
    });

    await runFindingDismissalTick({
      ledger,
      octokit,
      operatorLearning: learningSink(observed),
      owner: OWNER,
      repo: REPO,
      allowlist: [], // EMPTY — emit must be skipped, consumer must still run
    });

    // Emit skipped: no review-finding list call at all.
    expect(listForRepoCalls()).toBe(0);
    // Consumer drained the answered decision: verdict applied, observed, terminalized.
    expect(labels.get(42)).toEqual(new Set(['dismissed']));
    expect(observed).toEqual(['finding_dismissal:correctness:reject']);
    expect(await ledger.statusOf(id)).toBe('resumed');
  });

  it('emit-scan FAILURE (listForRepo rejects) does NOT prevent the consumer from draining', async () => {
    // The emit list call and the consumer must be INDEPENDENT — a transient
    // GitHub error on the review-finding list must never strand answered rows.
    const id = buildFindingDismissalDecisionId(OWNER, REPO, 42, 'correctness', 1);
    const ledger = new FakeFindingLedger();
    ledger.seed({ decision_id: id, status: 'notified', source_url: SRC(42), options: ['approve', 'reject'] });
    const observed: string[] = [];
    const { octokit, listForRepoCalls, labels } = makeTickOctokit({
      issueState: { 42: 'open' },
      comments: { 42: [{ body: buildDecisionResponseComment(id, 'reject', 'k1') }] },
      listForRepoThrows: true, // the emit half blows up
    });

    // The tick itself must NOT reject (the emit failure is isolated + logged).
    await expect(
      runFindingDismissalTick({
        ledger,
        octokit,
        operatorLearning: learningSink(observed),
        owner: OWNER,
        repo: REPO,
        allowlist: ['correctness'], // non-empty → emit IS attempted (and throws)
      }),
    ).resolves.toBeUndefined();

    // The emit half was attempted (and failed)…
    expect(listForRepoCalls()).toBe(1);
    // …but the consumer STILL ran and drained the answered finding.
    expect(labels.get(42)).toEqual(new Set(['dismissed']));
    expect(observed).toEqual(['finding_dismissal:correctness:reject']);
    expect(await ledger.statusOf(id)).toBe('resumed');
  });
});

describe('runFindingDismissalTick — review-finding list pagination (MINOR)', () => {
  it('emits for an eligible finding on PAGE 2 (past the first 100 issues)', async () => {
    const ledger = new FakeFindingLedger();
    const observed: string[] = [];
    // 100 issues on page 1 (a full page) + 1 eligible finding (#200) on page 2.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      labels: ['review-finding', 'performance'], // not in allowlist → not emitted
    }));
    const { octokit } = makeTickOctokit({
      findingsByPage: {
        1: page1,
        2: [{ number: 200, labels: ['review-finding', 'correctness', 'P1'] }],
      },
    });

    await runFindingDismissalTick({
      ledger,
      octokit,
      operatorLearning: learningSink(observed),
      owner: OWNER,
      repo: REPO,
      allowlist: ['correctness'],
    });

    // The page-2 finding was reached and surfaced (its decision is in the ledger).
    const id = buildFindingDismissalDecisionId(OWNER, REPO, 200, 'correctness', 1);
    expect(await ledger.statusOf(id)).toBe('notified');
  });
});

describe('runFindingDismissalTick — rung-2 pre-fill threaded to the emit (PR2)', () => {
  it('emits a NEW finding with recommended_option from the learned preference', async () => {
    const ledger = new FakeFindingLedger();
    const observed: string[] = [];
    const { octokit } = makeTickOctokit({
      findingsByPage: { 1: [{ number: 5, labels: ['review-finding', 'correctness', 'P1'] }] },
    });

    await runFindingDismissalTick({
      ledger,
      octokit,
      // learned pre-fill: reject at the pre-fill rung → the emit must pre-fill it.
      operatorLearning: learningSink(observed, {
        rung: 'pre-fill',
        mostFrequentChoice: 'reject',
        confidence: 0.8,
      }),
      owner: OWNER,
      repo: REPO,
      allowlist: ['correctness'],
    });

    const id = buildFindingDismissalDecisionId(OWNER, REPO, 5, 'correctness', 1);
    const row = ledger.rows.get(id);
    expect(row?.status).toBe('notified');
    // The pre-fill hint rode through emit → build-request → raise into the stored row.
    expect(row?.recommendedOption).toBe('reject');
  });
});
