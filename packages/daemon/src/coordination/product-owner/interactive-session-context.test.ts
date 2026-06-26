// packages/daemon/src/coordination/product-owner/interactive-session-context.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import {
  assembleInteractiveContext,
  startInteractivePOSession,
  hasActiveInteractiveSession,
  closeOrphanedSessions,
  applySessionDecisionsToState,
  type InteractiveSessionDeps,
} from './interactive-session-context.js';
import { SharedPOStateStore } from './shared-po-state.js';
import type { SharedPOState } from './interactive-schemas.js';

function makeRuntime(output: string, ok = true): InteractiveSessionDeps['runtime'] {
  return {
    spawnSession: vi.fn().mockResolvedValue(
      ok
        ? { ok: true, value: { output } }
        : { ok: false, error: new Error('spawn failed') },
    ),
  } as unknown as InteractiveSessionDeps['runtime'];
}

async function makeDeps(tmpDir: string, overrides: Partial<InteractiveSessionDeps> = {}): Promise<InteractiveSessionDeps> {
  await mkdir(join(tmpDir, 'sessions'), { recursive: true });
  return {
    stateStore: new SharedPOStateStore(join(tmpDir, 'shared-po-state.json')),
    sessionsDir: join(tmpDir, 'sessions'),
    promptsDir: join(tmpDir, 'prompts'),
    runtime: makeRuntime('{"summary":"closed"}'),
    loadActiveProposals: vi.fn().mockResolvedValue([]),
    loadBacklogSummary: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('assembleInteractiveContext', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'po-interactive-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('assembles context from state, proposals, and backlog', async () => {
    const deps = await makeDeps(tmpDir, {
      loadActiveProposals: vi.fn().mockResolvedValue([{ id: 'p1', title: 'T', status: 'open', proposalType: 'spec_advancement' }]),
      loadBacklogSummary: vi.fn().mockResolvedValue([{ issueNumber: 1, title: 'B', labels: [], ageDays: 1, isStale: false }]),
    });

    const result = await assembleInteractiveContext(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.activeProposals).toHaveLength(1);
      expect(result.value.backlogSummary).toHaveLength(1);
      expect(result.value.sharedState.version).toBe(0);
    }
  });
});

describe('startInteractivePOSession', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'po-interactive-'));
    await mkdir(join(tmpDir, 'prompts'), { recursive: true });
    await writeFile(join(tmpDir, 'prompts', 'product-owner-interactive.md'), '# Interactive\n{{shared_po_state}}');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawns a session and writes a closed record', async () => {
    const deps = await makeDeps(tmpDir);

    const result = await startInteractivePOSession(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.endReason).toBe('explicit_close');
      expect(result.value.endedAt).toBeTruthy();
    }
    expect(deps.runtime.spawnSession).toHaveBeenCalledWith(
      'product-owner',
      {
        variables: expect.objectContaining({
          interactive_session_id: expect.any(String),
          shared_po_state: expect.any(String),
          active_proposals: expect.any(String),
          backlog_summary: expect.any(String),
        }),
      },
      0,
      { agentDef: expect.objectContaining({ name: 'product-owner-interactive' }) },
    );
  });

  it('threads the assembled context into the spawn variables for every prompt placeholder', async () => {
    // The runtime re-loads prompts/product-owner-interactive.md by agent name and
    // substitutes context.variables — so each {{placeholder}} in that prompt must
    // have a matching, rendered variable key. Without this the PO model sees
    // literal {{shared_po_state}} / {{active_proposals}} / {{backlog_summary}}.
    const proposals = [
      { id: 'p1', title: 'Advance spec', status: 'open', proposalType: 'spec_advancement' },
    ];
    const backlog = [
      { issueNumber: 42, title: 'Stale issue', labels: ['bug'], ageDays: 30, isStale: true },
    ];
    const deps = await makeDeps(tmpDir, {
      loadActiveProposals: vi.fn().mockResolvedValue(proposals),
      loadBacklogSummary: vi.fn().mockResolvedValue(backlog),
    });

    const result = await startInteractivePOSession(deps);
    expect(result.ok).toBe(true);

    const spawn = deps.runtime.spawnSession as ReturnType<typeof vi.fn>;
    const callArgs = spawn.mock.calls[0]!;
    const variables = (callArgs[1] as { variables: Record<string, string> }).variables;

    // Every {{...}} token in the prompt template must have a matching variable key.
    expect(variables).toHaveProperty('shared_po_state');
    expect(variables).toHaveProperty('active_proposals');
    expect(variables).toHaveProperty('backlog_summary');

    // The rendered values must carry the real assembled data (not empty/literal).
    expect(variables['active_proposals']).toContain('Advance spec');
    expect(variables['backlog_summary']).toContain('Stale issue');
    expect(variables['shared_po_state']).toContain('"version"');

    // No leftover unfilled placeholder may survive in any rendered variable.
    for (const value of Object.values(variables)) {
      expect(value).not.toMatch(/\{\{[\w-]+\}\}/);
    }
  });

  it('writes error record when spawn fails', async () => {
    const deps = await makeDeps(tmpDir, { runtime: makeRuntime('', false) });

    const result = await startInteractivePOSession(deps);

    expect(result.ok).toBe(false);
    const active = await hasActiveInteractiveSession(deps.sessionsDir);
    expect(active).toBe(false);
  });

  it('parses structured close output when available', async () => {
    const deps = await makeDeps(tmpDir, {
      runtime: makeRuntime(JSON.stringify({
        decisions: [{ itemId: 'item-1', decision: 'approve', timestamp: new Date().toISOString() }],
        autonomousDecisionsReviewed: 2,
        needsDiscussionResolved: 1,
        summary: 'All good',
      })),
    });

    const result = await startInteractivePOSession(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toBe('All good');
      expect(result.value.autonomousDecisionsReviewed).toBe(2);
      expect(result.value.needsDiscussionResolved).toBe(1);
    }
  });

  it('persists resolved decisions to shared state so they do not resurface', async () => {
    const deps = await makeDeps(tmpDir, {
      runtime: makeRuntime(JSON.stringify({
        decisions: [{ itemId: 'item-1', decision: 'approve', timestamp: new Date().toISOString() }],
        autonomousDecisionsReviewed: 0,
        needsDiscussionResolved: 1,
        summary: 'resolved',
      })),
    });

    // Seed shared state with a pending needsDiscussion item that the session resolves.
    const seedState: SharedPOState = {
      needsDiscussion: [
        {
          id: 'item-1',
          sourceType: 'finding',
          sourceRef: 'ref-1',
          contextSummary: 'needs an operator call',
          status: 'pending',
          operatorDecision: null,
          decisionTimestamp: null,
          poCycleId: 'cycle-1',
          createdAt: new Date().toISOString(),
        },
      ],
      autonomousDecisions: [],
      triageQueue: [],
      version: 0,
      lastUpdated: new Date().toISOString(),
    };
    const seedWrite = await deps.stateStore.write(seedState, 0);
    expect(seedWrite.ok).toBe(true);

    const result = await startInteractivePOSession(deps);
    expect(result.ok).toBe(true);

    // The resolved item must no longer be pending in shared state — otherwise the
    // next autonomous PO cycle would resurface it.
    const persisted = await deps.stateStore.read();
    const item = persisted.needsDiscussion.find((i) => i.id === 'item-1');
    expect(item?.status).toBe('decided');
    expect(item?.operatorDecision).toBe('approve');
    expect(
      persisted.needsDiscussion.some((i) => i.id === 'item-1' && i.status === 'pending'),
    ).toBe(false);
  });
});

describe('session record management', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'po-interactive-'));
    await mkdir(join(tmpDir, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects active sessions', async () => {
    await writeFile(join(tmpDir, 'sessions', 'active.json'), JSON.stringify({
      id: 'active',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: 'explicit_close',
      sessionRuntimeId: 'runtime-1',
      summary: '',
    }));

    expect(await hasActiveInteractiveSession(join(tmpDir, 'sessions'))).toBe(true);
  });

  it('closes orphaned sessions', async () => {
    await writeFile(join(tmpDir, 'sessions', 'orphan.json'), JSON.stringify({
      id: 'orphan',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: 'explicit_close',
      sessionRuntimeId: 'runtime-1',
      summary: '',
    }));

    const closed = await closeOrphanedSessions(join(tmpDir, 'sessions'));
    expect(closed).toBe(1);
    expect(await hasActiveInteractiveSession(join(tmpDir, 'sessions'))).toBe(false);
  });
});

describe('applySessionDecisionsToState', () => {
  it('marks decided items from session record', () => {
    const state: SharedPOState = {
      needsDiscussion: [
        {
          id: 'item-1',
          sourceType: 'finding',
          sourceRef: 'ref-1',
          contextSummary: 'summary',
          status: 'pending',
          operatorDecision: null,
          decisionTimestamp: null,
          poCycleId: 'cycle-1',
          createdAt: new Date().toISOString(),
        },
      ],
      autonomousDecisions: [],
      triageQueue: [],
      version: 0,
      lastUpdated: new Date().toISOString(),
    };

    const record = {
      id: 's1',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      endReason: 'explicit_close' as const,
      sessionRuntimeId: 'runtime-1',
      decisions: [{ itemId: 'item-1', decision: 'approve', timestamp: new Date().toISOString() }],
      autonomousDecisionsReviewed: 0,
      needsDiscussionResolved: 1,
      summary: '',
    };

    const updated = applySessionDecisionsToState(state, record);
    expect(updated.needsDiscussion[0]!.status).toBe('decided');
    expect(updated.needsDiscussion[0]!.operatorDecision).toBe('approve');
  });
});
