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
  type EmitLearning,
  type ReviewFindingIssue,
} from './emit.js';
import { buildFindingDismissalDecisionId } from './build-request.js';
import { OperatorLearningService } from '../../operator-learning/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OCTOKIT = {} as unknown as PublisherOctokit;

function fakePublisher(events: string[], posted = true, reason?: string): EmitPublisher {
  return {
    ensure: async (args) => {
      events.push(`publish:${args.issueNumber}`);
      return posted ? { posted: true } : { posted: false, reason };
    },
  };
}

/** A fake EmitLearning that returns a fixed preference (or throws) for every lookup. */
function fakeLearning(
  pref:
    | { rung: 'surface' | 'pre-fill' | 'propose-ask-less'; mostFrequentChoice?: string; confidence: number }
    | Error,
): EmitLearning {
  return {
    getPreference: async (_decisionClass: string, _context: string) => {
      if (pref instanceof Error) throw pref;
      return pref;
    },
  };
}

/** The default "no pre-fill" learning surface (rung 'surface') for the PR1-shape tests. */
const surfaceLearning: EmitLearning = fakeLearning({ rung: 'surface', confidence: 0.9 });

/** Capture the raised request so pre-fill assertions can read recommended_option + detail. */
function capturingLedger(events: string[]): {
  ledger: FakeFindingLedger;
  lastRaised: () => Record<string, unknown> | undefined;
} {
  const ledger = new FakeFindingLedger(events);
  let raised: Record<string, unknown> | undefined;
  const realRaise = ledger.raise.bind(ledger);
  ledger.raise = async (rawRequest: unknown) => {
    raised = rawRequest as Record<string, unknown>;
    return realRaise(rawRequest);
  };
  return { ledger, lastRaised: () => raised };
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
      operatorLearning: surfaceLearning,
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
      operatorLearning: surfaceLearning,
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
      operatorLearning: surfaceLearning,
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
      operatorLearning: surfaceLearning,
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
    operatorLearning: surfaceLearning,
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

describe('emitFindingDismissalDecision — rung-2 pre-fill (PR2)', () => {
  /** Emit once with the given learning surface; return the raised request + result. */
  async function emitWith(
    learning: EmitLearning,
    category: 'correctness' | 'security' | 'performance' = 'correctness',
  ): Promise<{ raised: Record<string, unknown> | undefined; emitted: boolean; events: string[] }> {
    const events: string[] = [];
    const { ledger, lastRaised } = capturingLedger(events);
    const result = await emitFindingDismissalDecision({
      ledger,
      operatorLearning: learning,
      publisher: fakePublisher(events),
      octokit: OCTOKIT,
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
      category,
      riskClass: 'P1',
    });
    return { raised: lastRaised(), emitted: result.emitted, events };
  }

  it("rung 'pre-fill' + mostFrequentChoice 'reject' → recommended_option 'reject' + a reason on the reject option", async () => {
    const { raised, emitted } = await emitWith(
      fakeLearning({ rung: 'pre-fill', mostFrequentChoice: 'reject', confidence: 0.82 }),
    );
    expect(emitted).toBe(true);
    expect(raised?.recommended_option).toBe('reject');
    const options = raised?.options as Array<{ id: string; detail?: string }>;
    const reject = options.find((o) => o.id === 'reject')!;
    const approve = options.find((o) => o.id === 'approve')!;
    expect(reject.detail).toContain('Recommended: dismiss');
    expect(reject.detail).toContain('82%'); // confidence 0.82 → 82%
    // structured, allowlisted reason — no finding free-text.
    expect(reject.detail).toContain('learned from your consistent prior decisions');
    expect(approve.detail).toBeUndefined();
  });

  it("rung 'pre-fill' + mostFrequentChoice 'approve' → recommended_option 'approve' + 'Recommended: keep'", async () => {
    const { raised } = await emitWith(
      fakeLearning({ rung: 'pre-fill', mostFrequentChoice: 'approve', confidence: 0.95 }),
    );
    expect(raised?.recommended_option).toBe('approve');
    const options = raised?.options as Array<{ id: string; detail?: string }>;
    expect(options.find((o) => o.id === 'approve')!.detail).toContain('Recommended: keep');
    expect(options.find((o) => o.id === 'approve')!.detail).toContain('95%');
  });

  it("rung 'propose-ask-less' also pre-fills (rung !== surface)", async () => {
    const { raised } = await emitWith(
      fakeLearning({ rung: 'propose-ask-less', mostFrequentChoice: 'reject', confidence: 0.92 }),
    );
    expect(raised?.recommended_option).toBe('reject');
  });

  it("rung 'surface' → NO pre-fill (recommended_option unset, no option detail)", async () => {
    const { raised } = await emitWith(
      fakeLearning({ rung: 'surface', mostFrequentChoice: 'reject', confidence: 0.99 }),
    );
    expect(raised?.recommended_option).toBeUndefined();
    const options = raised?.options as Array<{ id: string; detail?: string }>;
    expect(options.every((o) => o.detail === undefined)).toBe(true);
  });

  it('mostFrequentChoice ABSENT → no pre-fill even at pre-fill rung', async () => {
    const { raised } = await emitWith(fakeLearning({ rung: 'pre-fill', confidence: 0.9 }));
    expect(raised?.recommended_option).toBeUndefined();
  });

  it("mostFrequentChoice OFF-MENU (e.g. 'maybe') → no pre-fill (option-id validated)", async () => {
    const { raised } = await emitWith(
      fakeLearning({ rung: 'pre-fill', mostFrequentChoice: 'maybe', confidence: 0.9 }),
    );
    expect(raised?.recommended_option).toBeUndefined();
  });

  it('guarded security (rung capped at surface) → NEVER pre-fills, even with strong evidence', async () => {
    // derivePreference caps a guarded class at 'surface'; a faithful fake returns
    // rung 'surface' for security regardless of the (strong) choice/confidence.
    const { raised } = await emitWith(
      fakeLearning({ rung: 'surface', mostFrequentChoice: 'reject', confidence: 0.99 }),
      'security',
    );
    expect(raised?.recommended_option).toBeUndefined();
  });

  it('REAL guard: a live OperatorLearningService caps finding_dismissal:security at surface despite strong evidence (control: correctness DOES earn a pre-fill)', async () => {
    // codex: prove the ACTUAL guard, not just the emit gate — wire a real
    // OperatorLearningService (DEFAULT_GUARDED_CLASSES ⊇ finding_dismissal:security)
    // with strong, unanimous dismiss evidence, and show security stays capped while
    // the same evidence earns a pre-fill for the non-guarded correctness class.
    const dir = mkdtempSync(join(tmpdir(), 'finding-dismissal-guard-'));
    try {
      const learning = new OperatorLearningService({
        logPath: join(dir, 'observations.jsonl'),
        proposalDir: join(dir, 'proposals'),
      });
      await learning.init();

      // 4 distinct-source unanimous 'reject' observations — well past the pre-fill
      // thresholds (minObservations 3 / minDistinctSources 2) — for BOTH a guarded
      // (security) and a non-guarded (correctness) class.
      for (let i = 0; i < 4; i += 1) {
        for (const cat of ['security', 'correctness'] as const) {
          await learning.observeDecisionAnswer({
            decisionClass: `finding_dismissal:${cat}`,
            context: 'acme/widgets',
            sourceDecisionId: `finding-acme/widgets#${i}:finding-dismissal:${cat}:1`,
            chosenOption: 'reject',
          });
        }
      }

      // CONTROL: the SAME evidence earns a real pre-fill for the non-guarded class.
      const correctnessPref = await learning.getPreference('finding_dismissal:correctness', 'acme/widgets');
      expect(correctnessPref.rung).not.toBe('surface');
      expect(correctnessPref.mostFrequentChoice).toBe('reject');

      // GUARD: the guarded class is capped at surface by derivePreference.
      const securityPref = await learning.getPreference('finding_dismissal:security', 'acme/widgets');
      expect(securityPref.rung).toBe('surface');

      // END-TO-END through emit: security NEVER pre-fills; correctness DOES ('reject').
      const security = await emitWith(learning, 'security');
      expect(security.raised?.recommended_option).toBeUndefined();
      const correctness = await emitWith(learning, 'correctness');
      expect(correctness.raised?.recommended_option).toBe('reject');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FAIL-OPEN: getPreference THROWS → the request is STILL raised with NO pre-fill', async () => {
    const { raised, emitted } = await emitWith(
      fakeLearning(new Error('learning read blew up')),
    );
    // the decision is never dropped — it is raised + notified as normal…
    expect(emitted).toBe(true);
    // …just with no pre-fill hint.
    expect(raised?.recommended_option).toBeUndefined();
    const options = raised?.options as Array<{ id: string; detail?: string }>;
    expect(options.every((o) => o.detail === undefined)).toBe(true);
  });

  it('FAIL-OPEN throw does NOT propagate to the scan (the finding is not skipped)', async () => {
    const events: string[] = [];
    const results = await scanAndEmitFindingDismissals({
      listReviewFindings: async () => [{ issueNumber: 42, labels: ['correctness', 'P1'] }],
      allowlist: ['correctness'],
      ledger: new FakeFindingLedger(events),
      operatorLearning: fakeLearning(new Error('boom')),
      publisher: fakePublisher(events),
      octokit: OCTOKIT,
      owner: 'acme',
      repo: 'widgets',
    });
    // the finding was emitted (not swallowed by the scan's per-finding catch).
    expect(results.filter((r) => r.emitted)).toHaveLength(1);
  });
});

describe('emitFindingDismissalDecision — detected-retry pre-fill hydration (PR2, no drift)', () => {
  // A `detected` row was already raised (immutable per decision_id) but publish failed;
  // a later tick retries. The republished block MUST mirror the STORED pre-fill, never a
  // recompute from a since-drifted preference — the dashboard, recommendedOptionOf(), and
  // matchedRecommendation all read the stored row, so a divergent block would lie.
  async function retryEmit(
    seededRecommendedOption: 'approve' | 'reject' | undefined,
    driftedLearning: EmitLearning,
    issueNumber: number,
  ): Promise<Record<string, unknown> | undefined> {
    const events: string[] = [];
    const { ledger, lastRaised } = capturingLedger(events);
    const id = buildFindingDismissalDecisionId('acme', 'widgets', issueNumber, 'correctness', FINDING_DISMISSAL_EMIT_EPOCH);
    ledger.seed({
      decision_id: id,
      status: 'detected', // raised but never surfaced — publish failed the first time
      source_url: `https://github.com/acme/widgets/issues/${issueNumber}`,
      options: ['approve', 'reject'],
      ...(seededRecommendedOption !== undefined ? { recommendedOption: seededRecommendedOption } : {}),
    });
    const result = await emitFindingDismissalDecision({
      ledger,
      operatorLearning: driftedLearning,
      publisher: fakePublisher(events),
      octokit: OCTOKIT,
      owner: 'acme',
      repo: 'widgets',
      issueNumber,
      category: 'correctness',
      riskClass: 'P1',
    });
    expect(result.emitted).toBe(true);
    return lastRaised();
  }

  it("reject → none drift: republishes the STORED 'reject' (ignores the now-surface preference)", async () => {
    const raised = await retryEmit(
      'reject',
      fakeLearning({ rung: 'surface', mostFrequentChoice: 'reject', confidence: 0.99 }),
      42,
    );
    expect(raised?.recommended_option).toBe('reject');
    // the reason rides the recommended option's detail (hydrated, structured, allowlisted).
    const reject = (raised?.options as Array<{ id: string; detail?: string }>).find((o) => o.id === 'reject')!;
    expect(reject.detail).toContain('Recommended: dismiss');
  });

  it('none → reject drift: republishes NO pre-fill (matches the stored row, ignores the now-pre-fill preference)', async () => {
    const raised = await retryEmit(
      undefined,
      fakeLearning({ rung: 'pre-fill', mostFrequentChoice: 'reject', confidence: 0.95 }),
      43,
    );
    expect(raised?.recommended_option).toBeUndefined();
    const options = raised?.options as Array<{ id: string; detail?: string }>;
    expect(options.every((o) => o.detail === undefined)).toBe(true);
  });

  it('detected retry with a FAILING stored read → does NOT publish a divergent block; skips + retries next tick', async () => {
    // codex: fail-open here would republish a NO-pre-fill block while the immutable stored
    // row still holds 'reject' (no source_etag to self-correct) — a silent divergence. The
    // fix skips publishing this tick instead (the row is already durably raised).
    const events: string[] = [];
    const { ledger } = capturingLedger(events);
    const id = buildFindingDismissalDecisionId('acme', 'widgets', 44, 'correctness', FINDING_DISMISSAL_EMIT_EPOCH);
    ledger.seed({
      decision_id: id,
      status: 'detected',
      source_url: 'https://github.com/acme/widgets/issues/44',
      options: ['approve', 'reject'],
      recommendedOption: 'reject', // the stored row HAS a recommendation…
    });
    // …but the stored read blows up on this retry.
    ledger.recommendedOptionOf = async () => {
      throw new Error('stored read blew up');
    };
    const result = await emitFindingDismissalDecision({
      ledger,
      operatorLearning: fakeLearning({ rung: 'surface', confidence: 0.9 }),
      publisher: fakePublisher(events),
      octokit: OCTOKIT,
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 44,
      category: 'correctness',
      riskClass: 'P1',
    });
    expect(result.emitted).toBe(false);
    expect(result.reason).toContain('hydrate');
    // NO block was published (no divergence) and the row stays detected for the next tick.
    expect(events.some((e) => e.startsWith('publish:'))).toBe(false);
    expect(await ledger.statusOf(id)).toBe('detected');
  });

  it('first-raise race: our fresh status read saw undefined but raise returns unchanged (a concurrent emitter won) → does NOT publish our divergent request', async () => {
    // codex: two emitters both read status===undefined and compute DIFFERENT pre-fills. The
    // winner admits the canonical row; the loser's raise returns `unchanged` (never rewrites
    // it — findings have no source_etag). Publishing the loser's fresh request would embed a
    // block diverging from the stored row. The loser must skip publishing this tick.
    const events: string[] = [];
    const { ledger } = capturingLedger(events);
    const id = buildFindingDismissalDecisionId('acme', 'widgets', 45, 'correctness', FINDING_DISMISSAL_EMIT_EPOCH);
    // The concurrent WINNER already admitted the canonical row with a 'approve' pre-fill…
    ledger.seed({
      decision_id: id,
      status: 'detected',
      source_url: 'https://github.com/acme/widgets/issues/45',
      options: ['approve', 'reject'],
      recommendedOption: 'approve',
    });
    // …but THIS emitter's status read raced BEFORE that row was visible (sees undefined), so it
    // takes the fresh-compute path and computes a DIFFERENT ('reject') pre-fill.
    ledger.statusOf = async () => undefined;
    const result = await emitFindingDismissalDecision({
      ledger,
      operatorLearning: fakeLearning({ rung: 'pre-fill', mostFrequentChoice: 'reject', confidence: 0.9 }),
      publisher: fakePublisher(events),
      octokit: OCTOKIT,
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 45,
      category: 'correctness',
      riskClass: 'P1',
    });
    // lost the race → not emitted, and crucially NO block published (no divergence with the
    // stored 'approve' row). The winner / a later detected-retry surfaces the canonical block.
    expect(result.emitted).toBe(false);
    expect(result.reason).toContain('raced');
    expect(events.some((e) => e.startsWith('publish:'))).toBe(false);
  });
});
