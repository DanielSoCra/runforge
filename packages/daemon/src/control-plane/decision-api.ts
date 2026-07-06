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
import type { RankedListItem, DetailView, ListRankedArgs } from '@runforge/decision-index';
import type { InboxItem, RankedItem, RankingExplanation } from '../operator-learning/types.js';
import { parseFindingDismissalDecisionId } from './finding-dismissal/build-request.js';
import { findingDismissalClass } from './finding-dismissal/labels.js';

/** The narrow read surface a list/detail handler needs (structurally satisfied by `ReadModel`). */
export interface DecisionReadModel {
  listRanked(args?: ListRankedArgs): Promise<RankedListItem[]>;
  detail(decisionId: string): Promise<DetailView | undefined>;
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

// ── learned-attention inbox ranking (FUNC-AC-OPERATOR-LEARNING rung 1) ────────
//
// The pending-decisions inbox is re-ordered by the Operator's LEARNED attention
// on top of the explainable base priority. This is the read-side actuator of
// operator-learning's `rankInboxItems` — the ONLY action L1 permits for the
// decision-classes the daemon currently observes (`l2_gate`/`merge_decision`,
// both guarded → capped at the 'surface' rung). It NEVER adds, drops, hides, or
// pre-fills an item; it only re-orders the SAME set and annotates `why_ranked`.

/**
 * The learning key for a pending row — the `{decisionClass, context}` pair that
 * must EXACTLY match what `observeDecisionAnswer` records (daemon.ts:2628/2914:
 * `l2_gate`/`merge_decision` × `${owner}/${repo}`), or it learns nothing.
 */
export interface LearningKey {
  decisionClass: string;
  context: string;
}

/** Injected ranker: layers learned attention over base priority. Untrusted output. */
export type InboxRanker = (items: InboxItem[]) => Promise<RankedItem[]>;

/**
 * A GitHub issue URL: `https://github.com/<owner>/<repo>/issues/<n>`. Same shape
 * the observe path used to build `context` (`${runOwner}/${runRepoName}`), so the
 * derived context is byte-identical to what was recorded.
 */
const ISSUE_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#]|$)/;

/**
 * Reserved class for a row whose learning key cannot be derived (unrecognized
 * phase or malformed `source_url`). No real observation path emits this class
 * (`observeDecisionAnswer` records only `l2_gate`/`merge_decision`), so a neutral
 * row matches NO observation → zero learned boost → keeps its base position. The
 * per-row context (built from the decisionId) makes the key UNMATCHABLE even by a
 * deliberately seeded `__neutral__/__neutral__` observation. NEVER drop such a row.
 */
const NEUTRAL_LEARNING_CLASS = '__neutral__';

/** The literal rung values an explanation may carry (the allowlist for `why_ranked`). */
const VALID_RUNGS: ReadonlySet<string> = new Set<string>(['surface', 'pre-fill', 'propose-ask-less']);

/**
 * Derive the learning key for a pending row from its DETERMINISTIC `decision_id`
 * phase segment and its `source_url`:
 *   - `decisionClass`: `…:l2-gate:…` → `l2_gate`; `…:integrate:…` → `merge_decision`;
 *     `finding-<n>:finding-dismissal:<category>:<epoch>` → `finding_dismissal:<category>`
 *     (the category comes FROM the strict id — `RankedListItem` carries no category
 *     field — so it is byte-identical to what the apply-consumer observes); any
 *     other (or absent / malformed finding) phase → `null` (unlearnable / neutral).
 *   - `context`: `${owner}/${repo}` parsed from the GitHub issue `source_url` (NOT
 *     `deployment`, which is the deployment id, not `owner/repo`). A `source_url`
 *     that is not a recognizable issue URL → `null` (neutral, never dropped).
 *
 * Pure. Returns `null` (rather than throwing) in BOTH failure modes so the caller
 * maps it to the neutral sentinel.
 */
export function deriveLearningKey(
  row: Pick<RankedListItem, 'decision_id' | 'source_url'>,
): LearningKey | null {
  const phase = row.decision_id.split(':')[1];
  let decisionClass: string;
  if (phase === 'l2-gate') {
    decisionClass = 'l2_gate';
  } else if (phase === 'integrate') {
    decisionClass = 'merge_decision';
  } else if (phase === 'finding-dismissal') {
    // The category lives in the strict id, not in a row field. A malformed/short
    // finding id → neutral (never crash, never mis-key). The resulting class
    // EXACTLY matches the apply-consumer's observe key (both parse the same id).
    const parsed = parseFindingDismissalDecisionId(row.decision_id);
    if (parsed === null) return null;
    decisionClass = findingDismissalClass(parsed.category);
  } else {
    return null;
  }

  const m = ISSUE_URL_RE.exec(row.source_url);
  if (m === null) return null;
  const owner = m[1];
  const repo = m[2];
  if (owner === undefined || owner.length === 0 || repo === undefined || repo.length === 0) {
    return null;
  }
  return { decisionClass, context: `${owner}/${repo}` };
}

/** Map a base row → an `InboxItem` (per-row unmatchable sentinel when underivable). */
function toInboxItem(row: RankedListItem): InboxItem {
  const key = deriveLearningKey(row);
  if (key !== null) {
    return {
      decisionId: row.decision_id,
      decisionClass: key.decisionClass,
      context: key.context,
      basePriority: row.score,
    };
  }
  // Neutral row: a per-row sentinel that can never equal a real OR seeded
  // observation key. The reserved class is never observed, and tying the context
  // to the decisionId removes the shared-key amplification (one seeded
  // `__neutral__/__neutral__` observation must not boost EVERY underivable row).
  return {
    decisionId: row.decision_id,
    decisionClass: NEUTRAL_LEARNING_CLASS,
    context: `${NEUTRAL_LEARNING_CLASS}:${row.decision_id}`,
    basePriority: row.score,
  };
}

/**
 * The "never suppress" guard against an untrusted ranker: the returned decision-id
 * multiset must EXACTLY equal the full base multiset — no missing, extra, or
 * duplicate id, over EVERY row (including neutral ones). Only an exact match is
 * trusted; anything else falls back to base order.
 */
function rankingMultisetMatches(ranked: RankedItem[], base: RankedListItem[]): boolean {
  if (ranked.length !== base.length) return false;
  const counts = new Map<string, number>();
  for (const row of base) {
    counts.set(row.decision_id, (counts.get(row.decision_id) ?? 0) + 1);
  }
  for (const item of ranked) {
    const remaining = counts.get(item.decisionId);
    if (remaining === undefined || remaining === 0) return false;
    counts.set(item.decisionId, remaining - 1);
  }
  for (const remaining of counts.values()) {
    if (remaining !== 0) return false;
  }
  return true;
}

/**
 * Runtime guard over the ONLY explanation fields that reach `why_ranked`. The
 * injected ranker is UNTRUSTED — its TS type is not a runtime guarantee — so an
 * item with correct ids can still carry an arbitrary-string `rung` (e.g.
 * `"surface protected://x"`) or a non-finite number. The multiset check validates
 * ids only; this validates the explanation BEFORE `learnedNote` stringifies it, so
 * no arbitrary text or `protected://` ref can be appended to the inbox response.
 * Any failing item is treated exactly like a multiset mismatch → base order.
 */
function rankedItemIsSafe(item: RankedItem): boolean {
  const explanation: unknown = item.explanation;
  if (typeof explanation !== 'object' || explanation === null) return false;
  const { rung, confidence, attentionWeight } = explanation as Record<string, unknown>;
  return (
    typeof rung === 'string' &&
    VALID_RUNGS.has(rung) &&
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    typeof attentionWeight === 'number' &&
    Number.isFinite(attentionWeight)
  );
}

/**
 * Whether the explanation carries an ACTUAL learned signal. With zero observations
 * the engine yields `rung='surface'`, `confidence=0`, `attentionWeight=0` — no
 * signal → no note → `why_ranked` is left byte-for-byte unchanged (no behavior
 * change until something is learned).
 */
function hasLearnedSignal(explanation: RankingExplanation): boolean {
  return (
    explanation.rung !== 'surface' ||
    explanation.confidence > 0 ||
    explanation.attentionWeight !== 0
  );
}

/**
 * The allowlisted learned note appended to `why_ranked`. Uses ONLY the structured
 * `explanation` fields `rung`/`confidence`/`attentionWeight` — NEVER the row
 * `context`, a protected/PHI field, or arbitrary ranker output.
 */
function learnedNote(explanation: RankingExplanation): string {
  const confidence = Math.round(explanation.confidence * 100) / 100;
  return `· learned: rung=${explanation.rung} confidence=${confidence} attentionWeight=${explanation.attentionWeight}`;
}

/**
 * Re-order the SAME base set by the validated ranker order and append the
 * allowlisted learned note to each row that carries a learned signal. Returns the
 * base order unchanged if any id is unexpectedly unmatched (belt-and-braces after
 * the multiset validation).
 */
function reorderWithLearnedNotes(
  base: RankedListItem[],
  ranked: RankedItem[],
): RankedListItem[] {
  const byId = new Map<string, RankedListItem[]>();
  for (const row of base) {
    const queue = byId.get(row.decision_id);
    if (queue === undefined) {
      byId.set(row.decision_id, [row]);
    } else {
      queue.push(row);
    }
  }

  const result: RankedListItem[] = [];
  for (const item of ranked) {
    const queue = byId.get(item.decisionId);
    if (queue === undefined || queue.length === 0) return base;
    const row = queue.shift() as RankedListItem;
    result.push(
      hasLearnedSignal(item.explanation)
        ? { ...row, why_ranked: `${row.why_ranked} ${learnedNote(item.explanation)}` }
        : row,
    );
  }
  return result;
}

/**
 * Apply learned-attention re-ranking over the base rows. FAIL-SAFE: any error,
 * invalid/partial ranker output, or unavailable store → the base order (+ log).
 * Learning is an enhancement of the inbox, NEVER a dependency of it — the inbox
 * must never fail or hide an item because learning hiccupped.
 */
async function applyLearnedRanking(
  base: RankedListItem[],
  rankItems: InboxRanker,
): Promise<RankedListItem[]> {
  if (base.length === 0) return base;
  try {
    const ranked = await rankItems(base.map(toInboxItem));
    // Trust the ranker ONLY when (a) its decision-id multiset equals the base set
    // exactly (never suppress) AND (b) every item's explanation is well-formed
    // (no arbitrary string reaches why_ranked). Either failure → base order.
    if (!rankingMultisetMatches(ranked, base) || !ranked.every(rankedItemIsSafe)) {
      console.warn(
        '[decision-api] learned ranking output failed validation (multiset or explanation); using base order',
      );
      return base;
    }
    return reorderWithLearnedNotes(base, ranked);
  } catch (e: unknown) {
    console.warn(
      `[decision-api] learned ranking failed; using base order: ${e instanceof Error ? e.message : String(e)}`,
    );
    return base;
  }
}

/**
 * GET /decisions/pending — the ranked inbox. Returns `RankedListItem[]` (protected
 * fields class-only, never a resolvable ref). A throwing read model → `503`
 * (index unavailable), never a crash.
 *
 * When a learned-attention `rankItems` ranker is injected, the base order is
 * re-ranked by the Operator's learned preference on top of base priority (rung 1).
 * The re-rank is membership-preserving and fail-safe: any error / invalid ranker
 * output falls back to the base order, so the inbox never fails or hides an item.
 * Absent ranker → the base order unchanged.
 */
export async function listPendingDecisions(
  readModel: DecisionReadModel,
  query: ListRankedArgs,
  rankItems?: InboxRanker,
): Promise<HandlerResult<RankedListItem[] | ErrorBody>> {
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
    const base = await readModel.listRanked(effective);
    if (rankItems === undefined) {
      return { status: 200, body: base };
    }
    return { status: 200, body: await applyLearnedRanking(base, rankItems) };
  } catch {
    return { status: 503, body: { error: 'decision index unavailable' } };
  }
}

/**
 * GET /decisions/:id — one decision in full, with protected fields carrying the
 * resolvable ref for the trusted server-side resolver. Unknown id → `404`; a
 * throwing read model → `503`.
 */
export async function getDecisionDetail(
  readModel: DecisionReadModel,
  id: string,
): Promise<HandlerResult<DetailView | ErrorBody>> {
  try {
    const view = await readModel.detail(id);
    if (view === undefined) {
      return { status: 404, body: { error: 'unknown decision' } };
    }
    return { status: 200, body: view };
  } catch {
    return { status: 503, body: { error: 'decision index unavailable' } };
  }
}

// ── revealProtected (5b) ─────────────────────────────────────────────────────

/** The reveal request body: which protected ref to decrypt. */
export interface RevealBody {
  ref?: string;
}

/**
 * POST /decisions/:id/reveal — decrypt a protected field ref that belongs to the
 * decision and return the original plaintext to an authorized operator.
 *
 *   (a) `body.ref` must be a non-empty string → `400` otherwise;
 *   (b) the reveal function performs the membership check (ref must belong to id);
 *       `RevealRefNotFoundError` or any "not found" error → `404`;
 *   (c) index disabled/unavailable → `503`.
 *
 * FAIL-SAFE: any unexpected throw → `503`; the handler never rethrows, so a wired
 * route can never crash the control server. Plaintext is returned ONLY in the 200
 * body; errors carry no protected content.
 */
export async function revealProtected(
  reveal: (id: string, ref: string, actor: string) => Promise<{ field: string; value: string }>,
  decisionId: string,
  body: RevealBody,
  actor: string,
): Promise<HandlerResult<{ field: string; value: string } | ErrorBody>> {
  try {
    // A malformed request body (JSON `null`, a primitive, an array, or a missing
    // ref) is a 400 — never let it throw and masquerade as a 503 outage.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'reveal body must be an object' } };
    }
    const ref = body.ref;
    if (typeof ref !== 'string' || ref.length === 0) {
      return { status: 400, body: { error: 'ref is required' } };
    }
    return { status: 200, body: await reveal(decisionId, ref, actor) };
  } catch (e: unknown) {
    // STRUCTURAL detection by error name (not `instanceof`): this module is always
    // loaded by the control server, so a value import of RevealRefNotFoundError from
    // @runforge/decision-index would eager-load the native package and defeat the
    // manager's dynamic-import fail-closed design. Match by name + a "not found" fallback.
    const message = e instanceof Error ? e.message : String(e);
    if ((e instanceof Error && e.name === 'RevealRefNotFoundError') || /not found/i.test(message)) {
      return { status: 404, body: { error: 'ref not found for decision' } };
    }
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
  publish(args: {
    decisionId: string;
    chosenOption: 'approve' | 'reject';
    /**
     * Release-phase ONLY: when true, the transport records the debut option
     * (`approve-with-debut`) instead of a plain `approve`. Semantically still an
     * approve, so `chosenOption` stays `approve`; the flag carries the debut
     * authorization the release path reads back (release/read-answer.ts).
     */
    debut?: boolean;
  }): Promise<void>;
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
    const detail = await deps.readModel.detail(decisionId);
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
    // The answer is carried as a DecisionResponse the resume loop consumes.
    // parseCockpitAnswer recognizes `approve`/`reject` for EVERY decision, plus
    // `approve-with-debut` — but only a production-release decision offers that
    // third option (release/build-request.ts, offerDebut). Accept the debut option
    // solely for a release-phase decision (its `release:` id prefix), so no other
    // decision's answer can smuggle a debut authorization; the option-membership
    // check above already requires it to be one of the offered options. Any OTHER
    // option id would post a response the resume loop IGNORES — a 200 that strands
    // the parked run — so reject it with 400.
    const isReleaseDecision = decisionId.startsWith('release:');
    if (
      chosen !== 'approve' &&
      chosen !== 'reject' &&
      !(isReleaseDecision && chosen === 'approve-with-debut')
    ) {
      return {
        status: 400,
        body: {
          error: 'chosen_option not supported by the answer transport (expected approve or reject)',
        },
      };
    }
    // `approve-with-debut` is a semantic approve that ALSO authorizes the debut;
    // carry it via the `debut` flag so the publisher records the debut option while
    // `chosenOption` stays the transport's `approve`/`reject` union.
    if (chosen === 'approve-with-debut') {
      await deps.publisher.publish({ decisionId, chosenOption: 'approve', debut: true });
    } else {
      await deps.publisher.publish({ decisionId, chosenOption: chosen });
    }
    return { status: 200, body: { answered: true, chosen_option: chosen } };
  } catch {
    return { status: 503, body: { error: 'decision index unavailable' } };
  }
}
