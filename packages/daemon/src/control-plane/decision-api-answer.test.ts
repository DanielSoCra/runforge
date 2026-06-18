/**
 * RED behavioral gate for `answerDecision` (Slice 7c) — the operator ANSWER flow
 * on the daemon Decision API (STACK-AC-OPERATOR-SURFACE-API / ARCH-AC-OPERATOR-SURFACE).
 *
 * DESIGN (Option A): an answer must RESUME the parked run. The handler validates
 * the chosen option against the decision's detail and POSTS a DecisionResponse via
 * the injected publisher — which the EXISTING `resumeParkedRuns` loop recognizes —
 * NEVER a direct `ledger.answer()` (that would record an answer the resume loop
 * never sees and strand the run). These tests inject hand-rolled fakes, so the
 * handler is exercised WITHOUT a live HTTP server, the native decision-index, or
 * GitHub.
 *
 * Pinned behavior:
 *   - valid chosen_option (∈ the decision's options) → publishes + 200
 *   - unknown decision → 404
 *   - absent / invalid chosen_option → 400 (never publishes)
 *   - non-answerable status → 409 (never publishes)
 *   - read-model / publisher throw → 503 fail-safe (never rethrows)
 */
import { describe, it, expect } from 'vitest';
import type { DetailView, RankedListItem, ListRankedArgs } from '@auto-claude/decision-index';
import {
  answerDecision,
  type AnswerDeps,
  type DecisionReadModel,
  type DecisionAnswerPublisher,
} from './decision-api.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A detail view with approve/reject options at the given status. */
function detailView(id: string, status: string): DetailView {
  return {
    decision_id: id,
    status: status as DetailView['status'],
    risk_class: 'P1',
    deployment: 'test',
    source_url: 'https://github.com/acme/widgets/issues/42',
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
    question: { kind: 'protected', field: 'question', class: 'phi', ref: 'protected://abc' },
    context: { kind: 'text', value: 'ctx' },
    consequence_of_no_answer: { kind: 'text', value: 'parked' },
    options: [
      { id: 'approve', label: { kind: 'text', value: 'Approve' } },
      { id: 'reject', label: { kind: 'text', value: 'Reject' } },
    ],
  };
}

/** A read-model fake seeded with detail views. */
function fakeReadModel(details: Record<string, DetailView>): DecisionReadModel {
  return {
    listRanked(_args?: ListRankedArgs): RankedListItem[] {
      return [];
    },
    detail(id: string): DetailView | undefined {
      return details[id];
    },
  };
}

/** A read-model fake that THROWS on detail (index disabled/broken). */
function throwingReadModel(): DecisionReadModel {
  return {
    listRanked(): RankedListItem[] {
      return [];
    },
    detail(): DetailView | undefined {
      throw new Error('decision index unavailable');
    },
  };
}

/** A publisher fake that records what it published. */
function recordingPublisher(): {
  publisher: DecisionAnswerPublisher;
  calls: Array<{ decisionId: string; chosenOption: 'approve' | 'reject' }>;
} {
  const calls: Array<{ decisionId: string; chosenOption: 'approve' | 'reject' }> = [];
  return {
    calls,
    publisher: {
      async publish(args) {
        calls.push(args);
      },
    },
  };
}

/** A publisher fake that THROWS (GitHub write error). */
function throwingPublisher(): DecisionAnswerPublisher {
  return {
    async publish() {
      throw new Error('github write failed');
    },
  };
}

function deps(readModel: DecisionReadModel, publisher: DecisionAnswerPublisher): AnswerDeps {
  return { readModel, publisher };
}

// ── answerDecision ───────────────────────────────────────────────────────────

describe('answerDecision', () => {
  it('valid chosen_option (one of the decision options) → publishes the DecisionResponse + 200', async () => {
    const rm = fakeReadModel({ 'd-1': detailView('d-1', 'notified') });
    const { publisher, calls } = recordingPublisher();
    const res = await answerDecision(deps(rm, publisher), 'd-1', { chosen_option: 'approve' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ decisionId: 'd-1', chosenOption: 'approve' });
  });

  it('accepts the reject option as well (the other valid choice)', async () => {
    const rm = fakeReadModel({ 'd-1': detailView('d-1', 'viewed') });
    const { publisher, calls } = recordingPublisher();
    const res = await answerDecision(deps(rm, publisher), 'd-1', { chosen_option: 'reject' });
    expect(res.status).toBe(200);
    expect(calls[0]?.chosenOption).toBe('reject');
  });

  it('unknown decision → 404 (never publishes)', async () => {
    const rm = fakeReadModel({});
    const { publisher, calls } = recordingPublisher();
    const res = await answerDecision(deps(rm, publisher), 'nope', { chosen_option: 'approve' });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('absent chosen_option → 400 (never publishes)', async () => {
    const rm = fakeReadModel({ 'd-1': detailView('d-1', 'notified') });
    const { publisher, calls } = recordingPublisher();
    const res = await answerDecision(deps(rm, publisher), 'd-1', {});
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('invalid chosen_option (not one of the decision options) → 400 (never publishes)', async () => {
    const rm = fakeReadModel({ 'd-1': detailView('d-1', 'notified') });
    const { publisher, calls } = recordingPublisher();
    const res = await answerDecision(deps(rm, publisher), 'd-1', { chosen_option: 'maybe' });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('a malformed body (JSON null / non-object) → 400, NOT a 503 outage (codex)', async () => {
    const rm = fakeReadModel({ 'd-1': detailView('d-1', 'notified') });
    const { publisher, calls } = recordingPublisher();
    // a client sending JSON `null` must read as a bad request, never a phantom
    // index-unavailable 503 (which it would if `body.chosen_option` threw).
    const res = await answerDecision(
      deps(rm, publisher),
      'd-1',
      null as unknown as { chosen_option?: string },
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('non-answerable status (already answered/terminal) → 409 (never publishes)', async () => {
    const rm = fakeReadModel({ 'd-1': detailView('d-1', 'resumed') });
    const { publisher, calls } = recordingPublisher();
    const res = await answerDecision(deps(rm, publisher), 'd-1', { chosen_option: 'approve' });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('fail-safe: a throwing read model maps to 503, never rethrows', async () => {
    const { publisher } = recordingPublisher();
    let res: { status: number } | undefined;
    await expect(
      (async () => {
        res = await answerDecision(deps(throwingReadModel(), publisher), 'd-1', {
          chosen_option: 'approve',
        });
      })(),
    ).resolves.toBeUndefined();
    expect(res?.status).toBe(503);
  });

  it('fail-safe: a throwing publisher maps to 503, never rethrows', async () => {
    const rm = fakeReadModel({ 'd-1': detailView('d-1', 'notified') });
    let res: { status: number } | undefined;
    await expect(
      (async () => {
        res = await answerDecision(deps(rm, throwingPublisher()), 'd-1', {
          chosen_option: 'approve',
        });
      })(),
    ).resolves.toBeUndefined();
    expect(res?.status).toBe(503);
  });
});
