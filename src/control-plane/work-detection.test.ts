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
