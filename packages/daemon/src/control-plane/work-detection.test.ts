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
});
