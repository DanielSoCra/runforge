/**
 * STACK-AC-OPERATOR-SURFACE-API — the daemon control-plane Decision API (READ).
 *
 * Two pure-ish handler functions that project the decision-index read model over
 * HTTP, so the out-of-process Operator Surface (dashboard) can read the ranked
 * pending-decisions inbox and read a single decision in full (server-side reveal)
 * — the backend prerequisite that unblocks the surface (ARCH-AC-OPERATOR-SURFACE).
 *
 * SCOPE (7a): READ ONLY. The operator ANSWER flow is intentionally NOT a parallel
 * ledger-write here — an answer must resume the parked run, and the proven resume
 * engine (`resumeParkedRuns`) is driven by the decision-escalation
 * DecisionResponse transport, not a direct `ledger.answer()`. Routing an answer
 * through a second path would record an answer the resume loop never sees (the run
 * strands). The answer flow therefore lands in a follow-up that reuses the
 * existing decision-escalation resume path (FUNC-AC-DECISION-ESCALATION).
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
