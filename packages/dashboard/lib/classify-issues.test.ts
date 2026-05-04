import { describe, it, expect } from 'vitest';
import { classifyIssues, type GitHubIssue, type RunRecord } from './classify-issues';

function issue(number: number, labels: string[] = []): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/owner/repo/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  };
}

function run(issueNumber: number, outcome: RunRecord['outcome'], phase?: string): RunRecord {
  return {
    issue_number: issueNumber,
    repo_owner: 'owner',
    repo_name: 'repo',
    issue_title: `Issue ${issueNumber}`,
    outcome,
    current_phase: phase ?? null,
  };
}

const REPO = { owner: 'owner', name: 'repo' };

describe('classifyIssues', () => {
  it('classifies unlabelled issue as not-ready', () => {
    const cards = classifyIssues([{ ...REPO, issues: [issue(1)] }], []);
    expect(cards[0]?.column).toBe('not-ready');
  });

  it('classifies issue with ready label as ready', () => {
    const cards = classifyIssues([{ ...REPO, issues: [issue(1, ['ready'])] }], []);
    expect(cards[0]?.column).toBe('ready');
  });

  it('classifies issue with in-progress label as running', () => {
    const cards = classifyIssues([{ ...REPO, issues: [issue(1, ['in-progress'])] }], []);
    expect(cards[0]?.column).toBe('running');
  });

  it('classifies issue with stuck label as stuck', () => {
    const cards = classifyIssues([{ ...REPO, issues: [issue(1, ['stuck'])] }], []);
    expect(cards[0]?.column).toBe('stuck');
  });

  it('DB in-progress run takes priority over ready label', () => {
    const cards = classifyIssues(
      [{ ...REPO, issues: [issue(1, ['ready'])] }],
      [run(1, 'in-progress', 'planning')],
    );
    expect(cards[0]?.column).toBe('running');
    expect(cards[0]?.currentPhase).toBe('planning');
  });

  it('complete runs appear as cards even though the issue is closed (not in GitHub list)', () => {
    const cards = classifyIssues(
      [{ ...REPO, issues: [] }],
      [run(7, 'complete')],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.column).toBe('complete');
    expect(cards[0]?.issueNumber).toBe(7);
  });

  it('DB escalated run maps issue to stuck column', () => {
    const cards = classifyIssues(
      [{ ...REPO, issues: [issue(5)] }],
      [run(5, 'escalated')],
    );
    expect(cards[0]?.column).toBe('stuck');
  });

  it('DB failed run maps issue to stuck column', () => {
    const cards = classifyIssues(
      [{ ...REPO, issues: [issue(6)] }],
      [run(6, 'failed')],
    );
    expect(cards[0]?.column).toBe('stuck');
  });

  it('most recent run takes priority over older runs for the same issue', () => {
    const cards = classifyIssues(
      [{ ...REPO, issues: [issue(3, ['ready'])] }],
      [
        run(3, 'in-progress', 'planning'), // newer (first in array = newest)
        run(3, 'complete'),                // older
      ],
    );
    expect(cards[0]?.column).toBe('running');
    expect(cards[0]?.currentPhase).toBe('planning');
  });

  it('excludes complete runs from repos not in the enabled repos list (#130)', () => {
    const enabledRepo = { owner: 'owner', name: 'repo', issues: [] as GitHubIssue[] };
    const disabledRun: RunRecord = {
      issue_number: 99,
      repo_owner: 'other-owner',
      repo_name: 'disabled-repo',
      issue_title: 'Issue 99',
      outcome: 'complete',
      current_phase: null,
    };
    const enabledRun = run(7, 'complete');
    const cards = classifyIssues([enabledRepo], [disabledRun, enabledRun]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.repoOwner).toBe('owner');
    expect(cards[0]?.issueNumber).toBe(7);
  });

  it('surfaces all complete runs even when count exceeds 200 (#386)', () => {
    // Regression: page.tsx had .limit(200) on the runs query, which silently
    // dropped completed issues from the Complete column once total runs > 200.
    // The spec requires fetching ALL runs to populate the Complete column.
    const completeRuns = Array.from({ length: 250 }, (_, i) => run(i + 1, 'complete'));
    const cards = classifyIssues([{ ...REPO, issues: [] }], completeRuns);
    expect(cards).toHaveLength(250);
    expect(cards.every((c) => c.column === 'complete')).toBe(true);
  });

  it('aggregates issues from multiple repos', () => {
    const cards = classifyIssues(
      [
        { owner: 'o1', name: 'r1', issues: [issue(1)] },
        { owner: 'o2', name: 'r2', issues: [issue(2, ['ready'])] },
      ],
      [],
    );
    expect(cards).toHaveLength(2);
    const cols = cards.map((c) => c.column);
    expect(cols).toContain('not-ready');
    expect(cols).toContain('ready');
  });
});
