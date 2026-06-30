// finding-dismissal/emit.test.ts — the bounded trigger + raise→publish→notify.
// Pure: a ledger fake + a publisher fake + an injected issue list. No GitHub/PG.
import { describe, it, expect } from 'vitest';
import type { DecisionRequest } from '@auto-claude/decision-protocol';
import type { OctokitLike as PublisherOctokit } from '../decision-escalation/github-block-notifier.js';
import { FakeFindingLedger } from './__fixtures__/fake-ledger.js';
import {
  shouldEmitFindingDismissal,
  emitFindingDismissalDecision,
  scanAndEmitFindingDismissals,
  FINDING_DISMISSAL_EMIT_EPOCH,
  type EmitPublisher,
  type ReviewFindingIssue,
} from './emit.js';
import { buildFindingDismissalDecisionId } from './build-request.js';

const OCTOKIT = {} as unknown as PublisherOctokit;

function fakePublisher(events: string[], posted = true, reason?: string): EmitPublisher {
  return {
    ensure: async (args) => {
      events.push(`publish:${args.issueNumber}`);
      return posted ? { posted: true } : { posted: false, reason };
    },
  };
}

describe('shouldEmitFindingDismissal (trigger predicate)', () => {
  it('emits when category ∈ allowlist', () => {
    expect(shouldEmitFindingDismissal(['correctness'], ['correctness'])).toEqual({
      emit: true,
      category: 'correctness',
    });
  });

  it('emits when needs-discussion is present even outside the allowlist', () => {
    expect(shouldEmitFindingDismissal(['security', 'needs-discussion'], [])).toEqual({
      emit: true,
      category: 'security',
    });
  });

  it('does NOT emit for a category outside the allowlist with no human-route', () => {
    expect(shouldEmitFindingDismissal(['performance'], ['correctness'])).toEqual({
      emit: false,
      category: 'performance',
    });
  });

  it('does NOT emit when there is no parsable category', () => {
    expect(shouldEmitFindingDismissal(['review-finding', 'needs-discussion'], ['correctness'])).toEqual({
      emit: false,
      category: null,
    });
  });
});

describe('emitFindingDismissalDecision (raise → publish → notify)', () => {
  it('drives raise → publish → notify IN ORDER and surfaces the row to the inbox', async () => {
    const events: string[] = [];
    const ledger = new FakeFindingLedger(events);
    const result = await emitFindingDismissalDecision({
      ledger,
      publisher: fakePublisher(events),
      octokit: OCTOKIT,
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
      category: 'correctness',
      riskClass: 'P1',
    });

    const id = buildFindingDismissalDecisionId('acme', 'widgets',42, 'correctness', FINDING_DISMISSAL_EMIT_EPOCH);
    expect(result).toEqual({ emitted: true, decisionId: id, reason: 'notified:notified' });
    // ORDER: raise BEFORE publish BEFORE notify (else the row never reaches /pending).
    expect(events).toEqual([`raise:${id}`, 'publish:42', `notify:${id}`]);
    // The row is now NOTIFIED — i.e. it will appear in the default pending inbox.
    expect(await ledger.statusOf(id)).toBe('notified');
  });

  it('fails closed: a non-posted publish leaves the row un-notified (retry next tick)', async () => {
    const events: string[] = [];
    const ledger = new FakeFindingLedger(events);
    const result = await emitFindingDismissalDecision({
      ledger,
      publisher: fakePublisher(events, false, 'write_failed'),
      octokit: OCTOKIT,
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
      category: 'correctness',
      riskClass: 'P1',
    });
    const id = buildFindingDismissalDecisionId('acme', 'widgets',42, 'correctness', FINDING_DISMISSAL_EMIT_EPOCH);
    expect(result.emitted).toBe(false);
    expect(events).toEqual([`raise:${id}`, 'publish:42']); // no notify
    expect(await ledger.statusOf(id)).toBe('detected'); // still un-surfaced
  });

  it('idempotent: never a second OPEN decision (status check skips an already-notified row)', async () => {
    const events: string[] = [];
    const ledger = new FakeFindingLedger(events);
    const id = buildFindingDismissalDecisionId('acme', 'widgets',42, 'correctness', FINDING_DISMISSAL_EMIT_EPOCH);
    // A prior tick already raised+notified this exact finding decision.
    ledger.seed({ decision_id: id, status: 'notified', source_url: 'x', options: ['approve', 'reject'] });

    const result = await emitFindingDismissalDecision({
      ledger,
      publisher: fakePublisher(events),
      octokit: OCTOKIT,
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
      category: 'correctness',
      riskClass: 'P1',
    });
    expect(result).toEqual({ emitted: false, decisionId: id, reason: 'already:notified' });
    expect(events).toEqual([]); // NO second raise / publish / notify
  });

  it('retries a raised-but-not-surfaced (detected) row', async () => {
    const events: string[] = [];
    const ledger = new FakeFindingLedger(events);
    const id = buildFindingDismissalDecisionId('acme', 'widgets',42, 'correctness', FINDING_DISMISSAL_EMIT_EPOCH);
    ledger.seed({ decision_id: id, status: 'detected', source_url: 'x', options: ['approve', 'reject'] });

    const result = await emitFindingDismissalDecision({
      ledger,
      publisher: fakePublisher(events),
      octokit: OCTOKIT,
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
      category: 'correctness',
      riskClass: 'P1',
    });
    expect(result.emitted).toBe(true);
    expect(events).toEqual([`raise:${id}`, 'publish:42', `notify:${id}`]); // re-publish + notify
  });
});

describe('scanAndEmitFindingDismissals (the tick scan)', () => {
  const baseDeps = (events: string[], findings: ReviewFindingIssue[], allowlist: string[]) => ({
    listReviewFindings: async () => findings,
    allowlist,
    ledger: new FakeFindingLedger(events),
    publisher: fakePublisher(events),
    octokit: OCTOKIT,
    owner: 'acme',
    repo: 'widgets',
  });

  it('emits ONLY eligible findings — not all findings', async () => {
    const events: string[] = [];
    const deps = baseDeps(
      events,
      [
        { issueNumber: 1, labels: ['review-finding', 'correctness', 'P1'] }, // allowlist → emit
        { issueNumber: 2, labels: ['review-finding', 'performance', 'P2'] }, // not allowed → skip
        { issueNumber: 3, labels: ['review-finding', 'P1'] }, // no category → skip
        { issueNumber: 4, labels: ['review-finding', 'security', 'needs-discussion'] }, // human-route → emit
      ],
      ['correctness'],
    );
    const results = await scanAndEmitFindingDismissals(deps);
    expect(results.filter((r) => r.emitted).map((r) => r.decisionId)).toEqual([
      buildFindingDismissalDecisionId('acme', 'widgets',1, 'correctness', FINDING_DISMISSAL_EMIT_EPOCH),
      buildFindingDismissalDecisionId('acme', 'widgets',4, 'security', FINDING_DISMISSAL_EMIT_EPOCH),
    ]);
    // Issues 2 and 3 never reach the ledger.
    expect(events.filter((e) => e.startsWith('raise:'))).toEqual([
      `raise:${buildFindingDismissalDecisionId('acme', 'widgets',1, 'correctness', FINDING_DISMISSAL_EMIT_EPOCH)}`,
      `raise:${buildFindingDismissalDecisionId('acme', 'widgets',4, 'security', FINDING_DISMISSAL_EMIT_EPOCH)}`,
    ]);
  });

  it('runs the input-boundary sanitizer before raising', async () => {
    const events: string[] = [];
    let sanitized = false;
    const deps = {
      ...baseDeps(events, [{ issueNumber: 1, labels: ['correctness'] }], ['correctness']),
      sanitize: async (r: DecisionRequest) => {
        sanitized = true;
        return r;
      },
    };
    await scanAndEmitFindingDismissals(deps);
    expect(sanitized).toBe(true);
  });
});
