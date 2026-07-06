import { describe, expect, it } from 'vitest';
import { __test_repoCoordsFromDecisionSource as repoCoordsFromDecisionSource } from './daemon.js';

describe('repoCoordsFromDecisionSource', () => {
  it('resolves an /issues/ URL (merge-decision park)', () => {
    expect(
      repoCoordsFromDecisionSource(
        'issue-841:integrate:1',
        'https://github.com/DANIELSOCRAHANDLEZZ/runforge/issues/841',
      ),
    ).toEqual({ owner: 'DANIELSOCRAHANDLEZZ', repo: 'runforge', issueNumber: 841 });
  });

  it('maps a legacy /pull/ reversal source URL back to the original run issue', () => {
    // Regression: the answer endpoint must post where resumeParkedRuns polls
    // comments. For a reversal decision that is the original run issue, not the
    // revert PR thread from source_url.
    expect(
      repoCoordsFromDecisionSource(
        'issue-841:reversal-raised:1:abcdef12',
        'https://github.com/DANIELSOCRAHANDLEZZ/runforge/pull/849',
      ),
    ).toEqual({ owner: 'DANIELSOCRAHANDLEZZ', repo: 'runforge', issueNumber: 841 });
  });

  it('tolerates a trailing path/fragment/query after the number', () => {
    expect(
      repoCoordsFromDecisionSource(
        'issue-7:reversal-raised:1:abcdef12',
        'https://github.com/o/r/pull/12#issuecomment-5',
      ),
    ).toEqual({ owner: 'o', repo: 'r', issueNumber: 7 });
    expect(
      repoCoordsFromDecisionSource(
        'issue-7:integrate:1',
        'https://github.com/o/r/issues/7?foo=bar',
      ),
    ).toEqual({ owner: 'o', repo: 'r', issueNumber: 7 });
  });

  it('returns null for unsupported source URLs', () => {
    expect(
      repoCoordsFromDecisionSource(
        'issue-841:integrate:1',
        'https://github.com/DANIELSOCRAHANDLEZZ/runforge/pull/849',
      ),
    ).toBeNull();
    expect(
      repoCoordsFromDecisionSource(
        'issue-841:integrate:1',
        'https://github.com/DANIELSOCRAHANDLEZZ/runforge/commit/abc',
      ),
    ).toBeNull();
    expect(
      repoCoordsFromDecisionSource('issue-841:integrate:1', 'https://example.com/not-github'),
    ).toBeNull();
  });
});
