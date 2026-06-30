/**
 * RED behavioral gate for STACK-AC-OPERATOR-SURFACE-API — the daemon control-plane
 * Decision API READ handlers (ARCH-AC-OPERATOR-SURFACE).
 *
 * These tests inject a HAND-ROLLED read-model fake, so the handlers are exercised
 * WITHOUT a live HTTP server or the native decision-index. They pin the L2/L3
 * read contract:
 *   - list: ranked rows, redaction-by-type (no resolvable ref leaks), 503 on throw
 *   - detail: 200 with the revealed DetailView, 404 unknown, 503 on throw
 *
 * SCOPE (7a): READ ONLY. The operator ANSWER flow is a follow-up that reuses the
 * existing decision-escalation resume path (a direct ledger write here would
 * record an answer the resume loop never sees). DO NOT weaken these tests.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { RankedListItem, DetailView, ListRankedArgs } from '@auto-claude/decision-index';
import type { InboxItem, RankedItem, RankingExplanation } from '../operator-learning/types.js';
import { OperatorLearningService } from '../operator-learning/index.js';
import {
  listPendingDecisions,
  getDecisionDetail,
  deriveLearningKey,
  type DecisionReadModel,
} from './decision-api.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A ranked row whose `question` is a PROTECTED field carrying CLASS ONLY (no ref). */
function rankedItem(id: string, score: number): RankedListItem {
  return {
    decision_id: id,
    status: 'notified',
    risk_class: 'P1',
    deployment: 'test',
    source_url: 'https://example.test/issues/1',
    resume_mode: 'requeue',
    reversibility: 'reversible',
    pinned: false,
    muted: false,
    deferred_until: null,
    stale: false,
    expires_at: null,
    created_at: '2026-06-18T00:00:00.000Z',
    last_notified_at: null,
    recommended_option: 'approve',
    // protected field: class only, NO resolvable ref (the redaction boundary).
    question: { kind: 'protected', field: 'question', class: 'phi' },
    context: { kind: 'text', value: 'ctx' },
    consequence_of_no_answer: { kind: 'text', value: 'parked' },
    options: [
      { id: 'approve', label: { kind: 'text', value: 'Approve' } },
      { id: 'reject', label: { kind: 'text', value: 'Reject' } },
    ],
    score,
    why_ranked: 'risk:P1',
    suppressed: false,
  };
}

/** A detail view whose `question` carries the RESOLVABLE ref (server-side reveal). */
function detailView(id: string): DetailView {
  return {
    decision_id: id,
    status: 'notified',
    risk_class: 'P1',
    deployment: 'test',
    source_url: 'https://example.test/issues/1',
    source_etag: 'etag-0',
    resume_mode: 'requeue',
    reversibility: 'reversible',
    pinned: false,
    muted: false,
    deferred_until: null,
    stale: false,
    superseded_by: null,
    expires_at: null,
    created_at: '2026-06-18T00:00:00.000Z',
    updated_at: '2026-06-18T00:00:00.000Z',
    last_notified_at: null,
    recommended_option: 'approve',
    answer_schema: { kind: 'option' },
    // detail MAY carry the resolvable ref — consumed by the server-side resolver.
    question: { kind: 'protected', field: 'question', class: 'phi', ref: 'protected://abc' },
    context: { kind: 'text', value: 'ctx' },
    consequence_of_no_answer: { kind: 'text', value: 'parked' },
    options: [
      { id: 'approve', label: { kind: 'text', value: 'Approve' } },
      { id: 'reject', label: { kind: 'text', value: 'Reject' } },
    ],
  };
}

/** A read model fake: returns the rows/detail it was seeded with. */
function fakeReadModel(opts: {
  ranked?: RankedListItem[];
  details?: Record<string, DetailView>;
  lastArgs?: { value: ListRankedArgs | undefined };
}): DecisionReadModel {
  return {
    async listRanked(args?: ListRankedArgs): Promise<RankedListItem[]> {
      if (opts.lastArgs) opts.lastArgs.value = args;
      return opts.ranked ?? [];
    },
    async detail(decisionId: string): Promise<DetailView | undefined> {
      return opts.details?.[decisionId];
    },
  };
}

/** A read model fake that THROWS on every call (index disabled/broken). */
function throwingReadModel(): DecisionReadModel {
  return {
    async listRanked(): Promise<RankedListItem[]> {
      throw new Error('decision index unavailable');
    },
    async detail(): Promise<DetailView | undefined> {
      throw new Error('decision index unavailable');
    },
  };
}

// ── listPendingDecisions ─────────────────────────────────────────────────────

describe('listPendingDecisions', () => {
  it('returns 200 with the ranked rows (ranking order preserved)', async () => {
    const ranked = [rankedItem('d-2', 90), rankedItem('d-1', 10)];
    const res = await listPendingDecisions(fakeReadModel({ ranked }), {});
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as RankedListItem[]).map((r) => r.decision_id)).toEqual(['d-2', 'd-1']);
  });

  it('returns 200 with an empty array when nothing is pending (the calm success state)', async () => {
    const res = await listPendingDecisions(fakeReadModel({ ranked: [] }), {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('never leaks protected content — list protected fields carry class only, no resolvable ref', async () => {
    const res = await listPendingDecisions(fakeReadModel({ ranked: [rankedItem('d-1', 50)] }), {});
    const rows = res.body as RankedListItem[];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.question.kind).toBe('protected');
    // the redaction boundary: a list protected field has no resolvable `ref`.
    expect((row.question as unknown as Record<string, unknown>).ref).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('protected://');
  });

  it('passes caller filters/focus through, defaulting status to the awaiting-operator set', async () => {
    const lastArgs: { value: ListRankedArgs | undefined } = { value: undefined };
    const query: ListRankedArgs = { filters: { risk_class: ['P1'] } };
    await listPendingDecisions(fakeReadModel({ ranked: [], lastArgs }), query);
    // caller's risk_class survives; status is defaulted to notified/viewed.
    expect(lastArgs.value?.filters?.risk_class).toEqual(['P1']);
    expect(lastArgs.value?.filters?.status).toEqual(['notified', 'viewed']);
  });

  it('defaults the inbox to awaiting-operator statuses (excludes terminal/answered)', async () => {
    const lastArgs: { value: ListRankedArgs | undefined } = { value: undefined };
    await listPendingDecisions(fakeReadModel({ ranked: [], lastArgs }), {});
    expect(lastArgs.value?.filters?.status).toEqual(['notified', 'viewed']);
  });

  it('respects an EXPLICIT status filter (does not widen it)', async () => {
    const lastArgs: { value: ListRankedArgs | undefined } = { value: undefined };
    const query: ListRankedArgs = { filters: { status: ['resumed'] } };
    await listPendingDecisions(fakeReadModel({ ranked: [], lastArgs }), query);
    expect(lastArgs.value?.filters?.status).toEqual(['resumed']);
  });

  it('fail-safe: a throwing read model maps to 503, never rethrows', async () => {
    let res: { status: number; body: unknown } | undefined;
    await expect(
      (async () => {
        res = await listPendingDecisions(throwingReadModel(), {});
      })(),
    ).resolves.toBeUndefined();
    expect(res?.status).toBe(503);
  });
});

// ── getDecisionDetail ────────────────────────────────────────────────────────

describe('getDecisionDetail', () => {
  it('returns 200 with the revealed DetailView for a known decision', async () => {
    const res = await getDecisionDetail(fakeReadModel({ details: { 'd-1': detailView('d-1') } }), 'd-1');
    expect(res.status).toBe(200);
    expect((res.body as DetailView).decision_id).toBe('d-1');
    // detail MAY carry the resolvable ref (server-side reveal happens inside the control plane).
    expect((res.body as DetailView).question.kind).toBe('protected');
  });

  it('returns 404 for an unknown decision', async () => {
    const res = await getDecisionDetail(fakeReadModel({ details: {} }), 'nope');
    expect(res.status).toBe(404);
  });

  it('fail-safe: a throwing read model maps to 503, never rethrows', async () => {
    let res: { status: number; body: unknown } | undefined;
    await expect(
      (async () => {
        res = await getDecisionDetail(throwingReadModel(), 'd-1');
      })(),
    ).resolves.toBeUndefined();
    expect(res?.status).toBe(503);
  });
});

// ── learned-attention inbox ranking (FUNC-AC-OPERATOR-LEARNING rung 1) ─────────
//
// These tests pin the read-side actuator that wires operator-learning into the
// pending-decisions inbox. They are PURE — an injected fake ranker stands in for
// `operatorLearning.rankInboxItems`, no real Postgres or native index — so they
// run locally AND in CI (the read-model is PG-backed; the consumer must be
// testable without real PG).

/** A learnable row: a deterministic `decision_id` phase + a GitHub issue source_url. */
function learnableRow(
  decisionId: string,
  phase: 'l2-gate' | 'integrate',
  score: number,
  ownerRepo = 'acme/widgets',
  overrides: Partial<RankedListItem> = {},
): RankedListItem {
  const base = rankedItem(`${decisionId}:${phase}:1`, score);
  return {
    ...base,
    source_url: `https://github.com/${ownerRepo}/issues/7`,
    ...overrides,
  };
}

/** A neutral explanation: zero learned signal (rung surface, confidence 0, weight 0). */
function neutralExplanation(basePriority: number): RankingExplanation {
  return {
    basePriority,
    attentionWeight: 0,
    rung: 'surface',
    confidence: 0,
    evidenceSummary: {
      totalObservations: 0,
      matchingChoices: 0,
      contradictingChoices: 0,
      distinctSources: 0,
    },
  };
}

/** Convert an InboxItem → a RankedItem, optionally with a learned signal. */
function toRanked(item: InboxItem, explanation?: Partial<RankingExplanation>): RankedItem {
  return {
    decisionId: item.decisionId,
    decisionClass: item.decisionClass,
    context: item.context,
    basePriority: item.basePriority,
    score: item.basePriority,
    explanation: { ...neutralExplanation(item.basePriority), ...explanation },
  };
}

/** A fake ranker that captures the items it received and returns `build(items)`. */
function fakeRanker(
  build: (items: InboxItem[]) => RankedItem[],
  capture?: { items: InboxItem[] },
): (items: InboxItem[]) => Promise<RankedItem[]> {
  return async (items: InboxItem[]) => {
    if (capture) capture.items = items;
    return build(items);
  };
}

function ids(body: unknown): string[] {
  return (body as RankedListItem[]).map((r) => r.decision_id);
}

describe('deriveLearningKey', () => {
  it('maps an l2-gate decision_id + GitHub source_url to {l2_gate, owner/repo}', () => {
    const key = deriveLearningKey({
      decision_id: 'issue-7:l2-gate:1',
      source_url: 'https://github.com/acme/widgets/issues/7',
    });
    // EXACTLY the strings observeDecisionAnswer records (daemon.ts:2628).
    expect(key).toEqual({ decisionClass: 'l2_gate', context: 'acme/widgets' });
  });

  it('maps an integrate decision_id to {merge_decision, owner/repo}', () => {
    const key = deriveLearningKey({
      decision_id: 'issue-9:integrate:2',
      source_url: 'https://github.com/acme/widgets/issues/9',
    });
    // EXACTLY the strings observeDecisionAnswer records (daemon.ts:2914).
    expect(key).toEqual({ decisionClass: 'merge_decision', context: 'acme/widgets' });
  });

  it('returns null for an unrecognized phase (neutral, never inferred)', () => {
    expect(
      deriveLearningKey({
        decision_id: 'issue-3:l3-something:1',
        source_url: 'https://github.com/acme/widgets/issues/3',
      }),
    ).toBeNull();
  });

  it('returns null for a malformed (non-issue) source_url (context fails safe)', () => {
    expect(
      deriveLearningKey({
        decision_id: 'issue-7:l2-gate:1',
        source_url: 'not-a-github-issue-url',
      }),
    ).toBeNull();
  });

  it('does not use deployment-style ids as context (owner/repo only)', () => {
    // `cause-driven-tasks` is a deployment id, NOT owner/repo — it must never leak in.
    const key = deriveLearningKey({
      decision_id: 'issue-1:l2-gate:1',
      source_url: 'https://github.com/some-owner/some-repo/issues/1',
    });
    expect(key?.context).toBe('some-owner/some-repo');
    expect(key?.context).not.toContain('cause-driven-tasks');
  });
});

describe('listPendingDecisions — learned-attention ranking', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  afterEach(() => {
    warnSpy.mockClear();
  });

  it('reorders by the learned order on an exact multiset match', async () => {
    // base order: d-1 (90) then d-2 (10); ranker promotes d-2 to the top.
    const base = [learnableRow('issue-1', 'l2-gate', 90), learnableRow('issue-2', 'integrate', 10)];
    const ranker = fakeRanker((items) => {
      const byId = new Map(items.map((i) => [i.decisionId, i]));
      const d2 = byId.get('issue-2:integrate:1')!;
      const d1 = byId.get('issue-1:l2-gate:1')!;
      return [toRanked(d2, { confidence: 0.67, attentionWeight: 1 }), toRanked(d1)];
    });
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(['issue-2:integrate:1', 'issue-1:l2-gate:1']);
  });

  it('passes the FULL set (incl. neutral sentinel rows) to the ranker', async () => {
    const capture: { items: InboxItem[] } = { items: [] };
    const base = [
      learnableRow('issue-1', 'l2-gate', 90),
      // non-GitHub source_url → neutral sentinel key, still present.
      rankedItem('issue-99:weird:1', 10),
    ];
    const ranker = fakeRanker((items) => items.map((i) => toRanked(i)), capture);
    await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    expect(capture.items).toHaveLength(2);
    const learnable = capture.items.find((i) => i.decisionId === 'issue-1:l2-gate:1');
    expect(learnable).toMatchObject({ decisionClass: 'l2_gate', context: 'acme/widgets' });
    const neutral = capture.items.find((i) => i.decisionId === 'issue-99:weird:1');
    // a class/context that matches no observation → zero learned boost. The
    // context is PER-ROW (tied to the decisionId), never the bare shared
    // `__neutral__`, so one seeded `__neutral__/__neutral__` obs can't boost all.
    expect(neutral?.decisionClass).toBe('__neutral__');
    expect(neutral?.context).toBe('__neutral__:issue-99:weird:1');
    expect(neutral?.context).not.toBe('__neutral__');
  });

  it('falls back to base order + logs when the ranker output is MISSING an id', async () => {
    const base = [learnableRow('issue-1', 'l2-gate', 90), learnableRow('issue-2', 'integrate', 10)];
    const ranker = fakeRanker((items) => [toRanked(items[0]!)]); // drops one
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    expect(ids(res.body)).toEqual(['issue-1:l2-gate:1', 'issue-2:integrate:1']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to base order when the ranker output has an EXTRA id', async () => {
    const base = [learnableRow('issue-1', 'l2-gate', 90), learnableRow('issue-2', 'integrate', 10)];
    const ranker = fakeRanker((items) => [
      ...items.map((i) => toRanked(i)),
      toRanked({ decisionId: 'issue-3:l2-gate:1', decisionClass: 'l2_gate', context: 'acme/widgets', basePriority: 5 }),
    ]);
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    expect(ids(res.body)).toEqual(['issue-1:l2-gate:1', 'issue-2:integrate:1']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to base order when the ranker output has a DUPLICATE id', async () => {
    const base = [learnableRow('issue-1', 'l2-gate', 90), learnableRow('issue-2', 'integrate', 10)];
    const ranker = fakeRanker((items) => [toRanked(items[0]!), toRanked(items[0]!)]); // dup + drop
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    expect(ids(res.body)).toEqual(['issue-1:l2-gate:1', 'issue-2:integrate:1']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to base order when the ranker returns a MISMATCHED id', async () => {
    const base = [learnableRow('issue-1', 'l2-gate', 90), learnableRow('issue-2', 'integrate', 10)];
    const ranker = fakeRanker((items) => [
      toRanked(items[0]!),
      toRanked({ decisionId: 'issue-9:integrate:1', decisionClass: 'merge_decision', context: 'acme/widgets', basePriority: 1 }),
    ]);
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    expect(ids(res.body)).toEqual(['issue-1:l2-gate:1', 'issue-2:integrate:1']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to base order + logs when the ranker THROWS', async () => {
    const base = [learnableRow('issue-1', 'l2-gate', 90), learnableRow('issue-2', 'integrate', 10)];
    const ranker = fakeRanker(() => {
      throw new Error('ranker boom');
    });
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(['issue-1:l2-gate:1', 'issue-2:integrate:1']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('always keeps novel + guarded items present (only reorders, never drops)', async () => {
    const base = [
      learnableRow('issue-1', 'l2-gate', 50), // guarded class
      rankedItem('issue-2:novel:1', 40), // novel/neutral
    ];
    const ranker = fakeRanker((items) => [...items].reverse().map((i) => toRanked(i)));
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    expect(new Set(ids(res.body))).toEqual(new Set(['issue-1:l2-gate:1', 'issue-2:novel:1']));
    expect((res.body as RankedListItem[]).length).toBe(2);
  });

  it('appends ONLY the allowlisted learned note to why_ranked (no context/protected leak)', async () => {
    const base = [
      learnableRow('issue-1', 'l2-gate', 90, 'acme/widgets', {
        why_ranked: 'risk:P1',
        context: { kind: 'text', value: 'SECRET-CONTEXT-VALUE' },
        question: { kind: 'protected', field: 'question', class: 'phi' },
      }),
    ];
    const ranker = fakeRanker((items) =>
      items.map((i) => toRanked(i, { rung: 'surface', confidence: 0.67, attentionWeight: 1 })),
    );
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    const row = (res.body as RankedListItem[])[0]!;
    expect(row.why_ranked).toBe('risk:P1 · learned: rung=surface confidence=0.67 attentionWeight=1');
    // the allowlist: NEVER the row context, a protected ref, or the PHI class.
    expect(row.why_ranked).not.toContain('SECRET-CONTEXT-VALUE');
    expect(row.why_ranked).not.toContain('protected://');
    expect(row.why_ranked).not.toContain('phi');
    expect(row.why_ranked).not.toContain('acme/widgets');
  });

  it('no learned signal → returned rows === base rows byte-for-byte (m2 seam pin)', async () => {
    const base = [learnableRow('issue-1', 'l2-gate', 90), learnableRow('issue-2', 'integrate', 10)];
    // a ranker that preserves order with zero-signal explanations (zero observations).
    const ranker = fakeRanker((items) => items.map((i) => toRanked(i)));
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    // identical order AND identical content — no why_ranked mutation until learned.
    expect(res.body).toEqual(base);
  });

  it('absent ranker → base order unchanged (learning is optional)', async () => {
    const base = [learnableRow('issue-1', 'l2-gate', 90), learnableRow('issue-2', 'integrate', 10)];
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {});
    expect(res.body).toEqual(base);
  });

  it('rejects an injected arbitrary-string explanation field (ids match) → base order, NO note', async () => {
    // The ranker returns the EXACT base id multiset (passes the multiset check),
    // but smuggles an arbitrary/injected string into `rung` that, unvalidated,
    // would be stringified verbatim into the /decisions/pending response.
    const base = [learnableRow('issue-1', 'l2-gate', 90), learnableRow('issue-2', 'integrate', 10)];
    const ranker = fakeRanker((items) =>
      items.map((item, idx) =>
        idx === 0
          ? ({
              ...toRanked(item),
              explanation: {
                ...neutralExplanation(item.basePriority),
                rung: 'surface protected://leak acme/widgets',
              },
            } as unknown as RankedItem)
          : toRanked(item),
      ),
    );
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    // invalid explanation is treated like a multiset mismatch → base order + log.
    expect(ids(res.body)).toEqual(['issue-1:l2-gate:1', 'issue-2:integrate:1']);
    expect(warnSpy).toHaveBeenCalled();
    const body = res.body as RankedListItem[];
    // NO learned note appended; the injected string never reaches the response.
    expect(body[0]!.why_ranked).toBe('risk:P1');
    expect(JSON.stringify(body)).not.toContain('protected://');
  });

  it('rejects a non-finite numeric explanation field (ids match) → base order', async () => {
    const base = [learnableRow('issue-1', 'l2-gate', 90)];
    const ranker = fakeRanker((items) =>
      items.map(
        (item) =>
          ({
            ...toRanked(item),
            explanation: { ...neutralExplanation(item.basePriority), confidence: Number.POSITIVE_INFINITY },
          }) as unknown as RankedItem,
      ),
    );
    const res = await listPendingDecisions(fakeReadModel({ ranked: base }), {}, ranker);
    expect(ids(res.body)).toEqual(['issue-1:l2-gate:1']);
    expect((res.body as RankedListItem[])[0]!.why_ranked).toBe('risk:P1');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('a seeded `__neutral__/__neutral__` observation does NOT boost underivable rows (real ranker)', async () => {
    // The neutral sentinel must be UNMATCHABLE: even a strong (approved-shaped)
    // observation seeded under the bare `__neutral__/__neutral__` key must not
    // boost rows whose learning key is underivable.
    const dir = await mkdtemp(join(tmpdir(), 'op-learning-neutral-'));
    const service = new OperatorLearningService({
      logPath: join(dir, 'log.jsonl'),
      proposalDir: join(dir, 'proposals'),
    });
    await service.init();
    for (let i = 0; i < 5; i += 1) {
      await service.observeDecisionAnswer({
        decisionClass: '__neutral__',
        context: '__neutral__',
        sourceDecisionId: `seed-${i}`,
        chosenOption: 'approve',
        recommendedOption: 'approve',
      });
    }
    // Two underivable rows (non-GitHub source_url, unrecognized phase) → neutral.
    const base = [rankedItem('issue-1:weird:1', 50), rankedItem('issue-2:weird:1', 40)];
    const res = await listPendingDecisions(
      fakeReadModel({ ranked: base }),
      {},
      (items) => service.rankInboxItems(items),
    );
    const body = res.body as RankedListItem[];
    // order unchanged AND no learned note → the seeded key never matched.
    expect(body.map((r) => r.decision_id)).toEqual(['issue-1:weird:1', 'issue-2:weird:1']);
    for (const row of body) {
      expect(row.why_ranked).not.toContain('learned:');
    }
  });
});
