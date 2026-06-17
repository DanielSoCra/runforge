---
id: STACK-AC-OPERATOR-SURFACE-API
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-OPERATOR-SURFACE
code_paths:
  - packages/daemon/src/control-plane/decision-api.ts
test_paths:
  - packages/daemon/src/control-plane/decision-api.test.ts
---

# STACK-AC-OPERATOR-SURFACE-API — Operator Surface Decision API (TypeScript)

> **Implemented scope (slice 7a = READ).** The shipped handlers are `listPendingDecisions` + `getDecisionDetail` (the `code_paths`/`test_paths` above). `answerDecision` is specified below as the target but is **deferred to the answer follow-up**: an answer must resume the parked run via the decision-escalation DecisionResponse transport (`resumeParkedRuns`), not a direct `ledger.answer()` (a parallel ledger write records an answer the resume loop never sees → the run strands). The answer sections below document that target design and are NOT yet in `decision-api.ts`.

## Pattern

**Pure-ish handler functions returning `{ status, body }`, wired into the control server by a thin route adapter.** The Decision API is three functions — `listPendingDecisions`, `getDecisionDetail`, `answerDecision` — each taking its injected dependency (the decision index `ReadModel` for reads, the `DecisionLedger` for the answer) plus the request params, and returning a typed `{ status: number; body: ... }`. This is chosen over inline route closures (the existing `server.ts` style) precisely so the behavior is unit-testable WITHOUT binding a port or issuing `fetch` — the handler is the unit under test, and the control-server route is a one-line adapter that calls the handler and pipes its result through the existing `json(res, status, body)` writer. It mirrors how the lane-engine and verifier-gate keep the *decision* in a pure function and the *I/O* at the edge.

**Fail-safe by `try/catch` → `503`, never a thrown error escaping the handler.** Every handler wraps its read-model / ledger call in `try/catch`; any throw — the index disabled (`ledger()` throws `/disabled/`), broken at startup (`/unavailable/`), or a read/write error — maps to `{ status: 503 }`. The handler never rethrows, so a wired route can never crash the control server: an unavailable decision index degrades the decision surface to `503` while every other control route keeps serving. This is the structural form of the L2 "index unavailable → 503 fail-safe" rule.

**Redaction is enforced by which read-model method the handler calls, not by post-filtering.** The list handler calls `ReadModel.listRanked(...)`, which returns `RankedListItem[]` whose protected fields are already class-only (`{ kind: 'protected', field, class }`, no resolvable `ref`). The detail handler calls `ReadModel.detail(id)`, which returns a `DetailView` carrying the resolvable `ref` for the server-side resolver. The handler does not strip or re-add fields — it returns exactly what the typed read-model method gives it, so the redaction boundary is the read model's type, not handler hygiene. The list result type structurally cannot carry a `ref`.

## Key Decisions

**Inject the `ReadModel` and `DecisionLedger`, not the `DecisionIndexManager`.** The handlers take the narrowest dependency they need: `listPendingDecisions`/`getDecisionDetail` take a `ReadModel` (it exposes `listRanked` and `detail`); `answerDecision` takes a `DecisionLedger` (it exposes `answer`). The manager's `ledger()` and the writer's public `reader: ReadModel` resolve these at wiring time. Injecting the narrow type keeps each handler trivially fakeable in tests with a hand-rolled object, and keeps the redaction boundary visible in the signature (a list handler that *only* has a `ReadModel` cannot accidentally reach a reveal path).

**The wiring resolves the dependency lazily inside a `try`, so a disabled/broken index becomes a `503`, not a wiring crash.** `DecisionIndexManager.ledger()` THROWS when the index is disabled or broken — so the adapter must call it *inside* the handler's protected region (or pass a thunk), letting the handler's `try/catch` convert the throw to `503`. The read-model is reached as `manager.ledger()` is — via the live writer's `reader` — so the same throw-to-503 contract covers reads. The handler signatures take the resolved `ReadModel`/`DecisionLedger`; a thin adapter that resolves-then-calls inside one `try` is acceptable, but the cleaner shape (and the one the tests pin) is a handler that accepts a resolver/throwing accessor — see Gotchas.

**Answer body validation is chosen-option XOR free-form answer, at the boundary, before the ledger.** The body type is `{ chosen_option?: string; answer?: string }`; the handler rejects (`400`) when both are present or neither is. The v1 `DecisionLedger.answer(decisionId, chosenOption, answerer, now?)` is option-shaped, so a free-form `answer` is delegated through the same `chosenOption` parameter slot (the ledger's `AnswerPayload.chosen_option` is the single recorded answer value in v1). Validating XOR at the boundary means a malformed request never reaches the durable, audited ledger transport.

**Status mapping delegates lifecycle outcomes to the ledger; the handler only translates.** `DecisionLedger.answer(...)` returns `AnswerResult { applied: boolean; status: string }`, returning `{ applied: false, status: 'unknown' }` for a missing row and THROWING `AnsweredOnceConflictError` on a conflicting answer. The handler maps `status === 'unknown'` → `404`, an `AnsweredOnceConflictError` → `409` (conflict), and otherwise `200` with the `AnswerResult` body. The handler never re-decides idempotency or answered-once — those are the ledger's invariants, surfaced through HTTP status.

## Examples

```typescript
export interface HandlerResult<T> { status: number; body: T }
export interface AnswerBody { chosen_option?: string; answer?: string; answerer?: string }
```

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
// Answer: XOR-validate, then delegate; map unknown→404, AnsweredOnceConflictError→409.
if ((body.chosen_option === undefined) === (body.answer === undefined))
  return { status: 400, body: { error: 'exactly one of chosen_option or answer required' } };
```

## Gotchas

- **`ReadModel.detail(id)` is the rich view, not `ReadModel.get(id)`.** `get(id)` returns the thin `DecisionView` (no options/answer schema, no redaction-typed fields); `detail(id)` returns the `DetailView` with `DetailField`s carrying the resolvable `ref`. The detail handler must call `detail`, or the surface loses the options/answer-schema the Operator needs to answer.
- **Never resolve the protected `ref` in the handler's HTTP body for the LIST route.** `listRanked` returns `RankedListItem` whose `ListField` has no `ref` by type — do not "enrich" it by reaching into the protected store. The reveal is a server-side render concern on the DETAIL path only, inside the trusted Control Plane; leaking a resolved value into a list JSON response is the redaction-boundary violation this spec exists to prevent.
- **`manager.ledger()` throws — call it inside the `try`.** `DecisionIndexManager.ledger()` throws `/disabled/` (flag off) or `/unavailable/` (broken at startup). If the route adapter resolves the ledger/read-model OUTSIDE the handler's `try/catch`, that throw escapes and the response is a generic 500 (or worse). Resolve inside the protected region so disabled/broken both become a clean `503`.
- **A missing decision on answer is `404`, not a silent `200`.** `DecisionLedger.answer` returns `{ applied: false, status: 'unknown' }` for an absent row (it does NOT throw `UnknownDecisionError` — that is swallowed by design to avoid stranding a parked run). The handler must inspect `status === 'unknown'` and return `404`, or the client shows a phantom success for a decision that was never recorded.
- **`AnsweredOnceConflictError` is a throw, not a status field.** A conflicting answer throws; a *replayed identical* answer returns `{ applied: false }` with a non-`unknown` status (a benign no-op → `200`). Distinguish them: catch `AnsweredOnceConflictError` → `409`; treat a non-conflict, non-unknown `applied:false` as an applied-no-op `200`. Do not collapse all `applied:false` into one status.
- **House rules (CI-enforced):** strict-boolean — use explicit `=== undefined` / `=== true`, never truthy coercion (the XOR check above is written as `(a === undefined) === (b === undefined)` deliberately). ESM `.js` suffixes on every relative import. Keep the handlers free of `Date.now`/wall-clock on the decision path; the ledger takes an optional `now` for tests, so thread a clock through rather than reading the clock in the handler.

## Concerns This Spec Does Not Cover

- The control-server route registration (the thin adapter that maps `GET /decisions/pending`, `GET /decisions/:id`, `POST /decisions/:id/answer` onto these handlers and the request-body read) — that lands in `server.ts`/`daemon.ts` wiring in the implementation PR; this spec governs the handler functions.
- Operator authentication and session (FUNC-AC-OPERATOR-AUTH / ARCH-AC-OPERATOR-AUTH) — enforced at the Surface Client; the trusted-local control server does not re-implement it.
- The decision index's read model, ranking, redaction typing, and the ledger's answer lifecycle (ARCH-AC-DECISION-ESCALATION and its L3s) — this spec consumes `ReadModel`/`DecisionLedger`, it does not define them.
- The Surface Client (dashboard) rendering of the inbox, briefing, drill-down, and the protected-value reveal in the authenticated detail view — a separate L3 under the dashboard/operator-surface client chain.
- Notification, delivery, and the daily-briefing batch/break-through rhythm (FUNC-AC-DECISION-ESCALATION / FUNC-AC-FLEET) — this API is a read/answer surface, not a delivery channel.
