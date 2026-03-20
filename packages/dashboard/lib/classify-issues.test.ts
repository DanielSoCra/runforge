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
