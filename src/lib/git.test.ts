import { describe, it, expect } from 'vitest';
import { git, parseDiffStatTotal } from './git.js';

describe('git', () => {
  it('runs git status successfully', async () => {
    const result = await git(['status', '--short']);
    expect(result.ok).toBe(true);
  });

  it('returns err for invalid git command', async () => {
    const result = await git(['not-a-real-command']);
    expect(result.ok).toBe(false);
  });

  it('accepts a cwd option', async () => {
    const result = await git(['rev-parse', '--git-dir'], '/tmp');
    // /tmp is not a git repo, so this should fail
    expect(result.ok).toBe(false);
  });
});

describe('parseDiffStatTotal', () => {
  it('parses insertions and deletions', () => {
    const stat = ' 3 files changed, 42 insertions(+), 10 deletions(-)';
    expect(parseDiffStatTotal(stat)).toBe(52);
  });

  it('handles insertions only', () => {
    const stat = ' 1 file changed, 5 insertions(+)';
    expect(parseDiffStatTotal(stat)).toBe(5);
  });

  it('handles deletions only', () => {
    const stat = ' 1 file changed, 3 deletions(-)';
    expect(parseDiffStatTotal(stat)).toBe(3);
  });

  it('returns 0 for unparseable input', () => {
    expect(parseDiffStatTotal('no stats here')).toBe(0);
  });
});
