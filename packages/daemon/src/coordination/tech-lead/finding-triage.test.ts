// packages/daemon/src/coordination/tech-lead/finding-triage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyTriageDecisions, consumesCap, type TriageDecision } from './finding-triage.js';

function makeOctokit() {
  return {
    issues: {
      createComment: vi.fn().mockResolvedValue({}),
      addLabels: vi.fn().mockResolvedValue({}),
      removeLabel: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockResolvedValue({ data: { labels: [{ name: 'P3' }] } }),
    },
  } as unknown as import('@octokit/rest').Octokit;
}

describe('consumesCap', () => {
  it('returns true for approve and promote', () => {
    expect(consumesCap({ issueNumber: 1, verdict: 'approve', reason: 'r' })).toBe(true);
    expect(consumesCap({ issueNumber: 1, verdict: 'promote', reason: 'r', newSeverity: 'P1' })).toBe(true);
  });

  it('returns false for reject and defer', () => {
    expect(consumesCap({ issueNumber: 1, verdict: 'reject', reason: 'r' })).toBe(false);
    expect(consumesCap({ issueNumber: 1, verdict: 'defer', reason: 'r' })).toBe(false);
  });
});

describe('applyTriageDecisions', () => {
  let octokit: ReturnType<typeof makeOctokit>;
  const owner = 'owner';
  const repo = 'repo';

  beforeEach(() => {
    octokit = makeOctokit();
  });

  it('approves an issue with tl-approved and tl-triaged labels and a comment', async () => {
    const decisions: TriageDecision[] = [
      { issueNumber: 1, verdict: 'approve', reason: 'Valid finding' },
    ];

    const result = await applyTriageDecisions(decisions, { octokit, owner, repo }, 5);

    expect(result.applied).toBe(1);
    expect(octokit.issues.createComment).toHaveBeenCalledWith({
      owner,
      repo,
      issue_number: 1,
      body: expect.stringContaining('approved'),
    });
    expect(octokit.issues.addLabels).toHaveBeenCalledWith({
      owner,
      repo,
      issue_number: 1,
      labels: ['tl-triaged', 'tl-approved'],
    });
  });

  it('rejects an issue by adding tl-triaged and closing it', async () => {
    const decisions: TriageDecision[] = [
      { issueNumber: 2, verdict: 'reject', reason: 'Not actionable' },
    ];

    await applyTriageDecisions(decisions, { octokit, owner, repo }, 5);

    expect(octokit.issues.addLabels).toHaveBeenCalledWith({
      owner,
      repo,
      issue_number: 2,
      labels: ['tl-triaged'],
    });
    expect(octokit.issues.update).toHaveBeenCalledWith({
      owner,
      repo,
      issue_number: 2,
      state: 'closed',
      state_reason: 'not_planned',
    });
  });

  it('promotes severity by removing old label and adding new one', async () => {
    const decisions: TriageDecision[] = [
      { issueNumber: 3, verdict: 'promote', reason: 'High impact', newSeverity: 'P1' },
    ];

    await applyTriageDecisions(decisions, { octokit, owner, repo }, 5);

    expect(octokit.issues.addLabels).toHaveBeenCalledWith({
      owner,
      repo,
      issue_number: 3,
      labels: ['tl-triaged', 'tl-approved', 'P1'],
    });
    expect(octokit.issues.removeLabel).toHaveBeenCalledWith({
      owner,
      repo,
      issue_number: 3,
      name: 'P3',
    });
  });

  it('defers an issue with deferred label', async () => {
    const decisions: TriageDecision[] = [
      { issueNumber: 4, verdict: 'defer', reason: 'Needs info' },
    ];

    await applyTriageDecisions(decisions, { octokit, owner, repo }, 5);

    expect(octokit.issues.addLabels).toHaveBeenCalledWith({
      owner,
      repo,
      issue_number: 4,
      labels: ['tl-triaged', 'deferred'],
    });
  });

  it('enforces daily cap on approve and promote verdicts', async () => {
    const decisions: TriageDecision[] = [
      { issueNumber: 1, verdict: 'approve', reason: 'r1' },
      { issueNumber: 2, verdict: 'approve', reason: 'r2' },
      { issueNumber: 3, verdict: 'reject', reason: 'r3' },
      { issueNumber: 4, verdict: 'promote', reason: 'r4', newSeverity: 'P1' },
    ];

    const result = await applyTriageDecisions(decisions, { octokit, owner, repo }, 2);

    expect(result.applied).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.capReached).toBe(true);
  });

  it('calls recordDecision and onCapConsumed hooks', async () => {
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const onCapConsumed = vi.fn();
    const decisions: TriageDecision[] = [
      { issueNumber: 1, verdict: 'approve', reason: 'r' },
      { issueNumber: 2, verdict: 'defer', reason: 'r' },
    ];

    await applyTriageDecisions(decisions, { octokit, owner, repo, recordDecision, onCapConsumed }, 5);

    expect(recordDecision).toHaveBeenCalledTimes(2);
    expect(onCapConsumed).toHaveBeenCalledTimes(1);
  });

  it('skips failed decisions and continues', async () => {
    vi.mocked(octokit.issues.createComment).mockRejectedValue(new Error('API error'));
    const decisions: TriageDecision[] = [
      { issueNumber: 1, verdict: 'approve', reason: 'r' },
    ];

    const result = await applyTriageDecisions(decisions, { octokit, owner, repo }, 5);

    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('on a reject whose close fails: labels + records BEFORE closing, so the issue is never closed-but-lost', async () => {
    // Order is label -> record -> close. A close failure therefore leaves the
    // issue OPEN + tl-triaged + recorded (visible, recoverable) — it can never be
    // closed-without-label, a state the open-only fetchUntriagedIssues could not
    // re-surface. The decision is counted skipped (close threw).
    vi.mocked(octokit.issues.update).mockRejectedValue(new Error('close failed'));
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const decisions: TriageDecision[] = [
      { issueNumber: 2, verdict: 'reject', reason: 'Not actionable' },
    ];

    const result = await applyTriageDecisions(decisions, { octokit, owner, repo, recordDecision }, 5);

    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    // tl-triaged was applied and the decision recorded BEFORE the close attempt:
    expect(octokit.issues.addLabels).toHaveBeenCalled();
    expect(recordDecision).toHaveBeenCalled();
    expect(octokit.issues.update).toHaveBeenCalled();
    // label strictly precedes close → never closed-without-label:
    const labelCallOrder = vi.mocked(octokit.issues.addLabels).mock.invocationCallOrder[0] ?? 0;
    const closeCallOrder = vi.mocked(octokit.issues.update).mock.invocationCallOrder[0] ?? 0;
    expect(labelCallOrder).toBeGreaterThan(0);
    expect(closeCallOrder).toBeGreaterThan(0);
    expect(labelCallOrder).toBeLessThan(closeCallOrder);
  });
});
