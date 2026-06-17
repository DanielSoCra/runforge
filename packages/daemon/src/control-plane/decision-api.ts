/**
 * STACK-AC-OPERATOR-SURFACE-API — the daemon control-plane Decision API.
 *
 * Three pure-ish handler functions that project the decision-index read model +
 * the decision ledger's answer path over HTTP, so the out-of-process Operator
 * Surface (dashboard) can read pending/ranked decisions, read a single decision
 * in full (server-side reveal), and submit an answer — the backend prerequisite
 * that unblocks the surface (ARCH-AC-OPERATOR-SURFACE).
 *
 * Each handler takes its NARROW dependency (a read-model for reads, an answerer
 * for the answer) plus request params and returns a typed `{ status, body }`, so
 * the behavior is unit-testable WITHOUT binding a port. The control-server route
 * wiring is a thin adapter the implementer adds in `server.ts`/`daemon.ts`: it
 * resolves the dependency, calls the handler, and pipes `{ status, body }` through
 * the existing `json(res, status, body)` writer.
 *
 * REDACTION (L2): the LIST surface returns `RankedListItem[]`, whose protected
 * fields are class-only by type (no resolvable `ref`); the DETAIL surface returns
 * a `DetailView` carrying the `ref` for the trusted server-side resolver. The
 * handlers return exactly what the typed read-model method yields — the boundary
 * is the read model's type, never handler hygiene.
 *
 * FAIL-SAFE (L2): a read-model/ledger that THROWS (index disabled, broken at
 * startup, or erroring) maps to `503` — the handler never rethrows, so a wired
 * route can never crash the control server.
 *
 * `import type` of the decision-index keeps this module from emitting a runtime
 * require of the native package; the conflict class is matched by name (mirroring
 * how the manager matches `/disabled/`/`/unavailable/` by message), NOT by
 * `instanceof`, so no runtime load is forced here.
 */
import type { RankedListItem, DetailView, ListRankedArgs } from '@auto-claude/decision-index';
import type { AnswerResult } from './decision-escalation/ledger.js';

/** The narrow read surface a list/detail handler needs (structurally satisfied by `ReadModel`). */
export interface DecisionReadModel {
  listRanked(args?: ListRankedArgs): RankedListItem[];
  detail(decisionId: string): DetailView | undefined;
}

/** The narrow answer surface the answer handler needs (structurally satisfied by `DecisionLedger`). */
export interface DecisionAnswerer {
  answer(decisionId: string, chosenOption: string, answerer: string, now?: string): AnswerResult;
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

/** The accepted answer-submission body: exactly one of `chosen_option` or `answer`. */
export interface AnswerBody {
  chosen_option?: string;
  answer?: string;
  answerer?: string;
}

/** The error-name a conflicting (answered-once) answer surfaces as, matched without a runtime import. */
const ANSWERED_ONCE_CONFLICT_ERROR = 'AnsweredOnceConflictError';

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
    return { status: 200, body: readModel.listRanked(query) };
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

/**
 * POST /decisions/:id/answer — record the Operator's answer. The body must carry
 * EXACTLY one of `chosen_option` or `answer` (malformed → `400`, validated at the
 * boundary before the ledger). Delegates to the ledger's recorded transport:
 * unknown row → `404`, answered-once conflict → `409`, otherwise `200` with the
 * `AnswerResult`. A throwing ledger → `503`.
 */
export function answerDecision(
  ledger: DecisionAnswerer,
  id: string,
  body: AnswerBody,
): HandlerResult<AnswerResult | ErrorBody> {
  if ((body.chosen_option === undefined) === (body.answer === undefined)) {
    return {
      status: 400,
      body: { error: 'exactly one of chosen_option or answer required' },
    };
  }
  const value = (body.chosen_option === undefined ? body.answer : body.chosen_option) as string;
  const answerer = body.answerer ?? 'operator';
  try {
    const result = ledger.answer(id, value, answerer);
    if (result.status === 'unknown') {
      return { status: 404, body: { error: 'unknown decision' } };
    }
    return { status: 200, body: result };
  } catch (e) {
    if (e instanceof Error && e.name === ANSWERED_ONCE_CONFLICT_ERROR) {
      return { status: 409, body: { error: 'answer conflicts with one already recorded' } };
    }
    return { status: 503, body: { error: 'decision index unavailable' } };
  }
}

export { ANSWERED_ONCE_CONFLICT_ERROR };
