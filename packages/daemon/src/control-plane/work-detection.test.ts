import { describe, it, expect, vi } from 'vitest';
import { createWorkDetector } from './work-detection.js';

// Create a mock Octokit
function mockOctokit(issues: any[] = []) {
  return {
    issues: {
      listForRepo: vi.fn().mockResolvedValue({ data: issues }),
      removeLabel: vi.fn().mockResolvedValue({}),
      addLabels: vi.fn().mockResolvedValue({}),
      createComment: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('WorkDetector', () => {
  describe('detectReadyWork', () => {
    it('returns empty array when no issues', async () => {
      const octokit = mockOctokit([]);
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectReadyWork();
      expect(result).toEqual({ ok: true, value: [] });
    });

    it('parses issues into WorkRequests', async () => {
      const octokit = mockOctokit([{
        number: 42,
        title: 'Implement feature X',
        body: 'Refs: FUNC-AC-PIPELINE, ARCH-AC-CONTROL-PLANE',
        labels: [{ name: 'ready' }],
      }]);
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectReadyWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const items = result.value;
        expect(items).toHaveLength(1);
        const item = items[0]!;
        expect(item.issueNumber).toBe(42);
        expect(item.specRefs).toContain('FUNC-AC-PIPELINE');
        expect(item.specRefs).toContain('ARCH-AC-CONTROL-PLANE');
      }
    });

    it('populates scopeDescription from issue body', async () => {
      const octokit = mockOctokit([{
        number: 99,
        title: 'Fix auth middleware',
        body: 'The auth middleware is broken when tokens expire.\n\nSteps to reproduce:\n1. Login\n2. Wait for expiry',
        labels: [{ name: 'ready' }],
      }]);
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectReadyWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const item = result.value[0]!;
        expect(item.scopeDescription).toBe('The auth middleware is broken when tokens expire.');
      }
    });

    it('extracts explicit ## Scope section as scopeDescription', async () => {
      const octokit = mockOctokit([{
        number: 100,
        title: 'Add caching layer',
        body: '# Overview\n\nSome overview text.\n\n## Scope\n\nAdd Redis caching to the API layer.\n\n## Details\n\nMore info here.',
        labels: [{ name: 'ready' }],
      }]);
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectReadyWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const item = result.value[0]!;
        expect(item.scopeDescription).toBe('Add Redis caching to the API layer.');
      }
    });

    it('captures full multi-paragraph scope section', async () => {
      const octokit = mockOctokit([{
        number: 102,
        title: 'Multi-paragraph scope',
        body: '## Scope\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Details\n\nOther.',
        labels: [{ name: 'ready' }],
      }]);
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectReadyWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value[0]!.scopeDescription).toBe(
          'First paragraph.\n\nSecond paragraph.',
        );
      }
    });

    it('sets scopeDescription to undefined for empty body', async () => {
      const octokit = mockOctokit([{
        number: 101,
        title: 'No body issue',
        body: null,
        labels: [{ name: 'ready' }],
      }]);
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectReadyWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const item = result.value[0]!;
        expect(item.scopeDescription).toBeUndefined();
      }
    });

    it('handles API errors gracefully', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockRejectedValue(new Error('API error'));
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectReadyWork();
      expect(result.ok).toBe(false);
    });
  });

  describe('claimWork', () => {
    it('swaps ready label to in-progress', async () => {
      const octokit = mockOctokit();
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.claimWork(42);
      expect(result.ok).toBe(true);
      expect(octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['in-progress'] }),
      );
    });
  });

  describe('completeWork', () => {
    it('labels complete, comments, and closes', async () => {
      const octokit = mockOctokit();
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.completeWork(42, 'Done!');
      expect(result.ok).toBe(true);
      expect(octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['complete'] }),
      );
      expect(octokit.issues.createComment).toHaveBeenCalled();
      expect(octokit.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'closed' }),
      );
    });
  });

  describe('markStuck', () => {
    it('labels stuck and comments', async () => {
      const octokit = mockOctokit();
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.markStuck(42, 'Failed');
      expect(result.ok).toBe(true);
      expect(octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['stuck'] }),
      );
    });
  });

  describe('detectBugFixWork', () => {
    it('returns null when no review-finding issues exist', async () => {
      const octokit = mockOctokit([]);
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('returns P0 review-finding issue as highest priority', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockResolvedValue({
        data: [
          { number: 10, title: 'P0 bug', body: 'critical fix', labels: [{ name: 'review-finding' }, { name: 'P0' }] },
          { number: 11, title: 'P1 bug', body: 'important fix', labels: [{ name: 'review-finding' }, { name: 'P1' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value!.issueNumber).toBe(10);
        expect(result.value!.workType).toBe('bug-fix');
      }
    });

    it('returns P1 when no P0 issues exist', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockResolvedValue({
        data: [
          { number: 20, title: 'P1 bug', body: 'important', labels: [{ name: 'review-finding' }, { name: 'P1' }] },
          { number: 21, title: 'P2 approved', body: 'minor', labels: [{ name: 'review-finding' }, { name: 'P2' }, { name: 'auto-fix-approved' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value!.issueNumber).toBe(20);
      }
    });

    it('returns P2 only if auto-fix-approved label is present', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockResolvedValue({
        data: [
          { number: 30, title: 'P2 approved', body: 'minor fix', labels: [{ name: 'review-finding' }, { name: 'P2' }, { name: 'auto-fix-approved' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value!.issueNumber).toBe(30);
      }
    });

    it('excludes P2 without auto-fix-approved', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockResolvedValue({
        data: [
          { number: 31, title: 'P2 no approval', body: 'minor', labels: [{ name: 'review-finding' }, { name: 'P2' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('never returns P3 issues', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockResolvedValue({
        data: [
          { number: 40, title: 'P3 bug', body: 'low', labels: [{ name: 'review-finding' }, { name: 'P3' }] },
          { number: 41, title: 'P3 approved', body: 'low', labels: [{ name: 'review-finding' }, { name: 'P3' }, { name: 'auto-fix-approved' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('ignores issues with no severity label', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockResolvedValue({
        data: [
          { number: 45, title: 'No severity', body: 'missing P label', labels: [{ name: 'review-finding' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('excludes issues with in-progress label', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockResolvedValue({
        data: [
          { number: 50, title: 'In progress bug', body: 'fix', labels: [{ name: 'review-finding' }, { name: 'P0' }, { name: 'in-progress' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('excludes issues with blocked label', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockResolvedValue({
        data: [
          { number: 51, title: 'Blocked bug', body: 'fix', labels: [{ name: 'review-finding' }, { name: 'P0' }, { name: 'blocked' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('excludes pull requests', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockResolvedValue({
        data: [
          { number: 60, title: 'PR', body: 'pr', labels: [{ name: 'review-finding' }, { name: 'P0' }], pull_request: { url: 'https://...' } },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('returns at most 1 issue', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockResolvedValue({
        data: [
          { number: 70, title: 'P0 a', body: 'a', labels: [{ name: 'review-finding' }, { name: 'P0' }] },
          { number: 71, title: 'P0 b', body: 'b', labels: [{ name: 'review-finding' }, { name: 'P0' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        // Should return exactly one, the first P0
        expect(result.value!.issueNumber).toBe(70);
      }
    });

    it('handles API errors gracefully', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockRejectedValue(new Error('API error'));
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectBugFixWork();
      expect(result.ok).toBe(false);
    });
  });

  describe('claimWork (bug-fix)', () => {
    it('adds in-progress without removing review-finding', async () => {
      const octokit = mockOctokit();
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.claimBugFixWork(42);
      expect(result.ok).toBe(true);
      expect(octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['in-progress'] }),
      );
      // Should NOT remove review-finding label
      expect(octokit.issues.removeLabel).not.toHaveBeenCalled();
    });
  });

  describe('completeBugFixWork', () => {
    it('removes in-progress, closes issue with commit SHA comment', async () => {
      const octokit = mockOctokit();
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.completeBugFixWork(42, 'abc1234');
      expect(result.ok).toBe(true);
      expect(octokit.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'in-progress' }),
      );
      expect(octokit.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('abc1234') }),
      );
      expect(octokit.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'closed' }),
      );
    });
  });

  describe('detectFeaturePipelineWork', () => {
    function mockOctokitForTiers(tierResults: Record<string, any[]>) {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockImplementation(({ labels }: { labels: string }) => {
        const data = tierResults[labels] ?? [];
        return Promise.resolve({ data });
      });
      return octokit;
    }

    it('returns null when no feature-pipeline issues exist in any tier', async () => {
      const octokit = mockOctokitForTiers({});
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('returns tier 1 (ready-to-implement) with workType implementation', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,ready-to-implement': [
          { number: 100, title: 'Impl task', body: 'FUNC-AC-PIPELINE ref', labels: [{ name: 'feature-pipeline' }, { name: 'ready-to-implement' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value!.issueNumber).toBe(100);
        expect(result.value!.workType).toBe('implementation');
      }
    });

    it('excludes tier 1 issues with implementing label', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,ready-to-implement': [
          { number: 101, title: 'Already implementing', body: 'spec', labels: [{ name: 'feature-pipeline' }, { name: 'ready-to-implement' }, { name: 'implementing' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('excludes tier 1 issues with blocked label', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,ready-to-implement': [
          { number: 102, title: 'Blocked', body: 'spec', labels: [{ name: 'feature-pipeline' }, { name: 'ready-to-implement' }, { name: 'blocked' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('returns tier 2 (l2-approved) with workType l3-generate', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,l2-approved': [
          { number: 200, title: 'L2 approved', body: 'ARCH-AC ref', labels: [{ name: 'feature-pipeline' }, { name: 'l2-approved' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value!.issueNumber).toBe(200);
        expect(result.value!.workType).toBe('l3-generate');
      }
    });

    it('excludes tier 2 issues with l3-in-progress label', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,l2-approved': [
          { number: 201, title: 'L3 in progress', body: 'spec', labels: [{ name: 'feature-pipeline' }, { name: 'l2-approved' }, { name: 'l3-in-progress' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('returns tier 3 (l2-in-progress) with workType l2-brainstorm', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,l2-in-progress': [
          { number: 300, title: 'L2 in progress', body: 'FUNC ref', labels: [{ name: 'feature-pipeline' }, { name: 'l2-in-progress' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value!.issueNumber).toBe(300);
        expect(result.value!.workType).toBe('l2-brainstorm');
      }
    });

    it('excludes tier 3 issues with blocked label', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,l2-in-progress': [
          { number: 301, title: 'Blocked L2', body: 'spec', labels: [{ name: 'feature-pipeline' }, { name: 'l2-in-progress' }, { name: 'blocked' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('returns tier 4 (l1-approved) with workType l2-brainstorm', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,l1-approved': [
          { number: 400, title: 'L1 approved', body: 'FUNC ref', labels: [{ name: 'feature-pipeline' }, { name: 'l1-approved' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value!.issueNumber).toBe(400);
        expect(result.value!.workType).toBe('l2-brainstorm');
      }
    });

    it('excludes tier 4 issues with l2-in-progress label', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,l1-approved': [
          { number: 401, title: 'L2 already started', body: 'spec', labels: [{ name: 'feature-pipeline' }, { name: 'l1-approved' }, { name: 'l2-in-progress' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('tier 1 has priority over tier 2', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,ready-to-implement': [
          { number: 100, title: 'Tier 1', body: 'FUNC ref', labels: [{ name: 'feature-pipeline' }, { name: 'ready-to-implement' }] },
        ],
        'feature-pipeline,l2-approved': [
          { number: 200, title: 'Tier 2', body: 'ARCH ref', labels: [{ name: 'feature-pipeline' }, { name: 'l2-approved' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value!.issueNumber).toBe(100);
        expect(result.value!.workType).toBe('implementation');
      }
    });

    it('falls through to lower tier when higher tier is empty', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,l1-approved': [
          { number: 400, title: 'Tier 4', body: 'FUNC ref', labels: [{ name: 'feature-pipeline' }, { name: 'l1-approved' }] },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value!.issueNumber).toBe(400);
      }
    });

    it('excludes pull requests', async () => {
      const octokit = mockOctokitForTiers({
        'feature-pipeline,ready-to-implement': [
          { number: 105, title: 'PR', body: 'spec', labels: [{ name: 'feature-pipeline' }, { name: 'ready-to-implement' }], pull_request: { url: 'https://...' } },
        ],
      });
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('handles API errors gracefully', async () => {
      const octokit = mockOctokit();
      octokit.issues.listForRepo = vi.fn().mockRejectedValue(new Error('API error'));
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.detectFeaturePipelineWork();
      expect(result.ok).toBe(false);
    });
  });

  describe('claimFeaturePipelineWork', () => {
    it('adds implementing label for implementation workType', async () => {
      const octokit = mockOctokit();
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.claimFeaturePipelineWork(100, 'implementation');
      expect(result.ok).toBe(true);
      expect(octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['implementing'] }),
      );
      expect(octokit.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ready-to-implement' }),
      );
    });

    it('adds l3-in-progress label for l3-generate workType', async () => {
      const octokit = mockOctokit();
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.claimFeaturePipelineWork(200, 'l3-generate');
      expect(result.ok).toBe(true);
      expect(octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['l3-in-progress'] }),
      );
    });

    it('adds l2-in-progress label for l2-brainstorm workType on l1-approved tier', async () => {
      const octokit = mockOctokit();
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.claimFeaturePipelineWork(400, 'l2-brainstorm');
      expect(result.ok).toBe(true);
      expect(octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['l2-in-progress'] }),
      );
    });

    it('handles API errors gracefully', async () => {
      const octokit = mockOctokit();
      octokit.issues.addLabels = vi.fn().mockRejectedValue(new Error('API error'));
      const detector = createWorkDetector(octokit, 'owner', 'repo');
      const result = await detector.claimFeaturePipelineWork(100, 'implementation');
      expect(result.ok).toBe(false);
    });
  });
});
