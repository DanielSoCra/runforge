// Real daemon control-plane boot script for the operator-surface e2e smoke.
//
// Runs the ACTUAL createControlServer + decision-api handlers over a seeded
// in-memory read model (Postgres is replaced by design for this in-process e2e
// fixture; a PGlite-backed IndexWriter was explicitly ruled out because single-
// writer guarantees cannot be modelled in-process). The in-memory publisher
// advances the read model when an answer is posted, so the "row leaves on the
// next fetch" semantics hold.
//
// Launched by Playwright's webServer via:
//   pnpm --filter @auto-claude/daemon exec tsx ../dashboard/e2e/real-daemon.mjs
import { createServer } from 'node:http';
import { createControlServer } from '../../daemon/src/control-plane/server.js';
import {
  listPendingDecisions,
  getDecisionDetail,
  answerDecision,
} from '../../daemon/src/control-plane/decision-api.js';

const CONTROL_PORT = Number(process.env.REAL_DAEMON_PORT) || 9899;
const TEST_PORT = Number(process.env.REAL_DAEMON_TEST_PORT) || CONTROL_PORT + 1;

const now = '2026-07-02T10:00:00.000Z';

function makeDecision(decisionId, status, issueNumber, score) {
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

function toListField(field) {
  if (field.kind === 'text') return field;
  return { kind: 'protected', field: field.field, class: field.class };
}

function toListOption(option) {
  return {
    id: option.id,
    label: toListField(option.label),
    ...(option.detail !== undefined ? { detail: toListField(option.detail) } : {}),
  };
}

function toRankedItem(row) {
  const detail = row.detail;
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
    score: row.score,
    why_ranked: `seeded priority ${row.score}`,
    suppressed: false,
  };
}

class SeededDecisionReadModel {
  #rows = new Map();

  constructor(seed) {
    this.reset(seed);
  }

  // Test isolation: Playwright drives ONE long-lived daemon across all tests and
  // retries, but the answer flow mutates this read model (answered rows advance
  // out of the pending set). Without a per-test re-seed, the mutating test can't
  // be retried and leaks state into sibling tests. The /reset endpoint calls this
  // from the spec's beforeEach.
  reset(seed) {
    this.#rows = new Map();
    for (const row of seed) {
      this.#rows.set(row.detail.decision_id, row);
    }
  }

  async listRanked(args = {}) {
    const statuses = new Set(args.filters?.status ?? []);
    return [...this.#rows.values()]
      .filter((row) => statuses.size === 0 || statuses.has(row.detail.status))
      .sort((a, b) => b.score - a.score)
      .map((row) => toRankedItem(row));
  }

  async detail(decisionId) {
    return this.#rows.get(decisionId)?.detail;
  }

  advancePastPending(decisionId) {
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

function makeSeed() {
  return [
    makeDecision('issue-42:l2-gate:1', 'notified', 42, 90),
    makeDecision('issue-43:integrate:1', 'viewed', 43, 80),
  ];
}

const readModel = new SeededDecisionReadModel(makeSeed());

const publishedAnswers = [];

const publisher = {
  async publish(args) {
    publishedAnswers.push(args);
    readModel.advancePastPending(args.decisionId);
  },
};

const recordedHalts = [];

const handlers = {
  getStatus: () => ({ activeRuns: 0, paused: false }),
  pause: () => undefined,
  resume: () => undefined,
  drain: () => undefined,
  cancelDrain: () => undefined,
  retry: async (issueNumber) => ({
    status: 404,
    body: { error: `no retry fixture for ${issueNumber}` },
  }),
  listPendingDecisions: (query) => listPendingDecisions(readModel, query),
  getDecisionDetail: (id) => getDecisionDetail(readModel, id),
  answerDecision: (id, body) => answerDecision({ readModel, publisher }, id, body),
  halt: async () => {
    recordedHalts.push({ at: new Date().toISOString() });
    return { halted: true, parked: [301, 302], terminated: 1, escalated: 0 };
  },
};

const { start } = createControlServer(CONTROL_PORT, handlers, '127.0.0.1');

// Test-introspection server: exposes the recorded halt calls so the e2e spec can
// assert the real control plane received POST /halt without filesystem coupling.
const testServer = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/halt-log' && req.method === 'GET') {
    res.end(JSON.stringify(recordedHalts));
    return;
  }
  if (req.url === '/reset' && req.method === 'POST') {
    readModel.reset(makeSeed());
    recordedHalts.length = 0;
    publishedAnswers.length = 0;
    res.end(JSON.stringify({ reset: true }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

async function main() {
  const result = await start();
  if (!result.ok) {
    console.error('[real-daemon] failed to start:', result.error.message);
    process.exit(1);
  }
  testServer.listen(TEST_PORT, '127.0.0.1', () => {
    console.log(`[real-daemon] control plane on http://127.0.0.1:${CONTROL_PORT}`);
    console.log(`[real-daemon] test introspection on http://127.0.0.1:${TEST_PORT}`);
  });
}

main();
