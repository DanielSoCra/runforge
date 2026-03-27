// src/coordination/product-owner/finding-approval.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  getRemainingCapacity,
  readCapState,
  incrementCapCounter,
  fetchFindingsAwaitingApproval,
  applyFindingDecisions,
  VERDICT_LABELS,
  type FindingApprovalDeps,
} from './finding-approval.js';
import type { POFindingDailyCap, POFindingDecision } from './schemas.js';

// --- Cap state helpers ---

function makeCapState(overrides: Partial<POFindingDailyCap> = {}): POFindingDailyCap {
  return {
    date: new Date().toISOString().slice(0, 10),
    approvedCount: 0,
    ...overrides,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- Mock Octokit ---

function makeOctokit() {
  return {
    issues: {
      listForRepo: vi.fn().mockResolvedValue({ data: [] }),
      addLabels: vi.fn().mockResolvedValue({}),
      removeLabel: vi.fn().mockResolvedValue({}),
      createComment: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeDeps(overrides: Partial<FindingApprovalDeps> = {}): FindingApprovalDeps {
  return {
    readJson: vi.fn().mockResolvedValue({ ok: true, value: makeCapState() }),
    writeJson: vi.fn().mockResolvedValue(undefined),
    capStatePath: '/tmp/test-finding-cap-state.json',
    ...overrides,
  };
}

// --- Tests ---

describe('getRemainingCapacity', () => {
  it('returns full cap when state date is not today', () => {
    const state = makeCapState({ date: '2020-01-01', approvedCount: 3 });
    expect(getRemainingCapacity(state, 5)).toBe(5);
  });

  it('returns remaining when state date is today', () => {
    const state = makeCapState({ date: today(), approvedCount: 3 });
    expect(getRemainingCapacity(state, 5)).toBe(2);
  });

  it('returns 0 when cap is reached', () => {
    const state = makeCapState({ date: today(), approvedCount: 5 });
    expect(getRemainingCapacity(state, 5)).toBe(0);
  });

  it('returns 0 (not negative) when count exceeds cap', () => {
    const state = makeCapState({ date: today(), approvedCount: 7 });
    expect(getRemainingCapacity(state, 5)).toBe(0);
  });
});

describe('readCapState', () => {
  it('returns stored state when file exists', async () => {
    const stored = makeCapState({ approvedCount: 3 });
    const deps = makeDeps({ readJson: vi.fn().mockResolvedValue({ ok: true, value: stored }) });
    const state = await readCapState(deps);
    expect(state.approvedCount).toBe(3);
  });

  it('returns fresh state when file does not exist', async () => {
    const deps = makeDeps({
      readJson: vi.fn().mockResolvedValue({ ok: false, error: new Error('ENOENT') }),
    });
    const state = await readCapState(deps);
    expect(state.date).toBe(today());
    expect(state.approvedCount).toBe(0);
  });
});

describe('incrementCapCounter', () => {
  it('increments count for same day', async () => {
    const stored = makeCapState({ date: today(), approvedCount: 2 });
    const deps = makeDeps({ readJson: vi.fn().mockResolvedValue({ ok: true, value: stored }) });
    await incrementCapCounter(deps);
    expect(deps.writeJson).toHaveBeenCalledWith(
      deps.capStatePath,
      { date: today(), approvedCount: 3 },
    );
  });

  it('resets count on new day', async () => {
    const stored = makeCapState({ date: '2020-01-01', approvedCount: 4 });
    const deps = makeDeps({ readJson: vi.fn().mockResolvedValue({ ok: true, value: stored }) });
    await incrementCapCounter(deps);
    expect(deps.writeJson).toHaveBeenCalledWith(
      deps.capStatePath,
      { date: today(), approvedCount: 1 },
    );
  });

  it('accepts a delta to batch multiple approvals in one write', async () => {
    const stored = makeCapState({ date: today(), approvedCount: 1 });
    const deps = makeDeps({ readJson: vi.fn().mockResolvedValue({ ok: true, value: stored }) });
    await incrementCapCounter(deps, 3);
    expect(deps.writeJson).toHaveBeenCalledTimes(1);
    expect(deps.writeJson).toHaveBeenCalledWith(
      deps.capStatePath,
      { date: today(), approvedCount: 4 },
    );
  });

  it('does nothing when delta is 0', async () => {
    const deps = makeDeps();
    await incrementCapCounter(deps, 0);
    expect(deps.writeJson).not.toHaveBeenCalled();
  });
});

describe('fetchFindingsAwaitingApproval', () => {
  it('returns tl-approved issues excluding already-processed', async () => {
    const octokit = makeOctokit();
    octokit.issues.listForRepo.mockResolvedValue({
      data: [
        { number: 1, title: 'Finding A', labels: [{ name: 'tl-approved' }, { name: 'review-finding' }] },
        { number: 2, title: 'Finding B', labels: [{ name: 'tl-approved' }, { name: 'po-approved' }] },
        { number: 3, title: 'Finding C', labels: [{ name: 'tl-approved' }, { name: 'auto-fix-approved' }] },
        { number: 4, title: 'Finding D', labels: [{ name: 'tl-approved' }] },
      ],
    });
    const findings = await fetchFindingsAwaitingApproval(octokit as any, 'owner', 'repo');
    expect(findings).toHaveLength(2);
    expect(findings.map(f => f.issueNumber)).toEqual([1, 4]);
  });

  it('extracts severity label and TL approval reason', async () => {
    const octokit = makeOctokit();
    octokit.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 10,
          title: 'Security issue',
          labels: [{ name: 'tl-approved' }, { name: 'severity-high' }],
        },
      ],
    });
    const findings = await fetchFindingsAwaitingApproval(octokit as any, 'owner', 'repo');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.issueNumber).toBe(10);
    expect(findings[0]!.title).toBe('Security issue');
    expect(findings[0]!.severityLabel).toBe('severity-high');
  });

  it('returns empty array when no tl-approved issues', async () => {
    const octokit = makeOctokit();
    octokit.issues.listForRepo.mockResolvedValue({ data: [] });
    const findings = await fetchFindingsAwaitingApproval(octokit as any, 'owner', 'repo');
    expect(findings).toEqual([]);
  });
});

describe('applyFindingDecisions', () => {
  const owner = 'owner';
  const repo = 'repo';

  it('batches cap counter into one write for multiple approvals (regression: #432)', async () => {
    const octokit = makeOctokit();
    const stored = makeCapState({ date: today(), approvedCount: 0 });
    const deps = makeDeps({ readJson: vi.fn().mockResolvedValue({ ok: true, value: stored }) });
    const decisions: POFindingDecision[] = [
      { issueNumber: 10, verdict: 'approve', reason: 'Yes' },
      { issueNumber: 11, verdict: 'approve', reason: 'Also yes' },
      { issueNumber: 12, verdict: 'approve', reason: 'And this too' },
    ];
    await applyFindingDecisions(octokit as any, owner, repo, decisions, deps);

    // Must be exactly one file write regardless of how many approvals, to minimise
    // the concurrent read-modify-write window between PO cycles.
    expect(deps.writeJson).toHaveBeenCalledTimes(1);
    expect(deps.writeJson).toHaveBeenCalledWith(deps.capStatePath, { date: today(), approvedCount: 3 });
  });

  it('applies approve verdict: adds po-approved label, posts comment, increments cap', async () => {
    const octokit = makeOctokit();
    const deps = makeDeps();
    const decisions: POFindingDecision[] = [
      { issueNumber: 1, verdict: 'approve', reason: 'Aligns with priorities' },
    ];
    await applyFindingDecisions(octokit as any, owner, repo, decisions, deps);

    expect(octokit.issues.addLabels).toHaveBeenCalledWith({
      owner, repo, issue_number: 1, labels: ['po-approved'],
    });
    expect(octokit.issues.createComment).toHaveBeenCalledWith({
      owner, repo, issue_number: 1,
      body: '**PO approve:** Aligns with priorities',
    });
    expect(deps.writeJson).toHaveBeenCalled();
  });

  it('applies reject verdict: adds po-rejected, removes tl-approved', async () => {
    const octokit = makeOctokit();
    const deps = makeDeps();
    const decisions: POFindingDecision[] = [
      { issueNumber: 2, verdict: 'reject', reason: 'Low priority' },
    ];
    await applyFindingDecisions(octokit as any, owner, repo, decisions, deps);

    expect(octokit.issues.addLabels).toHaveBeenCalledWith({
      owner, repo, issue_number: 2, labels: ['po-rejected'],
    });
    expect(octokit.issues.removeLabel).toHaveBeenCalledWith({
      owner, repo, issue_number: 2, name: 'tl-approved',
    });
    expect(octokit.issues.createComment).toHaveBeenCalledWith({
      owner, repo, issue_number: 2,
      body: '**PO reject:** Low priority',
    });
  });

  it('applies needs_discussion verdict: adds needs-discussion label', async () => {
    const octokit = makeOctokit();
    const deps = makeDeps();
    const decisions: POFindingDecision[] = [
      { issueNumber: 3, verdict: 'needs_discussion', reason: 'Unclear scope', discussionContext: 'Need operator input on priority' },
    ];
    await applyFindingDecisions(octokit as any, owner, repo, decisions, deps);

    expect(octokit.issues.addLabels).toHaveBeenCalledWith({
      owner, repo, issue_number: 3, labels: ['needs-discussion'],
    });
    expect(octokit.issues.createComment).toHaveBeenCalledWith({
      owner, repo, issue_number: 3,
      body: '**PO needs_discussion:** Unclear scope',
    });
  });

  it('does not increment cap for reject or needs_discussion', async () => {
    const octokit = makeOctokit();
    const deps = makeDeps();
    const decisions: POFindingDecision[] = [
      { issueNumber: 1, verdict: 'reject', reason: 'No' },
      { issueNumber: 2, verdict: 'needs_discussion', reason: 'Maybe' },
    ];
    await applyFindingDecisions(octokit as any, owner, repo, decisions, deps);

    expect(deps.writeJson).not.toHaveBeenCalled();
  });

  it('tolerates removeLabel 404 errors', async () => {
    const octokit = makeOctokit();
    octokit.issues.removeLabel.mockRejectedValue(new Error('Not Found'));
    const deps = makeDeps();
    const decisions: POFindingDecision[] = [
      { issueNumber: 1, verdict: 'reject', reason: 'Not needed' },
    ];
    await applyFindingDecisions(octokit as any, owner, repo, decisions, deps);
    expect(octokit.issues.addLabels).toHaveBeenCalled();
  });

  it('continues processing remaining decisions when addLabels throws for one decision', async () => {
    const octokit = makeOctokit();
    octokit.issues.addLabels
      .mockRejectedValueOnce(new Error('rate limit exceeded'))
      .mockResolvedValue({});
    const deps = makeDeps();
    const decisions: POFindingDecision[] = [
      { issueNumber: 1, verdict: 'approve', reason: 'Yes' },
      { issueNumber: 2, verdict: 'approve', reason: 'Also yes' },
    ];
    await expect(applyFindingDecisions(octokit as any, owner, repo, decisions, deps)).resolves.toBeUndefined();
    // Second decision must still be processed despite first failing
    expect(octokit.issues.addLabels).toHaveBeenCalledTimes(2);
    expect(octokit.issues.createComment).toHaveBeenCalledTimes(1);
    expect(octokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 2 }),
    );
  });

  it('continues processing remaining decisions when createComment throws for one decision', async () => {
    const octokit = makeOctokit();
    octokit.issues.createComment
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValue({});
    const deps = makeDeps();
    const decisions: POFindingDecision[] = [
      { issueNumber: 1, verdict: 'reject', reason: 'No' },
      { issueNumber: 2, verdict: 'reject', reason: 'Also no' },
    ];
    await expect(applyFindingDecisions(octokit as any, owner, repo, decisions, deps)).resolves.toBeUndefined();
    expect(octokit.issues.createComment).toHaveBeenCalledTimes(2);
    expect(octokit.issues.addLabels).toHaveBeenCalledTimes(2);
  });

  it('handles multiple decisions in sequence, batching cap writes into one', async () => {
    const octokit = makeOctokit();
    const deps = makeDeps();
    const decisions: POFindingDecision[] = [
      { issueNumber: 1, verdict: 'approve', reason: 'Yes' },
      { issueNumber: 2, verdict: 'reject', reason: 'No' },
      { issueNumber: 3, verdict: 'approve', reason: 'Also yes' },
    ];
    await applyFindingDecisions(octokit as any, owner, repo, decisions, deps);

    expect(octokit.issues.addLabels).toHaveBeenCalledTimes(3);
    expect(octokit.issues.createComment).toHaveBeenCalledTimes(3);
    // Two approvals → one batched write with delta=2, not two separate writes
    expect(deps.writeJson).toHaveBeenCalledTimes(1);
    expect(deps.writeJson).toHaveBeenCalledWith(
      deps.capStatePath,
      { date: today(), approvedCount: 2 },
    );
  });
});

describe('VERDICT_LABELS', () => {
  it('maps approve to po-approved', () => {
    expect(VERDICT_LABELS.approve).toEqual({ add: ['po-approved'], remove: [] });
  });

  it('maps reject to po-rejected with tl-approved removal', () => {
    expect(VERDICT_LABELS.reject).toEqual({ add: ['po-rejected'], remove: ['tl-approved'] });
  });

  it('maps needs_discussion to needs-discussion', () => {
    expect(VERDICT_LABELS.needs_discussion).toEqual({ add: ['needs-discussion'], remove: [] });
  });
});
