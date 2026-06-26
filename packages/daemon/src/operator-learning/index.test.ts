import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  OperatorLearningService,
  type InboxItem,
  type OperatorLearningConfig,
} from './index.js';

async function makeService(
  overrides?: Partial<OperatorLearningConfig>,
): Promise<{ service: OperatorLearningService; dir: string; logPath: string; proposalDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'op-learning-'));
  const logPath = join(dir, 'operator-learning.jsonl');
  const proposalDir = join(dir, 'proposals');
  const service = new OperatorLearningService({
    logPath,
    proposalDir,
    ...overrides,
  });
  await service.init();
  return { service, dir, logPath, proposalDir };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function seedApprovals(
  service: OperatorLearningService,
  decisionClass: string,
  context: string,
  count: number,
  prefix: string,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await service.observeDecisionAnswer({
      decisionClass,
      context,
      sourceDecisionId: `${prefix}-${i}`,
      chosenOption: 'approve',
      recommendedOption: 'approve',
    });
  }
}

describe('OperatorLearningService', () => {
  describe('observations and preference derivation', () => {
    it('starts with zero-confidence surface preference', async () => {
      const { service } = await makeService();
      const pref = await service.getPreference('low-risk-dep', 'deployment-a');
      expect(pref.rung).toBe('surface');
      expect(pref.confidence).toBe(0);
      expect(pref.evidenceSummary.totalObservations).toBe(0);
    });

    it('raises confidence but holds at pre-fill until a proposal is approved', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 8; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: `d-${i}`,
          chosenOption: 'approve',
          recommendedOption: 'approve',
        });
      }
      const pref = await service.getPreference('low-risk-dep', 'deployment-a');
      expect(pref.confidence).toBeGreaterThan(0.85);
      expect(pref.mostFrequentChoice).toBe('approve');
      // Strong evidence is eligible to PROPOSE ask-less, but the active rung
      // must stay pre-fill until an AskLessProposal is actually approved.
      expect(pref.rung).toBe('pre-fill');
    });

    it('advances to propose-ask-less only after a proposal is approved', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 8; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: `d-${i}`,
          chosenOption: 'approve',
          recommendedOption: 'approve',
        });
      }
      // Before approval: pre-fill.
      expect((await service.getPreference('low-risk-dep', 'deployment-a')).rung).toBe('pre-fill');

      const proposal = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      expect(proposal).toBeDefined();
      await service.approveAskLessProposal(proposal!.id);

      // After approval: the active rung becomes propose-ask-less.
      const pref = await service.getPreference('low-risk-dep', 'deployment-a');
      expect(pref.rung).toBe('propose-ask-less');

      // Ranking must reflect the same active rung once approved.
      const ranked = await service.rankInboxItems([
        { decisionId: 'x', decisionClass: 'low-risk-dep', context: 'deployment-a', basePriority: 1 },
      ]);
      expect(ranked[0]!.explanation.rung).toBe('propose-ask-less');
    });

    it('requires distinct sources to advance rung', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 5; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: 'same-source',
          chosenOption: 'approve',
        });
      }
      const pref = await service.getPreference('low-risk-dep', 'deployment-a');
      expect(pref.rung).toBe('surface');
    });

    it('does not inflate confidence when the same sourceDecisionId is re-emitted', async () => {
      const { service } = await makeService();
      // A daemon retry re-emits the same decision (d-1) four times, plus one
      // other distinct source. Naive counting would see 5 observations / 2
      // sources and could cross thresholds; deduped it is 2 observations.
      for (let i = 0; i < 4; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: 'd-1',
          chosenOption: 'approve',
        });
      }
      await service.observeDecisionAnswer({
        decisionClass: 'low-risk-dep',
        context: 'deployment-a',
        sourceDecisionId: 'd-2',
        chosenOption: 'approve',
      });
      const pref = await service.getPreference('low-risk-dep', 'deployment-a');
      expect(pref.evidenceSummary.totalObservations).toBe(2);
      expect(pref.evidenceSummary.matchingChoices).toBe(2);
      expect(pref.evidenceSummary.distinctSources).toBe(2);
      // 2 observations is below pre-fill's minObservations (3): stays surface.
      expect(pref.rung).toBe('surface');
    });

    it('never advances l2_gate or merge_decision past surface (guarded by default)', async () => {
      const { service } = await makeService();
      for (const decisionClass of ['l2_gate', 'merge_decision'] as const) {
        for (let i = 0; i < 10; i += 1) {
          await service.observeDecisionAnswer({
            decisionClass,
            context: 'owner/repo',
            sourceDecisionId: `${decisionClass}-d-${i}`,
            chosenOption: 'approve',
          });
        }
        const pref = await service.getPreference(decisionClass, 'owner/repo');
        expect(pref.rung).toBe('surface');
      }
    });

    it('lowers confidence and stays cautious after contradiction', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 4; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: `d-${i}`,
          chosenOption: 'approve',
        });
      }
      await service.observeDecisionAnswer({
        decisionClass: 'low-risk-dep',
        context: 'deployment-a',
        sourceDecisionId: 'd-contradict',
        chosenOption: 'reject',
      });
      const pref = await service.getPreference('low-risk-dep', 'deployment-a');
      expect(pref.rung).toBe('surface');
      expect(pref.confidence).toBeLessThan(0.9);
    });

    it('never advances guarded classes past surface', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 10; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'safety_critical',
          context: 'deployment-a',
          sourceDecisionId: `d-${i}`,
          chosenOption: 'approve',
        });
      }
      const pref = await service.getPreference('safety_critical', 'deployment-a');
      expect(pref.rung).toBe('surface');
    });
  });

  describe('inbox ranking', () => {
    it('never drops items', async () => {
      const { service } = await makeService();
      const items: InboxItem[] = [
        { decisionId: 'a', decisionClass: 'safety_critical', context: 'deployment-a', basePriority: 1 },
        { decisionId: 'b', decisionClass: 'low-risk-dep', context: 'deployment-a', basePriority: 2 },
      ];
      const ranked = await service.rankInboxItems(items);
      expect(ranked).toHaveLength(2);
    });

    it('boosts learned classes above higher base priority items', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 5; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: `d-${i}`,
          chosenOption: 'approve',
        });
      }
      const items: InboxItem[] = [
        { decisionId: 'a', decisionClass: 'low-risk-dep', context: 'deployment-a', basePriority: 5 },
        { decisionId: 'b', decisionClass: 'other', context: 'deployment-a', basePriority: 5 },
      ];
      const ranked = await service.rankInboxItems(items);
      expect(ranked[0]!.decisionId).toBe('a');
    });

    it('ranks novel items at base priority', async () => {
      const { service } = await makeService();
      const items: InboxItem[] = [
        { decisionId: 'a', decisionClass: 'novel-class', context: 'deployment-a', basePriority: 3 },
        { decisionId: 'b', decisionClass: 'other', context: 'deployment-a', basePriority: 2 },
      ];
      const ranked = await service.rankInboxItems(items);
      expect(ranked[0]!.decisionId).toBe('a');
      expect(ranked[0]!.explanation.confidence).toBe(0);
    });
  });

  describe('pull-time relevance', () => {
    it('selects by learned attention within context', async () => {
      const { service } = await makeService();
      await service.observeReRankAction({
        decisionClass: 'low-risk-dep',
        context: 'deployment-a',
        action: 'pin',
      });
      const candidates: InboxItem[] = [
        { decisionId: 'a', decisionClass: 'low-risk-dep', context: 'deployment-a', basePriority: 5 },
        { decisionId: 'b', decisionClass: 'other', context: 'deployment-a', basePriority: 5 },
      ];
      const result = await service.getPullTimeRelevance(candidates, 'deployment-a');
      expect(result?.item.decisionId).toBe('a');
      expect(result?.reason).toContain('low-risk-dep');
    });
  });

  describe('reset and audit', () => {
    it('reset clears learned preference for one class/context pair', async () => {
      const { service } = await makeService();
      await service.observeDecisionAnswer({
        decisionClass: 'low-risk-dep',
        context: 'deployment-a',
        sourceDecisionId: 'd-1',
        chosenOption: 'approve',
      });
      await service.reset('low-risk-dep', 'deployment-a');
      const pref = await service.getPreference('low-risk-dep', 'deployment-a');
      expect(pref.evidenceSummary.totalObservations).toBe(0);
      const audit = await service.audit({ decisionClass: 'low-risk-dep', context: 'deployment-a' });
      expect(audit).toHaveLength(1);
    });

    it('reset only affects the requested class/context', async () => {
      const { service } = await makeService();
      await service.observeDecisionAnswer({
        decisionClass: 'low-risk-dep',
        context: 'deployment-b',
        sourceDecisionId: 'd-1',
        chosenOption: 'approve',
      });
      await service.reset('low-risk-dep', 'deployment-a');
      const pref = await service.getPreference('low-risk-dep', 'deployment-b');
      expect(pref.evidenceSummary.totalObservations).toBe(1);
    });
  });

  describe('ask-less proposals', () => {
    it('creates a proposal when threshold is crossed', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 8; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: `d-${i}`,
          chosenOption: 'approve',
        });
      }
      const proposal = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      expect(proposal).toBeDefined();
      expect(proposal?.status).toBe('pending');
    });

    it('does not create duplicate pending proposals', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 8; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: `d-${i}`,
          chosenOption: 'approve',
        });
      }
      const first = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      const second = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      expect(first).toBeDefined();
      expect(second).toBeUndefined();
    });

    it('does not create a duplicate proposal once one is approved', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 8; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: `d-${i}`,
          chosenOption: 'approve',
        });
      }
      const first = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      expect(first).toBeDefined();
      await service.approveAskLessProposal(first!.id);
      // Same (still-strong) evidence must not spawn a second proposal for an
      // already-approved class/context.
      const second = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      expect(second).toBeUndefined();
      const all = await service.scanAskLessProposals();
      expect(all).toHaveLength(1);
    });

    it('approving a proposal updates status', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 8; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: `d-${i}`,
          chosenOption: 'approve',
        });
      }
      const proposal = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      const approved = await service.approveAskLessProposal(proposal!.id);
      expect(approved?.status).toBe('approved');
      expect(approved?.approvedAt).toBeDefined();
    });

    it('rejection sets cooldown', async () => {
      const { service } = await makeService();
      for (let i = 0; i < 8; i += 1) {
        await service.observeDecisionAnswer({
          decisionClass: 'low-risk-dep',
          context: 'deployment-a',
          sourceDecisionId: `d-${i}`,
          chosenOption: 'approve',
        });
      }
      const proposal = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      const rejected = await service.rejectAskLessProposal(proposal!.id);
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.cooldownUntil).toBeGreaterThan(Date.now());
    });
  });

  describe('reset/revert invalidate an approved ask-less proposal', () => {
    it('returns the rung to cautious pre-fill after reset until a NEW proposal is approved', async () => {
      const { service } = await makeService();
      await seedApprovals(service, 'low-risk-dep', 'deployment-a', 8, 'd');
      const proposal = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      await service.approveAskLessProposal(proposal!.id);
      // Sanity: approval put us at the active ask-less rung.
      expect((await service.getPreference('low-risk-dep', 'deployment-a')).rung).toBe('propose-ask-less');

      // Operator resets the learned bias; the preference must go back to a clean,
      // cautious state.
      await service.reset('low-risk-dep', 'deployment-a');
      await sleep(5);

      // Fresh observations re-cross the ask-less thresholds...
      await seedApprovals(service, 'low-risk-dep', 'deployment-a', 8, 'r');

      // ...but the stale (pre-reset) approval must NOT auto-restore propose-ask-less.
      // The rung returns to pre-fill (cautious) until a NEW proposal is approved.
      const pref = await service.getPreference('low-risk-dep', 'deployment-a');
      expect(pref.rung).toBe('pre-fill');

      // Ranking must reflect the same cautious rung — not propose-ask-less.
      const ranked = await service.rankInboxItems([
        { decisionId: 'x', decisionClass: 'low-risk-dep', context: 'deployment-a', basePriority: 1 },
      ]);
      expect(ranked[0]!.explanation.rung).toBe('pre-fill');
    });

    it('returns the rung to cautious pre-fill after revert until a NEW proposal is approved', async () => {
      const { service } = await makeService();
      await seedApprovals(service, 'low-risk-dep', 'deployment-a', 8, 'd');
      const proposal = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      await service.approveAskLessProposal(proposal!.id);
      expect((await service.getPreference('low-risk-dep', 'deployment-a')).rung).toBe('propose-ask-less');

      await service.revert('low-risk-dep', 'deployment-a');
      await sleep(5);
      await seedApprovals(service, 'low-risk-dep', 'deployment-a', 8, 'r');

      const pref = await service.getPreference('low-risk-dep', 'deployment-a');
      expect(pref.rung).toBe('pre-fill');
    });

    it('allows a fresh proposal after reset and only a NEW approval restores propose-ask-less', async () => {
      const { service } = await makeService();
      await seedApprovals(service, 'low-risk-dep', 'deployment-a', 8, 'd');
      const first = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      await service.approveAskLessProposal(first!.id);

      await service.reset('low-risk-dep', 'deployment-a');
      await sleep(5);
      await seedApprovals(service, 'low-risk-dep', 'deployment-a', 8, 'r');

      // The stale approved proposal must NOT block a fresh proposal (otherwise the
      // operator could never re-authorize ask-less after a reset).
      const second = await service.maybeProposeAskLess('low-risk-dep', 'deployment-a');
      expect(second).toBeDefined();
      expect(second!.id).not.toBe(first!.id);
      expect(second!.status).toBe('pending');

      // Before re-approval the rung is still cautious.
      expect((await service.getPreference('low-risk-dep', 'deployment-a')).rung).toBe('pre-fill');

      // Only the NEW operator approval restores the active ask-less rung.
      await service.approveAskLessProposal(second!.id);
      expect((await service.getPreference('low-risk-dep', 'deployment-a')).rung).toBe('propose-ask-less');
    });
  });

  describe('sensitive observations', () => {
    it('stores sensitive flag without exposing content', async () => {
      const { service, logPath } = await makeService();
      await service.observeDecisionAnswer({
        decisionClass: 'low-risk-dep',
        context: 'deployment-a',
        sourceDecisionId: 'd-1',
        chosenOption: 'approve',
        sensitive: true,
      });
      const raw = await readFile(logPath, 'utf-8');
      expect(raw).toContain('"sensitive":true');
      const pref = await service.getPreference('low-risk-dep', 'deployment-a');
      expect(pref.evidenceSummary.totalObservations).toBe(1);
    });
  });
});
