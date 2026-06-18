/**
 * STACK-AC-OPERATOR-SURFACE-API — the daemon control-plane Decision API (READ).
 *
 * Two pure-ish handler functions that project the decision-index read model over
 * HTTP, so the out-of-process Operator Surface (dashboard) can read the ranked
 * pending-decisions inbox and read a single decision in full (server-side reveal)
 * — the backend prerequisite that unblocks the surface (ARCH-AC-OPERATOR-SURFACE).
 *
 * ANSWER (7c): the operator ANSWER flow is NOT a parallel ledger-write — an answer
 * must resume the parked run, and the proven resume engine (`resumeParkedRuns`) is
 * driven by the decision-escalation DecisionResponse transport, not a direct
 * `ledger.answer()`. Routing an answer through a second path would record an answer
 * the resume loop never sees (the run strands). So `answerDecision` validates the
 * chosen option against the decision's detail and POSTS a DecisionResponse comment
 * (via the injected publisher) that the EXISTING `resumeParkedRuns` loop recognizes
 * on its next tick — ZERO change to `resumeParkedRuns`/`parseCockpitAnswer`.
 *
 * Each handler takes its NARROW read-model dependency plus request params and
 * returns a typed `{ status, body }`, so the behavior is unit-testable WITHOUT
 * binding a port. The control-server route wiring is a thin adapter in
 * `server.ts`/`daemon.ts`: it resolves the dependency, calls the handler, and
 * pipes `{ status, body }` through the existing `json(res, status, body)` writer.
 *
 * REDACTION (L2): the LIST surface returns `RankedListItem[]`, whose protected
 * fields are class-only by type (no resolvable `ref`); the DETAIL surface returns
 * a `DetailView` carrying the `ref` for the trusted server-side resolver. The
 * handlers return exactly what the typed read-model method yields — the boundary
 * is the read model's type, never handler hygiene.
 *
 * FAIL-SAFE (L2): a read-model that THROWS (index disabled, broken at startup, or
 * erroring) maps to `503` — the handler never rethrows, so a wired route can never
 * crash the control server.
 */
import type { RankedListItem, DetailView, ListRankedArgs } from '@auto-claude/decision-index';

/** The narrow read surface a list/detail handler needs (structurally satisfied by `ReadModel`). */
export interface DecisionReadModel {
  listRanked(args?: ListRankedArgs): RankedListItem[];
  detail(decisionId: string): DetailView | undefined;
}

/** Uniform handler envelope: an HTTP status plus the JSON body the route writes. */
export interface HandlerResult<T> {
  status: number;
  body: T;
}

/** A minimal error body for non-2xx responses (never carries protected content). */
export interface ErrorBody {
  error: string;
}

/**
 * The statuses an item awaiting the Operator carries. Per the decision-index
 * writer ("only an item awaiting a human (notified/viewed) carries a meaningful
 * answer"), these — and only these — belong in the default `/decisions/pending`
 * inbox. `detected` is not yet surfaced; everything from `answered_*` onward is
 * answered / in-flight / terminal (resumed/superseded/failed) and no longer waits
 * on the Operator.
 */
export const PENDING_DECISION_STATUSES: readonly string[] = ['notified', 'viewed'];

/**
 * GET /decisions/pending — the ranked inbox. Returns `RankedListItem[]` (protected
 * fields class-only, never a resolvable ref). A throwing read model → `503`
 * (index unavailable), never a crash.
 */
export function listPendingDecisions(
  readModel: DecisionReadModel,
  query: ListRankedArgs,
): HandlerResult<RankedListItem[] | ErrorBody> {
  try {
    // Default the inbox to awaiting-Operator statuses so terminal/answered rows
    // (resumed/superseded/failed/answered_*) never appear in the default pending
    // view. An EXPLICIT status filter from the caller is respected (not widened).
    const effective: ListRankedArgs = {
      ...query,
      filters: {
        ...query.filters,
        status: query.filters?.status ?? [...PENDING_DECISION_STATUSES],
      },
    };
    return { status: 200, body: readModel.listRanked(effective) };
  } catch {
    return { status: 503, body: { error: 'decision index unavailable' } };
  }
}

/**
 * GET /decisions/:id — one decision in full, with protected fields carrying the
 * resolvable ref for the trusted server-side resolver. Unknown id → `404`; a
 * throwing read model → `503`.
 */
export function getDecisionDetail(
  readModel: DecisionReadModel,
  id: string,
): HandlerResult<DetailView | ErrorBody> {
  try {
    const view = readModel.detail(id);
    if (view === undefined) {
      return { status: 404, body: { error: 'unknown decision' } };
    }
    return { status: 200, body: view };
  } catch {
    return { status: 503, body: { error: 'decision index unavailable' } };
  }
}

// ── answerDecision (7c) ──────────────────────────────────────────────────────

/**
 * The answer request body. The operator surface submits exactly one
 * `chosen_option` that must be one of the decision's offered options. (The free-
 * form `answer` slot from the prior direct-ledger design is not part of the
 * resume-transport answer: the resume loop's `parseCockpitAnswer` recognizes a
 * `chosen_option` only.)
 */
export interface AnswerBody {
  chosen_option?: string;
}

/**
 * The statuses a decision may be answered from — the awaiting-Operator set. A
 * decision that is `detected` (not yet surfaced) or anything from `answered_*`
 * onward (answered / in-flight / terminal) is NOT answerable: an answer then is a
 * `409` conflict (the answered-once / out-of-band-resolved invariant). Mirrors
 * `PENDING_DECISION_STATUSES` — the only statuses that carry a meaningful answer.
 */
export const ANSWERABLE_DECISION_STATUSES: readonly string[] = ['notified', 'viewed'];

/**
 * The narrow publisher dependency `answerDecision` needs: post the DecisionResponse
 * comment the resume loop recognizes. Injected so the handler is unit-testable
 * WITHOUT GitHub (the gate fakes it) and so the handler holds NO ledger-write
 * authority — it can only publish the comment transport the resume loop drives.
 * `decisionId` carries the issue/epoch the publisher resolves the gate issue from.
 */
export interface DecisionAnswerPublisher {
  publish(args: { decisionId: string; chosenOption: 'approve' | 'reject' }): Promise<void>;
}

/** The dependencies `answerDecision` injects: the read-model (for validation) + the publisher. */
export interface AnswerDeps {
  readModel: DecisionReadModel;
  publisher: DecisionAnswerPublisher;
}

/**
 * POST /decisions/:id/answer — record the Operator's answer by POSTING a
 * DecisionResponse the resume loop recognizes (NEVER a direct `ledger.answer()`).
 *
 *   (a) look up the decision's `detail`; unknown id → `404`;
 *   (b) only answerable when status ∈ {notified, viewed}, else `409` (conflict);
 *   (c) validate `body.chosen_option` is present AND one of the decision's
 *       `options[].id`; absent/invalid → `400`;
 *   (d) publish the DecisionResponse via the injected publisher; return `200`.
 *
 * FAIL-SAFE: any throw (read-model disabled/broken, publisher GitHub error) →
 * `503`; the handler never rethrows, so a wired route can never crash the server.
 */
export async function answerDecision(
  deps: AnswerDeps,
  decisionId: string,
  body: AnswerBody,
): Promise<HandlerResult<{ answered: true; chosen_option: string } | ErrorBody>> {
  try {
    // A malformed request body (JSON `null`, a primitive, an array) is a 400 —
    // never let it throw on `body.chosen_option` and masquerade as a 503 outage.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'answer body must be an object' } };
    }
    const detail = deps.readModel.detail(decisionId);
    if (detail === undefined) {
      return { status: 404, body: { error: 'unknown decision' } };
    }
    if (!ANSWERABLE_DECISION_STATUSES.includes(detail.status)) {
      return { status: 409, body: { error: 'decision is not answerable' } };
    }
    const chosen = body.chosen_option;
    if (
      chosen === undefined ||
      !detail.options.some((option) => option.id === chosen)
    ) {
      return {
        status: 400,
        body: { error: 'chosen_option must be one of the decision options' },
      };
    }
    await deps.publisher.publish({
      decisionId,
      chosenOption: chosen as 'approve' | 'reject',
    });
    return { status: 200, body: { answered: true, chosen_option: chosen } };
  } catch {
    return { status: 503, body: { error: 'decision index unavailable' } };
  }
}
