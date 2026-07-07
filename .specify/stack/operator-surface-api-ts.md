---
id: STACK-AC-OPERATOR-SURFACE-API
type: stack-specific
domain: runforge
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-OPERATOR-SURFACE
code_paths:
  - packages/daemon/src/control-plane/decision-api.ts
  - packages/daemon/src/control-plane/decision-escalation/answer-publisher.ts
test_paths:
  - packages/daemon/src/control-plane/decision-api.test.ts
  - packages/daemon/src/control-plane/decision-api-answer.test.ts
  - packages/daemon/src/control-plane/decision-escalation/answer-publisher.test.ts
---

# STACK-AC-OPERATOR-SURFACE-API — Operator Surface Decision API (TypeScript)

> **Scope.** Three handlers: the READ pair `listPendingDecisions` + `getDecisionDetail` (slice 7a) and the ANSWER handler `answerDecision` (slice 7c). The answer flow is **Option A — POST a DecisionResponse the resume loop recognizes, never a direct `ledger.answer()`**: an answer must RESUME the parked run, and the proven engine `resumeParkedRuns` (daemon.ts) is driven by the decision-escalation DecisionResponse transport (`parseCockpitAnswer`, `resume-consumer.ts`), not a parallel ledger write. A direct `ledger.answer()` would record an answer the resume loop never observes → the run strands. So `answerDecision` POSTS a `**DecisionResponse**` comment (via `answer-publisher.ts`) that the EXISTING loop recognizes on its next tick — **ZERO change to `resumeParkedRuns`/`parseCockpitAnswer`**.

## Pattern

**Pure-ish handler functions returning `{ status, body }`, wired into the control server by a thin route adapter.** The Decision API is three functions — `listPendingDecisions`, `getDecisionDetail`, `answerDecision` — each taking its injected dependency (the decision index `ReadModel` for reads; for the answer, the `ReadModel` for option/status validation PLUS a narrow `DecisionAnswerPublisher` that posts the DecisionResponse comment) plus the request params, and returning a typed `{ status: number; body: ... }` (the answer handler is `async`). This is chosen over inline route closures (the existing `server.ts` style) precisely so the behavior is unit-testable WITHOUT binding a port, issuing `fetch`, or touching GitHub — the handler is the unit under test, and the control-server route is a one-line adapter that calls the handler and pipes its result through the existing `json(res, status, body)` writer. It mirrors how the lane-engine and verifier-gate keep the *decision* in a pure function and the *I/O* at the edge.

**The ANSWER transport is a DecisionResponse comment the resume loop recognizes — split pure builder from I/O post.** `answer-publisher.ts` is the answer transport: a PURE `buildDecisionResponseComment(decisionId, chosenOption, idempotencyKey): string` that constructs the exact comment artifact, separated from `postDecisionResponse(...)` which posts it via an injected octokit-like `createComment`. The builder is unit-tested WITHOUT GitHub, and its output is asserted to round-trip through the REAL `parseCockpitAnswer` — the SAME function `resumeParkedRuns` calls. This is the load-bearing contract: what the endpoint POSTS, the existing resume loop recognizes, so the answer resumes the parked run with no new code in `resumeParkedRuns`.

**Fail-safe by `try/catch` → `503`, never a thrown error escaping the handler.** Every handler wraps its read-model / ledger call in `try/catch`; any throw — the index disabled (`ledger()` throws `/disabled/`), broken at startup (`/unavailable/`), or a read/write error — maps to `{ status: 503 }`. The handler never rethrows, so a wired route can never crash the control server: an unavailable decision index degrades the decision surface to `503` while every other control route keeps serving. This is the structural form of the L2 "index unavailable → 503 fail-safe" rule.

**Redaction is enforced by which read-model method the handler calls, not by post-filtering.** The list handler calls `ReadModel.listRanked(...)`, which returns `RankedListItem[]` whose protected fields are already class-only (`{ kind: 'protected', field, class }`, no resolvable `ref`). The detail handler calls `ReadModel.detail(id)`, which returns a `DetailView` carrying the resolvable `ref` for the server-side resolver. The handler does not strip or re-add fields — it returns exactly what the typed read-model method gives it, so the redaction boundary is the read model's type, not handler hygiene. The list result type structurally cannot carry a `ref`.

## Key Decisions

**Inject the `ReadModel` (and, for the answer, a `DecisionAnswerPublisher`), not the `DecisionIndexManager` — and NEVER a `DecisionLedger`.** The read handlers take a `ReadModel` (it exposes `listRanked` and `detail`). `answerDecision` takes `{ readModel, publisher }`: the `ReadModel` to look up the decision's detail for option/status validation, and a narrow `DecisionAnswerPublisher { publish({ decisionId, chosenOption }) }` to post the DecisionResponse. It does NOT take a `DecisionLedger` and does NOT call `ledger.answer()` — that would record an answer the resume loop never sees and strand the run (the central Option-A rule). Injecting the narrow types keeps each handler trivially fakeable with a hand-rolled object and keeps the answer handler's *no-ledger-write* authority visible in its signature.

**The wiring resolves the dependency lazily inside a `try`, so a disabled/broken index becomes a `503`, not a wiring crash.** `DecisionIndexManager.ledger()` THROWS when the index is disabled or broken — so the adapter resolves the `reader` (`manager.ledger().reader`) *inside* the handler's protected region, letting the handler's `try/catch` convert the throw to `503`. For the answer, the publisher's GitHub post is likewise inside the `try`, so a write error is a `503` too — the handler never rethrows.

**Answer body validation is `chosen_option` ∈ the decision's offered options, at the boundary, before any post.** The body type is `{ chosen_option?: string }`. The handler first looks up `readModel.detail(decisionId)` (unknown → `404`), then checks the decision is answerable (status ∈ {`notified`, `viewed`}, else `409`), then validates `chosen_option` is present AND one of `detail.options[].id` (absent or not-an-option → `400`). Only then does it `publisher.publish(...)`. Validating against the live options at the boundary means a malformed or stale-option answer never produces a DecisionResponse comment.

**Lifecycle outcome is owned by the resume loop, not the handler — the handler only publishes + returns `200`.** `answerDecision` does NOT decide applied/replayed/answered-once: it posts the DecisionResponse and returns `200` (`{ answered: true, chosen_option }`). The decision's lifecycle advance (`ledger.answer` + `advanceToResumed`) happens later inside `resumeParkedRuns` when it recognizes the comment — including the answered-once invariant (a second conflicting DecisionResponse is rejected there; the OLDEST matching comment wins per `parseCockpitAnswer`). The handler's `notified`/`viewed` precondition is the surface-level guard against double-submission, not the durable invariant.

## Examples

```typescript
export interface HandlerResult<T> { status: number; body: T }
export interface AnswerBody { chosen_option?: string }
export interface DecisionAnswerPublisher {
  publish(args: { decisionId: string; chosenOption: 'approve' | 'reject' }): Promise<void>;
}
```

The DecisionResponse comment body `buildDecisionResponseComment` produces (must match `extractMatchingChoice` in `resume-consumer.ts`):

```
<!-- pm-cockpit:effect:<decisionId>:write_response:<idempotencyKey> -->
**DecisionResponse**
```json
{"chosen_option":"<choice>"}
```
```

`parseCockpitAnswer` requires: the marker `pm-cockpit:effect:<decisionId>:write_response` (matched by regex with `\b` after `write_response`, so a trailing `:<key>` is fine), the literal `**DecisionResponse**`, and a fenced ```json block whose `chosen_option` ∈ {`approve`, `reject`} (it also accepts the legacy `approve-merge` alias). The decision_id is carried in the MARKER, not the JSON.

```typescript
// List: redaction is the return type — RankedListItem is already ref-free.
export function listPendingDecisions(
  readModel: ReadModel, query: ListRankedArgs,
): HandlerResult<RankedListItem[]> | HandlerResult<{ error: string }> {
  try { return { status: 200, body: readModel.listRanked(query) }; }
  catch { return { status: 503, body: { error: 'decision index unavailable' } }; }
}
```

```typescript
// Detail: 404 on missing, 503 on index failure; reveal is server-side (DetailView carries the ref).
const view = readModel.detail(id);
if (view === undefined) return { status: 404, body: { error: 'unknown decision' } };
return { status: 200, body: view };
```

```typescript
// Answer: look up detail (404 unknown), check answerable status (409), validate
// chosen_option ∈ options (400), THEN publish the DecisionResponse + 200. Never ledger.answer().
const detail = readModel.detail(id);                       // throw → 503
if (detail === undefined) return { status: 404, body: { error: 'unknown decision' } };
if (!ANSWERABLE_DECISION_STATUSES.includes(detail.status))
  return { status: 409, body: { error: 'decision is not answerable' } };
const chosen = body.chosen_option;
if (chosen === undefined || !detail.options.some((o) => o.id === chosen))
  return { status: 400, body: { error: 'chosen_option must be one of the decision options' } };
await publisher.publish({ decisionId: id, chosenOption: chosen as 'approve' | 'reject' }); // throw → 503
return { status: 200, body: { answered: true, chosen_option: chosen } };
```

## Gotchas

- **`ReadModel.detail(id)` is the rich view, not `ReadModel.get(id)`.** `get(id)` returns the thin `DecisionView` (no options/answer schema, no redaction-typed fields); `detail(id)` returns the `DetailView` with `DetailField`s carrying the resolvable `ref`. The detail handler must call `detail`, or the surface loses the options/answer-schema the Operator needs to answer.
- **Never resolve the protected `ref` in the handler's HTTP body for the LIST route.** `listRanked` returns `RankedListItem` whose `ListField` has no `ref` by type — do not "enrich" it by reaching into the protected store. The reveal is a server-side render concern on the DETAIL path only, inside the trusted Control Plane; leaking a resolved value into a list JSON response is the redaction-boundary violation this spec exists to prevent.
- **`manager.ledger()` throws — call it inside the `try`.** `DecisionIndexManager.ledger()` throws `/disabled/` (flag off) or `/unavailable/` (broken at startup). If the route adapter resolves the read-model OUTSIDE the handler's `try/catch`, that throw escapes and the response is a generic 500 (or worse). Resolve inside the protected region so disabled/broken both become a clean `503`.
- **NEVER call `ledger.answer()` from `answerDecision`.** The whole point of Option A is that the answer is delivered as a DecisionResponse comment the EXISTING `resumeParkedRuns` loop recognizes. A direct ledger write would record an answer the resume loop never observes — the run parks forever. The handler's only write is `publisher.publish(...)`; the ledger advance is the resume loop's job. This is the single most important rule of this spec.
- **The published marker MUST be the exact artifact `parseCockpitAnswer` recognizes.** `buildDecisionResponseComment` is the only place the wire format is constructed; its output is contract-tested by round-tripping through the REAL `parseCockpitAnswer` for both `approve` and `reject` (and asserting a DIFFERENT decision_id does NOT match, so no cross-epoch resume). Do NOT hand-write the marker anywhere else, and do NOT change the format without re-running that round-trip — `resume-consumer.ts` is `do_not_modify`.
- **A missing decision on answer is `404`; a non-answerable status is `409`; an invalid option is `400` — decided from the live `detail`, before any post.** The handler validates against `readModel.detail(id)` (unknown → `404`, status ∉ {notified, viewed} → `409`, `chosen_option` ∉ `options[].id` → `400`) so a malformed/stale answer never produces a DecisionResponse comment. The durable answered-once invariant still lives in the resume loop (OLDEST matching comment wins), not here.
- **Learned-attention ranking (`/decisions/pending`) is membership-preserving + fail-safe (FUNC-AC-OPERATOR-LEARNING rung 1).** `listPendingDecisions` takes an OPTIONAL injected `rankItems?: (items: InboxItem[]) => Promise<RankedItem[]>` (the daemon injects `operatorLearning.rankInboxItems`). The handler derives a learning key per row with the pure `deriveLearningKey(row)` — `decisionClass` from the `decision_id` phase segment (`…:l2-gate:…` → `l2_gate`, `…:integrate:…` → `merge_decision`, else neutral) and `context = ${owner}/${repo}` parsed from the GitHub-issue `source_url` (NEVER `deployment`) — so the key EXACTLY matches what `observeDecisionAnswer` recorded. Rows whose key is underivable get a PER-ROW neutral sentinel (reserved class `__neutral__` × `__neutral__:<decisionId>`) — the reserved class is never observed and the decisionId-scoped context can't equal a real or seeded observation key, so it matches no observation (zero boost) AND one seeded `__neutral__` entry can't boost every underivable row. Never dropped. The FULL row set is ranked.
- **The injected ranker is UNTRUSTED — validate ids AND explanation before trusting it; never let learning suppress an item or leak text.** Trust the output only when BOTH hold: (a) the returned `RankedItem` decision-id multiset equals the FULL base multiset EXACTLY (no missing/extra/duplicate over every row), AND (b) every item's `explanation` is well-formed at RUNTIME — `rung` is one of the literal enum values and `confidence`/`attentionWeight` are finite numbers (the TS type is not a runtime guarantee; an item with correct ids can still carry `rung: "surface protected://x"`). On either failure, a throw, or absent ranker → fall back to the base order (+ `console.warn`), 200 — the inbox must NEVER fail, hide an item, or stringify arbitrary text because learning hiccupped (a read-model throw is still a separate `503`). Only on full validation is the same set reordered. The learned note appended to `why_ranked` is ALLOWLISTED to the structured `explanation` fields `rung`/`confidence`/`attentionWeight` only (e.g. `· learned: rung=surface confidence=0.67 attentionWeight=1`) — never the row `context`, a protected field, or arbitrary ranker output; with zero learned signal the row is left byte-for-byte unchanged.
- **House rules (CI-enforced):** strict-boolean — use explicit `=== undefined` / `=== true`, never truthy coercion. ESM `.js` suffixes on every relative import. Keep the handlers free of `Date.now`/wall-clock on the decision path. `eslint src/ --suppressions-location .eslint-suppressions.json` must stay clean — do not add new suppression entries; fix lint at the source.

## Finding-dismissal decision flow (PR1)

A PARALLEL issue-level decision path that reuses this surface's transport — the decision-index ledger, the `/decisions/pending` inbox, and the binary `approve`/`reject` answer — WITHOUT touching `resumeParkedRuns` (a finding is a GitHub issue, not a parked run). It realizes FUNC-AC-OPERATOR-LEARNING rung-1 for the first NON-guarded decision class. Files: `control-plane/finding-dismissal/{labels,build-request,emit,apply-consumer,tick}.ts`.

- **The `decision_id` is the carrier of phase + category, and is REPO-SCOPED.** Strict shape `finding-<owner>/<repo>#<issue>:finding-dismissal:<category>:<epoch>` (`build-request.ts`). The ledger facade exposes no `phase`, and `deriveLearningKey` receives only `decision_id` + `source_url` — so every downstream parse (consumer filter, learning-key derivation) keys off this id. The `<owner>/<repo>` namespace is REQUIRED: without it, the same issue#/category/epoch in two repos would collide and the emit's `statusOf` gate would see the OTHER repo's row and suppress a valid decision. `<owner>/<repo>`/`<issue>` carry no `:`, so the id still splits into exactly 4 colon-segments. `category` ∈ the fixed review set (`correctness|consistency|security|performance|test-gaps`); `parseFindingDismissalDecisionId` is STRICT (malformed/short/wrong-phase/unknown-category/missing-namespace → `null`, never a mis-key).
- **`deriveLearningKey` extension.** A `…:finding-dismissal:…` id → `decisionClass = finding_dismissal:<category>` (from the id, since `RankedListItem` has no category field), `context = ${owner}/${repo}` (from `source_url`). This is BYTE-IDENTICAL to what the apply-consumer observes — the rung-1 ranking parity test asserts it.
- **Emit = raise → publish → notify, bounded + idempotent.** Mirrors the gate emit (`phases.ts`): `ledger.raise(sanitized)` → `GitHubBlockPublisher.ensure()` embeds the block in the issue BODY → `ledger.notify(decision_id)` (the notify is REQUIRED — `/decisions/pending` defaults to `notified/viewed`, so a raise-only `detected` row never surfaces). Emit ONLY for a parsed category AND (category ∈ `config.operatorReviewCategories` OR the `needs-discussion` human-route). `recommended_option` is UNSET (PR1 rung-1 only). Idempotent: deterministic repo-scoped id + a `statusOf` gate — re-emit runs only for an absent (`undefined`) or un-surfaced (`detected`) row, never a second OPEN decision.
- **Apply-consumer = the load-bearing DURABLE-FIRST ordering (closes a terminalization race).** A SIBLING scan beside `resumeParkedRuns` (NOT inside it). It scans `ledger.pending()` (EVERY non-terminal row — seeing an answered-but-not-terminalized row IS the crash-recovery), filters finding rows by the `:finding-dismissal:` id segment, and for a row whose issue carries an Operator `**DecisionResponse**` comment (`parseCockpitAnswer`, keep=approve/dismiss=reject) it DRIVES the answer itself (the `/answer` endpoint only posted a comment; a finding has no parked run, so THIS consumer must call `ledger.answer`). **THE RACE:** `ledger.answer()` advances the row to `answered_pending_source_write`, which queues the generic `write_response`→resume effect; the daemon's per-tick generic reconcile (runs BEFORE this consumer) — or a crash — can drive that to terminal `resumed` INDEPENDENTLY (`outbox.expectedEffect('answered_pending_source_write') === 'write_response'`), after which `ledger.pending()` no longer returns the row and any not-yet-written verdict/observation are LOST. Within-consumer await-ordering cannot prevent that (the LEDGER terminalizes out from under you). **THE FIX:** write the durable artifacts BEFORE `ledger.answer()`, making verdict + observation a strict PREREQUISITE of the ledger answer — then terminalization by ANYONE is harmless. Order, ALL AWAITED: verdict labels (`kept`/`dismissed`) + audit comment → `observeDecisionAnswer({sourceDecisionId})` → `ledger.answer` → `ledger.advanceToResumed`. Comments are PAGINATED (a DecisionResponse past the first 100 is still found). A crash/reconcile at ANY point re-applies idempotently (labels no-op, audit comment deduped by a marker, observation deduped by `sourceDecisionId` so a duplicate append does NOT inflate confidence, `ledger.answer` answered-once). A closed/moot issue → `supersede` (terminalize without applying). No comment yet → stays pending. (The requeue/resume effect a finding triggers is benign in v1 — the wired `AckResumeDispatcher` only records an in-memory ack, no GitHub `ready` label/reopen.)
- **`resumeParkedRuns` is untouched + disjoint.** It iterates parked RunState (`pausedAtPhase` ∈ {l2-gate, integrate}) and never reads `ledger.pending()`; a finding has no RunState. The consumer selects ONLY `:finding-dismissal:` rows. The two paths can never double-process.
- **Wiring is a thin gated call.** `runFindingDismissalTick` (`tick.ts`) is invoked beside `resumeParkedRuns` in the daemon poll callback, gated on `decisionManager.isAvailable()`. INSIDE the tick the two halves gate separately: EMIT (the review-finding list scan, PAGINATED) runs only when `config.operatorReviewCategories` is NON-EMPTY (the opt-in); the apply-CONSUMER runs WHENEVER the index is available (a cheap no-op scan when there are no finding rows) so answered decisions never dangle if the allowlist is later emptied. The default empty allowlist keeps EMIT dormant. Fully fail-safe (a throw is caught + logged, never crashes the tick).

## Concerns This Spec Does Not Cover

- The control-server route registration (the thin adapter that maps `GET /decisions/pending`, `GET /decisions/:id`, `POST /decisions/:id/answer` onto these handlers and the request-body read) lives in `server.ts`/`daemon.ts` wiring — including how the daemon resolves the gate issue number from the decision's `source_url` and the octokit token for the publisher. This spec governs the handler + publisher functions; the wiring is a thin adapter over them.
- Operator authentication and session (FUNC-AC-OPERATOR-AUTH / ARCH-AC-OPERATOR-AUTH) — enforced at the Surface Client; the trusted-local control server does not re-implement it.
- The decision index's read model, ranking, redaction typing, and the ledger's answer lifecycle (ARCH-AC-DECISION-ESCALATION and its L3s) — this spec consumes `ReadModel`/`DecisionLedger`, it does not define them.
- The Surface Client (dashboard) rendering of the inbox, briefing, drill-down, and the protected-value reveal in the authenticated detail view — a separate L3 under the dashboard/operator-surface client chain.
- Notification, delivery, and the daily-briefing batch/break-through rhythm (FUNC-AC-DECISION-ESCALATION / FUNC-AC-FLEET) — this API is a read/answer surface, not a delivery channel.
