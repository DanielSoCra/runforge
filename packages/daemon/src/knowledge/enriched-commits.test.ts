import { describe, it, expect, vi } from 'vitest';
import { consumeEnrichedCommits } from './enriched-commits.js';
import type { KnowledgeStore } from './knowledge-store.js';

const mockGit = vi.hoisted(() => vi.fn());
vi.mock('../lib/git.js', () => ({
  git: mockGit,
}));

describe('consumeEnrichedCommits', () => {
  it('returns zero when log is empty', async () => {
    mockGit.mockResolvedValue({ ok: true, value: '' });
    const store = { storeRecord: vi.fn().mockResolvedValue(0) } as unknown as KnowledgeStore;

    const result = await consumeEnrichedCommits('issue-1', 'main', 'feature', {
      knowledgeStore: store,
    });

    expect(result).toEqual({ commitsRead: 0, recordsStored: 0 });
    expect(store.storeRecord).not.toHaveBeenCalled();
  });

  it('extracts and stores markers from commit messages', async () => {
    const message = `worker(unit-1): done

<!-- KNOWLEDGE: {"artifactPatterns":["src/foo.ts"],"description":"avoid mutation"} -->`;
    mockGit.mockResolvedValue({ ok: true, value: `${message}\u0000` });
    const store = { storeRecord: vi.fn().mockResolvedValue(1) } as unknown as KnowledgeStore;

    const result = await consumeEnrichedCommits('issue-1', 'main', 'feature', {
      knowledgeStore: store,
    });

    expect(result.commitsRead).toBe(1);
    expect(result.recordsStored).toBe(1);
    expect(store.storeRecord).toHaveBeenCalledWith(
      [expect.objectContaining({ artifactPatterns: ['src/foo.ts'], description: 'avoid mutation' })],
      'issue-1',
      'autonomous',
      'technical_pitfall',
    );
  });

  it('survives git log failure', async () => {
    mockGit.mockResolvedValue({ ok: false, error: new Error('not a repo') });
    const store = { storeRecord: vi.fn() } as unknown as KnowledgeStore;

    const result = await consumeEnrichedCommits('issue-1', 'main', 'feature', {
      knowledgeStore: store,
    });

    expect(result).toEqual({ commitsRead: 0, recordsStored: 0 });
    expect(store.storeRecord).not.toHaveBeenCalled();
  });
});
