/**
 * RED behavioral gate for STACK-AC-OPERATOR-SURFACE-API — the daemon control-plane
 * Decision API handler functions (ARCH-AC-OPERATOR-SURFACE).
 *
 * These tests inject HAND-ROLLED fakes for the read model and the answerer, so the
 * handlers are exercised WITHOUT a live HTTP server or the native decision-index.
 * They are RED at handoff (the handler bodies throw 'not implemented') and GREEN
 * only when the three handlers implement the L2/L3 contract:
 *   - list: ranked rows, redaction-by-type (no resolvable ref leaks), 503 on throw
 *   - detail: 200 with the revealed DetailView, 404 unknown, 503 on throw
 *   - answer: chosen_option XOR answer (400), delegate to ledger, 404 unknown,
 *             409 answered-once conflict, 200 applied, 503 on throw
 *
 * DO NOT weaken these tests to make them pass — implement the handlers.
 */
import { describe, it, expect } from 'vitest';
import type { RankedListItem, DetailView, ListRankedArgs } from '@auto-claude/decision-index';
import type { AnswerResult } from './decision-escalation/ledger.js';
import {
  listPendingDecisions,
  getDecisionDetail,
  answerDecision,
  type DecisionReadModel,
  type DecisionAnswerer,
  type AnswerBody,
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
    listRanked(args?: ListRankedArgs): RankedListItem[] {
      if (opts.lastArgs) opts.lastArgs.value = args;
      return opts.ranked ?? [];
    },
    detail(decisionId: string): DetailView | undefined {
      return opts.details?.[decisionId];
    },
  };
}

/** A read model fake that THROWS on every call (index disabled/broken). */
function throwingReadModel(): DecisionReadModel {
  return {
    listRanked(): RankedListItem[] {
      throw new Error('decision index unavailable');
    },
    detail(): DetailView | undefined {
      throw new Error('decision index unavailable');
    },
  };
}

/** An answerer fake recording its call and returning a seeded `AnswerResult`. */
function fakeAnswerer(result: AnswerResult, sink?: { calls: unknown[] }): DecisionAnswerer {
  return {
    answer(decisionId: string, chosenOption: string, answerer: string, now?: string): AnswerResult {
      sink?.calls.push({ decisionId, chosenOption, answerer, now });
      return result;
    },
  };
}

/** An answerer fake that throws a named answered-once conflict (matched by name). */
function conflictingAnswerer(): DecisionAnswerer {
  return {
    answer(): AnswerResult {
      const e = new Error('answer conflicts with one already recorded');
      e.name = 'AnsweredOnceConflictError';
      throw e;
    },
  };
}

/** An answerer fake that throws a generic failure (index unavailable). */
function throwingAnswerer(): DecisionAnswerer {
  return {
    answer(): AnswerResult {
      throw new Error('decision index unavailable');
    },
  };
}

// ── listPendingDecisions ─────────────────────────────────────────────────────

describe('listPendingDecisions', () => {
  it('returns 200 with the ranked rows (ranking order preserved)', () => {
    const ranked = [rankedItem('d-2', 90), rankedItem('d-1', 10)];
    const res = listPendingDecisions(fakeReadModel({ ranked }), {});
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as RankedListItem[]).map((r) => r.decision_id)).toEqual(['d-2', 'd-1']);
  });

  it('returns 200 with an empty array when nothing is pending (the calm success state)', () => {
    const res = listPendingDecisions(fakeReadModel({ ranked: [] }), {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('never leaks protected content — list protected fields carry class only, no resolvable ref', () => {
    const res = listPendingDecisions(fakeReadModel({ ranked: [rankedItem('d-1', 50)] }), {});
    const rows = res.body as RankedListItem[];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.question.kind).toBe('protected');
    // the redaction boundary: a list protected field has no resolvable `ref`.
    expect((row.question as unknown as Record<string, unknown>).ref).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('protected://');
  });

  it('passes the query (filters/focus) through to the read model', () => {
    const lastArgs: { value: ListRankedArgs | undefined } = { value: undefined };
    const query: ListRankedArgs = { filters: { risk_class: ['P1'] } };
    listPendingDecisions(fakeReadModel({ ranked: [], lastArgs }), query);
    expect(lastArgs.value).toEqual(query);
  });

  it('fail-safe: a throwing read model maps to 503, never rethrows', () => {
    let res: { status: number; body: unknown } | undefined;
    expect(() => {
      res = listPendingDecisions(throwingReadModel(), {});
    }).not.toThrow();
    expect(res?.status).toBe(503);
  });
});

// ── getDecisionDetail ────────────────────────────────────────────────────────

describe('getDecisionDetail', () => {
  it('returns 200 with the revealed DetailView for a known decision', () => {
    const res = getDecisionDetail(fakeReadModel({ details: { 'd-1': detailView('d-1') } }), 'd-1');
    expect(res.status).toBe(200);
    expect((res.body as DetailView).decision_id).toBe('d-1');
    // detail MAY carry the resolvable ref (server-side reveal happens inside the control plane).
    expect((res.body as DetailView).question.kind).toBe('protected');
  });

  it('returns 404 for an unknown decision', () => {
    const res = getDecisionDetail(fakeReadModel({ details: {} }), 'nope');
    expect(res.status).toBe(404);
  });

  it('fail-safe: a throwing read model maps to 503, never rethrows', () => {
    let res: { status: number; body: unknown } | undefined;
    expect(() => {
      res = getDecisionDetail(throwingReadModel(), 'd-1');
    }).not.toThrow();
    expect(res?.status).toBe(503);
  });
});

// ── answerDecision ───────────────────────────────────────────────────────────

describe('answerDecision', () => {
  it('returns 200 and delegates a chosen_option to the ledger', () => {
    const sink = { calls: [] as unknown[] };
    const ledger = fakeAnswerer({ applied: true, status: 'answered_pending_source_write' }, sink);
    const body: AnswerBody = { chosen_option: 'approve', answerer: 'operator' };
    const res = answerDecision(ledger, 'd-1', body);
    expect(res.status).toBe(200);
    expect((res.body as AnswerResult).applied).toBe(true);
    expect(sink.calls).toHaveLength(1);
    expect((sink.calls[0] as { chosenOption: string }).chosenOption).toBe('approve');
  });

  it('accepts a free-form answer and delegates it through the ledger answer path', () => {
    const sink = { calls: [] as unknown[] };
    const ledger = fakeAnswerer({ applied: true, status: 'answered_pending_source_write' }, sink);
    const res = answerDecision(ledger, 'd-1', { answer: 'do the thing', answerer: 'operator' });
    expect(res.status).toBe(200);
    expect(sink.calls).toHaveLength(1);
  });

  it('returns 400 when the body carries BOTH chosen_option and answer', () => {
    const sink = { calls: [] as unknown[] };
    const ledger = fakeAnswerer({ applied: true, status: 'x' }, sink);
    const res = answerDecision(ledger, 'd-1', { chosen_option: 'approve', answer: 'also this' });
    expect(res.status).toBe(400);
    // a malformed body must NOT reach the durable ledger transport.
    expect(sink.calls).toHaveLength(0);
  });

  it('returns 400 when the body carries NEITHER chosen_option nor answer', () => {
    const sink = { calls: [] as unknown[] };
    const ledger = fakeAnswerer({ applied: true, status: 'x' }, sink);
    const res = answerDecision(ledger, 'd-1', { answerer: 'operator' });
    expect(res.status).toBe(400);
    expect(sink.calls).toHaveLength(0);
  });

  it('returns 404 when the ledger reports the row missing (status unknown)', () => {
    const ledger = fakeAnswerer({ applied: false, status: 'unknown' });
    const res = answerDecision(ledger, 'gone', { chosen_option: 'approve' });
    expect(res.status).toBe(404);
  });

  it('returns 409 on an answered-once conflict from the ledger', () => {
    let res: { status: number; body: unknown } | undefined;
    expect(() => {
      res = answerDecision(conflictingAnswerer(), 'd-1', { chosen_option: 'reject' });
    }).not.toThrow();
    expect(res?.status).toBe(409);
  });

  it('fail-safe: a throwing ledger (index unavailable) maps to 503, never rethrows', () => {
    let res: { status: number; body: unknown } | undefined;
    expect(() => {
      res = answerDecision(throwingAnswerer(), 'd-1', { chosen_option: 'approve' });
    }).not.toThrow();
    expect(res?.status).toBe(503);
  });
});
