// src/control-plane/daemon-po-wiring.test.ts
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPromptTemplate } from '../session-runtime/runtime.js';
import { buildProductOwnerSessionVariables } from './po-snapshot.js';

describe('product-owner signal_snapshot wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('assembles real daemon sources and substitutes signal_snapshot in the prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'po-wiring-'));
    const repoRoot = join(root, 'repo');
    const stateDir = join(root, 'state');
    await mkdir(join(repoRoot, '.specify'), { recursive: true });
    await mkdir(join(stateDir, 'runs'), { recursive: true });

    await writeFile(join(repoRoot, '.specify', 'traceability.yml'), `
FUNC-AC-LEARNING:
  children: [ARCH-AC-KNOWLEDGE]
  status: draft

ARCH-AC-KNOWLEDGE:
  parent: FUNC-AC-LEARNING
  children: [STACK-AC-KNOWLEDGE]
  status: draft

STACK-AC-KNOWLEDGE:
  parent: ARCH-AC-KNOWLEDGE
  children: []
  code_paths:
    - packages/daemon/src/knowledge/
  status: draft
`);

    await writeFile(join(stateDir, 'runs', '1.json'), JSON.stringify({
      id: 'run-1',
      issueNumber: 1,
      title: 'Complete run',
      phase: 'report',
      variant: 'feature',
      phaseCompletions: { report: true },
      checkpoints: [],
      cost: 1,
      perRunBudget: 10,
      fixAttempts: [],
      errorHashes: {},
      repoOwner: 'DANIELSOCRAHANDLEZZ',
      repoName: 'runforge',
      startedAt: '2026-04-24T00:00:00Z',
      updatedAt: '2026-04-24T01:00:00Z',
    }));
    await writeFile(join(stateDir, 'runs', '2.json'), JSON.stringify({
      id: 'run-2',
      issueNumber: 2,
      title: 'Stuck run',
      phase: 'stuck',
      variant: 'feature',
      phaseCompletions: {},
      checkpoints: [],
      cost: 1,
      perRunBudget: 10,
      fixAttempts: [],
      errorHashes: {},
      repoOwner: 'DANIELSOCRAHANDLEZZ',
      repoName: 'runforge',
      startedAt: '2026-04-24T00:00:00Z',
      updatedAt: '2026-04-24T01:00:00Z',
    }));

    const github = {
      owner: 'DANIELSOCRAHANDLEZZ',
      repo: 'runforge',
      issues: {
        listForRepo: vi.fn(async ({ labels }: { labels?: string }) => ({
          data: labels === 'review-finding,tl-approved'
            ? [{
              number: 9,
              title: 'Review finding',
              body: 'Approved by TL because it is real.',
              created_at: '2026-04-01T00:00:00Z',
              labels: [{ name: 'review-finding' }, { name: 'tl-approved' }, { name: 'P1' }],
            }]
            : [{
              number: 8,
              title: 'Backlog item',
              body: 'Needs work',
              created_at: '2026-03-01T00:00:00Z',
              labels: [{ name: 'ready' }, { name: 'feature-pipeline' }],
            }],
        })),
      },
    };

    const variables = await buildProductOwnerSessionVariables({
      repoRoot,
      stateDir,
      github,
      loadProposals: async () => [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Active proposal',
          rationale: 'Worth doing',
          scope: 'small',
          status: 'proposed',
          relatedSpecs: ['FUNC-AC-LEARNING'],
          relatedIssues: [],
          issueNumber: null,
          approvedBy: null,
          decisionNotes: null,
          expiresAt: '2026-05-01T00:00:00Z',
          createdAt: '2026-04-01T00:00:00Z',
          decidedAt: null,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          title: 'Rejected proposal',
          rationale: 'Not now',
          scope: 'small',
          status: 'rejected',
          relatedSpecs: [],
          relatedIssues: [8],
          issueNumber: null,
          approvedBy: null,
          decisionNotes: 'Too early',
          expiresAt: '2026-05-01T00:00:00Z',
          createdAt: '2026-04-01T00:00:00Z',
          decidedAt: '2026-04-02T00:00:00Z',
        },
      ],
      loadIdeas: async () => [
        {
          id: '33333333-3333-4333-8333-333333333333',
          submittedBy: 'operator',
          description: 'Make the PO useful',
          status: 'pending',
          proposalId: null,
          createdAt: '2026-04-25T00:00:00Z',
        },
      ],
    });

    const snapshot = JSON.parse(variables['signal_snapshot']!);
    expect(snapshot.specPipeline).toHaveLength(1);
    expect(snapshot.deliverySummary).toEqual([
      { repo: 'DANIELSOCRAHANDLEZZ/runforge', passRate: 0.5, completionCount: 1 },
    ]);
    expect(snapshot.backlog[0]).toMatchObject({ issueNumber: 8, isStale: true });
    expect(snapshot.activeProposals[0]).toMatchObject({ title: 'Active proposal' });
    expect(snapshot.proposalHistory[0]).toMatchObject({ title: 'Rejected proposal', operatorReason: 'Too early' });
    expect(snapshot.ideaInbox[0]).toMatchObject({ content: 'Make the PO useful' });
    expect(snapshot.findingsAwaitingApproval[0]).toMatchObject({ issueNumber: 9, severityLabel: 'P1' });

    const rendered = await loadPromptTemplate('product-owner', variables);
    expect(rendered).not.toBeNull();
    expect(rendered).not.toContain('{{signal_snapshot}}');
    expect(rendered).toContain('"Backlog item"');
    expect(rendered).toContain('"Make the PO useful"');
  });

  it('treats a missing run-state directory as an empty delivery summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'po-wiring-'));
    const repoRoot = join(root, 'repo');
    const stateDir = join(root, 'state');
    await mkdir(join(repoRoot, '.specify'), { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(repoRoot, '.specify', 'traceability.yml'), '');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const variables = await buildProductOwnerSessionVariables({
        repoRoot,
        stateDir,
        loadProposals: async () => [],
        loadIdeas: async () => [],
      });

      const snapshot = JSON.parse(variables['signal_snapshot']!);
      expect(snapshot.deliverySummary).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns when run-state scan fails for reasons other than a missing directory (#566)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'po-wiring-'));
    const repoRoot = join(root, 'repo');
    const stateDir = join(root, 'state');
    await mkdir(join(repoRoot, '.specify'), { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(repoRoot, '.specify', 'traceability.yml'), '');
    await writeFile(join(stateDir, 'runs'), 'not a directory');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const variables = await buildProductOwnerSessionVariables({
        repoRoot,
        stateDir,
        loadProposals: async () => [],
        loadIdeas: async () => [],
      });

      const snapshot = JSON.parse(variables['signal_snapshot']!);
      expect(snapshot.deliverySummary).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        '[po-snapshot] failed to read run states:',
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
