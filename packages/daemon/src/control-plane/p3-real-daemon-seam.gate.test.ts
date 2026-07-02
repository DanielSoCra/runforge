// G2: proves the real control server + decision-api HTTP seam and CI e2e wiring.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  DetailField,
  DetailOption,
  DetailView,
  ListField,
  ListOption,
  ListRankedArgs,
  RankedListItem,
} from '@auto-claude/decision-index';
import type { ItemStatus } from '@auto-claude/decision-protocol';
import { createControlServer, type ControlHandlers } from './server.js';
import {
  answerDecision,
  getDecisionDetail,
  listPendingDecisions,
  type DecisionAnswerPublisher,
  type DecisionReadModel,
} from './decision-api.js';

let serverRef: Server | undefined;

async function closeServer(server: Server): Promise<void> {
  if (serverRef === server) serverRef = undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  if (serverRef !== undefined) {
    const server = serverRef;
    serverRef = undefined;
    await closeServer(server);
  }
});

function toListField(field: DetailField): ListField {
  if (field.kind === 'text') return field;
  return { kind: 'protected', field: field.field, class: field.class };
}

function toListOption(option: DetailOption): ListOption {
  return {
    id: option.id,
    label: toListField(option.label),
    ...(option.detail !== undefined ? { detail: toListField(option.detail) } : {}),
  };
}

function toRankedItem(detail: DetailView, score: number): RankedListItem {
  return {
    decision_id: detail.decision_id,
    status: detail.status,
    risk_class: detail.risk_class,
    deployment: detail.deployment,
    source_url: detail.source_url,
    resume_mode: detail.resume_mode,
    reversibility: detail.reversibility,
    pinned: detail.pinned,
    muted: detail.muted,
    deferred_until: detail.deferred_until,
    stale: detail.stale,
    expires_at: detail.expires_at,
    created_at: detail.created_at,
    last_notified_at: detail.last_notified_at,
    recommended_option: detail.recommended_option,
    question: toListField(detail.question),
    context: detail.context === null ? null : toListField(detail.context),
    consequence_of_no_answer:
      detail.consequence_of_no_answer === null
        ? null
        : toListField(detail.consequence_of_no_answer),
    options: detail.options.map(toListOption),
    score,
    why_ranked: `seeded priority ${score}`,
    suppressed: false,
  };
}

function makeDecision(
  decisionId: string,
  status: ItemStatus,
  issueNumber: number,
  score: number,
): { detail: DetailView; score: number } {
  const now = '2026-07-02T10:00:00.000Z';
  return {
    score,
    detail: {
      decision_id: decisionId,
      status,
      risk_class: 'P1',
      deployment: 'test-deployment',
      source_url: `https://github.com/acme/widgets/issues/${issueNumber}`,
      source_etag: null,
      resume_mode: 'requeue',
      reversibility: 'reversible',
      pinned: false,
      muted: false,
      deferred_until: null,
      stale: false,
      superseded_by: null,
      expires_at: null,
      created_at: now,
      updated_at: now,
      last_notified_at: now,
      recommended_option: null,
      answer_schema: { kind: 'option' },
      question: { kind: 'text', value: `Approve seeded decision ${issueNumber}?` },
      context: { kind: 'text', value: `Seeded context for issue ${issueNumber}` },
      consequence_of_no_answer: {
        kind: 'text',
        value: 'The run remains parked.',
      },
      options: [
        { id: 'approve', label: { kind: 'text', value: 'Approve' } },
        { id: 'reject', label: { kind: 'text', value: 'Reject' } },
      ],
    },
  };
}

class SeededDecisionReadModel implements DecisionReadModel {
  readonly #rows = new Map<string, { detail: DetailView; score: number }>();

  constructor(seed: Array<{ detail: DetailView; score: number }>) {
    for (const row of seed) {
      this.#rows.set(row.detail.decision_id, row);
    }
  }

  async listRanked(args: ListRankedArgs = {}): Promise<RankedListItem[]> {
    const statuses = new Set(args.filters?.status ?? []);
    return [...this.#rows.values()]
      .filter((row) => statuses.size === 0 || statuses.has(row.detail.status))
      .sort((a, b) => b.score - a.score)
      .map((row) => toRankedItem(row.detail, row.score));
  }

  async detail(decisionId: string): Promise<DetailView | undefined> {
    return this.#rows.get(decisionId)?.detail;
  }

  advancePastPending(decisionId: string): void {
    const row = this.#rows.get(decisionId);
    if (row === undefined) return;
    this.#rows.set(decisionId, {
      ...row,
      detail: {
        ...row.detail,
        status: 'answered_pending_source_write',
        updated_at: '2026-07-02T10:01:00.000Z',
      },
    });
  }
}

function assertRankedRows(value: unknown): asserts value is RankedListItem[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) {
    throw new Error('expected a ranked decision array');
  }
}

async function startSeededControlServer(): Promise<{
  port: number;
  server: Server;
  publishedAnswers: Array<{ decisionId: string; chosenOption: 'approve' | 'reject' }>;
}> {
  const readModel = new SeededDecisionReadModel([
    makeDecision('issue-42:l2-gate:1', 'notified', 42, 90),
    makeDecision('issue-43:integrate:1', 'viewed', 43, 80),
  ]);
  const publishedAnswers: Array<{
    decisionId: string;
    chosenOption: 'approve' | 'reject';
  }> = [];

  const publisher: DecisionAnswerPublisher = {
    async publish(args) {
      publishedAnswers.push(args);
      readModel.advancePastPending(args.decisionId);
    },
  };

  const handlers: ControlHandlers = {
    getStatus: () => ({ activeRuns: 0, paused: false }),
    pause: () => undefined,
    resume: () => undefined,
    drain: () => undefined,
    cancelDrain: () => undefined,
    retry: async (issueNumber: number) => ({
      status: 404,
      body: { error: `no retry fixture for ${issueNumber}` },
    }),
    listPendingDecisions: (query) => listPendingDecisions(readModel, query),
    getDecisionDetail: (id) => getDecisionDetail(readModel, id),
    answerDecision: (id, body) =>
      answerDecision({ readModel, publisher }, id, body),
  };

  const { server, start } = createControlServer(0, handlers);
  serverRef = server;
  const result = await start();
  expect(result.ok).toBe(true);

  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('control server did not expose an address');
  }

  return { port: (address as AddressInfo).port, server, publishedAnswers };
}

function repoRootFromImportMeta(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, '.github', 'workflows', 'ci.yml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('could not locate repository root from import.meta.url');
    }
    dir = parent;
  }
}

describe('G2 real daemon seam acceptance gate', () => {
  it('serves seeded pending decisions and removes an answered row over real HTTP', async () => {
    const { port, server, publishedAnswers } = await startSeededControlServer();
    try {
      const before = await fetch(`http://127.0.0.1:${port}/decisions/pending`);
      expect(before.status).toBe(200);
      const beforeBody: unknown = await before.json();
      assertRankedRows(beforeBody);
      expect(beforeBody).toHaveLength(2);

      const answerable = beforeBody.find(
        (row) => row.decision_id === 'issue-42:l2-gate:1',
      );
      expect(answerable).toBeDefined();

      const answer = await fetch(
        `http://127.0.0.1:${port}/decisions/${encodeURIComponent(
          'issue-42:l2-gate:1',
        )}/answer`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-By': 'gate-test',
          },
          body: JSON.stringify({ chosen_option: 'approve' }),
        },
      );
      expect(answer.status).toBe(200);
      expect(publishedAnswers).toEqual([
        { decisionId: 'issue-42:l2-gate:1', chosenOption: 'approve' },
      ]);

      const after = await fetch(`http://127.0.0.1:${port}/decisions/pending`);
      expect(after.status).toBe(200);
      const afterBody: unknown = await after.json();
      assertRankedRows(afterBody);
      expect(afterBody.map((row) => row.decision_id)).not.toContain(
        'issue-42:l2-gate:1',
      );
      expect(afterBody.map((row) => row.decision_id)).toContain(
        'issue-43:integrate:1',
      );
    } finally {
      await closeServer(server);
    }
  });

  it('wires dashboard e2e/playwright into the main CI workflow', () => {
    const repoRoot = repoRootFromImportMeta();
    const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(ci).toMatch(/playwright|@auto-claude\/dashboard\s+e2e|dashboard.*e2e/i);
  });
});
