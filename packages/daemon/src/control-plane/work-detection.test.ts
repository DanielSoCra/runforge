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
});
