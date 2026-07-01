---
id: STACK-AC-SPEND-OBSERVABILITY
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-SPEND-OBSERVABILITY
code_paths:
  - packages/daemon/src/control-plane/spend/**
test_paths:
  - packages/daemon/src/control-plane/spend/**/*.test.ts
---

# STACK-AC-SPEND-OBSERVABILITY — Cross-Provider Spend Observability (TypeScript)

> **Scope.** A read-only projection over Data-Platform-owned records: a pure `SpendReadModel` (period aggregation, reconciliation to one money unit, per-provider/per-project split, flat-vs-metered savings, preceding-period deltas) and a thin `spend-api` of `{ status, body }` handlers mounted on the daemon Control Plane — mirroring STACK-AC-OPERATOR-SURFACE-API. The one new persistent thing is an Operator-owned `PricingReference` config. This spec owns **no** second source of spend truth: every figure is recomputed on demand from `CostEventStore`/`RunStore`/`RepoStore` rows and the current `PricingReference`. The `provider` attribute on cost records is a Data-Platform schema change (STACK-AC-DATA-PLATFORM), consumed here, never created here.

## Pattern

**Pure `SpendReadModel` over injected Store readers; handlers are thin `{ status, body }` adapters.** The read model takes narrow readers (`CostEventReader`, `RunReader`, `RepoReader` — the query subset it needs, not the pooled `db` or the Store classes) and, per request, fetches the period window **and** the immediately-preceding equal-length window, reconciles each cost amount to one integer money unit, joins each `CostEvent` to its provider/project/completion-time to form `SpendRecord[]`, and folds those into a `PeriodAggregate` (money **and** usage totals, the per-provider split of *both*, project attribution — each ranked project carrying the `SpendRecord[]` beneath it so the by-project response is drill-down-ready — savings, deltas, Currency Marker). All arithmetic is a pure function of the fetched rows + the `PricingReference` — unit-tested with hand-rolled reader fakes, no Postgres, no port. Each API handler is `listPeriodSpend` / `spendByProject` / `providerSplit` / `savingsComparison` / `readPricingReference` / `setPricingReference`, taking its injected dep + parsed request and returning a typed `{ status, body }`; the Control-Plane route is a one-line adapter piping the result through the existing `json(res, status, body)` writer. This is the operator-surface-api split — decision in a pure function, I/O at the edge — reused verbatim.

**Money is reconciled in integer minor units; float money never appears.** A single `reconcile(event, pricing)` maps every provider's amount to one common integer unit (micro-units of the deployment money unit) so that summation, apportionment, and delta arithmetic are exact. A *metered* provider's event is already money → converted to minor units directly; a *flat* provider's usage is valued at its configured **alternative metered price reference**. Rounding to a display currency happens only at the presentation boundary, never mid-fold. This is the load-bearing numerical rule: cross-provider totals must reconcile with the underlying records (an L1 success criterion), and floating-point money silently breaks that.

**Fail-safety is structural: `StoreResult.unavailable` → `503`; empty → zeroed `200`; unreconcilable → visible remainder.** The read model consumes Data-Platform `StoreResult` values (never raw driver throws); on an `unavailable` outcome it branches on the already-categorized result (`unreachable` | `rejected`) and **throws a typed `SpendUnavailableError` carrying that category**, which the handler's `try/catch` maps to `{ status: 503 }` (logging the category) without crashing the control server — the spend surface degrades while every other Control-Plane route keeps serving. An **empty** period is the success state: `200` with zeroed totals and empty splits, never a `404`/error. Records that cannot be reconciled (missing the data to value them) are returned as a reconciled total **plus** an explicit `unreconciled` remainder; records with no joinable provider/project become an explicit `unattributed` bucket. Nothing is silently dropped or folded away — the gap is made visible, per the L2 error-handling contract.

**`PricingReference` is a Zod-validated JSON config store with atomic writes; it values estimates only.** The Operator-owned pricing config lives in a per-deployment JSON file (`state/pricing-reference.json`) written via the `writeJsonSafe` atomic-rename pattern (STACK-AC-CONVENTIONS), with a Zod schema as the single source of billing-shape + alternative-price truth. Money fields are carried as **decimal-integer strings** (micro-units) in both the stored JSON and the HTTP body — `JSON.stringify` throws on a `bigint` and a JSON payload carries none — and are parsed to `bigint` only inside the read model. `setPricingReference` validates the body against the schema at the boundary (`400` on malformed) **before** persisting, so a bad shape can never corrupt a later estimate; a set re-values estimates on the next read and never touches a recorded actual.

## Key Decisions

**Inject narrow readers, not `db`/Store classes.** Handlers and the read model take the minimal query surface (`CostEventReader.listForWindow(window)`, `RunReader.attributionFor(runIds)`, `RepoReader.namesFor(projectIds)`), resolved lazily inside the handler's `try` so a Store failure becomes a `503` rather than a wiring crash — the same lazy-resolve-inside-`try` rule as operator-surface-api's `manager.ledger()`. Narrow readers keep every unit trivially fakeable and keep the projection's *read-only* authority visible in its signatures (no writer, no ledger).

**Integer micro-units as the common money unit; `bigint` for accumulation.** Chosen over floating-point dollars (rounding drift breaks reconciliation) and over a decimal library (an added dependency for what integer minor units solve). Accumulate in `bigint`; **store and transport micros as decimal-integer strings** (a `bigint` is neither JSON-serializable nor present in a JSON request body), parsing to `bigint` at the read-model boundary and dividing to a display decimal only at the API boundary.

**`PricingReference` in a JSON config store, not the Postgres `global_settings` table.** Chosen because it is deployment-local configuration that values estimates only — not operational truth — so it needs no migration, no cross-service schema, and stays Operator-editable via the atomic-write convention. The `SettingsAccess`/`global_settings` table was considered and rejected: putting an estimate-only knob in the operational DB overstates its authority and drags a Drizzle migration for a single config document. (Revisit only if pricing must be shared across a fleet from one store.)

**Period windowing + preceding-equal-length delta live in one place.** A single `periodWindow(period)` resolves the named/custom period to `{ from, to }`; `precedingWindow(window)` is the equal-length span immediately before. Every headline figure carries its delta vs the preceding window, computed by the read model — never re-derived per handler. The **Currency Marker** is the max completion timestamp among the *included* records (data-derived), not a wall-clock read — which also honors the no-`Date.now()`-on-the-read-path house rule.

**Savings comparison apportions the flat fee by the period's share of the subscription period.** For each flat provider over the window: `apportionedFee = subscriptionFee × (windowLength / subscriptionPeriod)`; `meteredEstimate = Σ usage valued at the alternative metered price`; `saving = apportionedFee − meteredEstimate`, returned as a period total **and** a within-period time series (bucketed by day within the window). A flat provider with no configured alternative price yields its known figures with the comparison marked unavailable — the rest of the view still renders. `savingsComparison` also accepts an **optional per-read alternative-price override** (per L2): a transient alt price applied to *this read only* and never persisted to the `PricingReference`, so the Operator can what-if a reference without changing configuration. Absent the override, the configured alt price is used.

**Zod schemas are the single source for request/response + `PricingReference`.** Per STACK-AC-CONVENTIONS: one Zod schema per shape gives the TypeScript type (`z.infer`), runtime boundary validation, and (where needed) JSON Schema. The period query and the pricing-set body are validated against Zod at the handler boundary before any Store read or write.

## Examples

```typescript
// Handler result + the Pricing Reference Zod schema (single source of truth).
export interface HandlerResult<T> { status: number; body: T }
const Micros = z.string().regex(/^\d+$/);                 // decimal-integer micro-units — JSON-safe, parse to bigint internally
const BillingShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('metered') }),
  z.object({ kind: z.literal('flat'), feeMicros: Micros, periodDays: z.number().int().positive(),
             altMeteredPriceMicrosPerUnit: Micros.optional() }),
]);
export const PricingReference = z.record(z.string(), BillingShape); // key: providerId
```

```typescript
// Reconcile one event to integer micro-units — metered is money; flat usage is valued at the alt price.
function reconcile(ev: CostEvent, shape: BillingShape): { micros: bigint } | { unreconciled: CostEvent } {
  if (shape.kind === 'metered') return { micros: toMicros(ev.amount) };
  if (shape.altMeteredPriceMicrosPerUnit === undefined) return { unreconciled: ev };
  return { micros: BigInt(ev.usageUnits) * BigInt(shape.altMeteredPriceMicrosPerUnit) }; // string → bigint
}
```

```typescript
// Preceding-period delta: same length, immediately before.
function precedingWindow(w: Window): Window {
  const len = w.to - w.from;
  return { from: w.from - len, to: w.from };
}
```

```typescript
// Handler: fail-safe try/catch → 503; empty period is a zeroed 200, not an error.
export async function listPeriodSpend(rm: SpendReadModel, q: PeriodQuery): Promise<HandlerResult<PeriodHeadline>> {
  try { return { status: 200, body: await rm.headline(q.period) }; }   // empty → zeroed; unavailable → rm throws SpendUnavailableError
  catch { return { status: 503, body: { error: 'spend records unavailable' } as PeriodHeadline }; }
}
```

```typescript
// Flat-vs-metered apportionment (integer math throughout).
const apportionedFeeMicros = BigInt(shape.feeMicros) * BigInt(windowDays) / BigInt(shape.periodDays);
const savingMicros = apportionedFeeMicros - meteredEstimateMicros;   // per-read override, if given, replaces the configured alt price upstream
```

## Gotchas

- **Never use float for money — and never store/transport a `bigint`.** Accumulate in `bigint` micro-units; convert to a display decimal only at the API boundary. A `number` sum over many events drifts and breaks the "totals reconcile with the underlying records" success criterion. But `bigint` is *not* JSON-serializable (`JSON.stringify` throws) and does not appear in a JSON request body — so the `PricingReference` at rest and every money field on the wire is a **decimal-integer string**, parsed to `bigint` on the way in.
- **The `provider` attribute is added by Data Platform, not here.** This projection *reads* `CostEvent.provider`; adding the column is STACK-AC-DATA-PLATFORM's Drizzle migration. Until a record carries a provider (or is joinable to one), it must fold into the explicit `unattributed` bucket — do not crash, do not guess a provider, do not omit it from the total.
- **`StoreResult.unavailable` → `503`; branch on category, never parse text.** The read model consumes the Data-Platform `StoreResult` (`unreachable` vs `rejected`) as a *value*, branches on that category, and throws a typed `SpendUnavailableError` the handler's `try/catch` turns into `503`. Do not `try/catch` a raw driver throw and re-parse its message — the Store's `unavailableOnThrow` seam already categorized it; the only throw this layer raises is the typed, already-categorized one. (So the handler's `catch` fires on that typed error, never on a leaked `200`.)
- **`503` is "unavailable", never "spend is zero".** An empty period returns `200` zeroed; a Store failure returns `503`. The client must not render `503` as a zero total — keep the two states structurally distinct in the response type.
- **Apportion, don't full-charge.** A window shorter than the subscription period must pro-rate the fee by `windowDays / periodDays`; charging the whole subscription fee against a 1-day window is the classic savings-comparison bug.
- **Currency Marker is data-derived.** It is the max completion timestamp of the *included* records, not `Date.now()`. On an empty period there is no marker — return `null`, not the current time (which would falsely imply fresh data).
- **Preceding window is equal-length AND immediately preceding** — for custom ranges too. Compute it from the resolved window length, not from a named-period lookup table (which has no entry for a custom range).
- **Per-deployment scope only.** Never aggregate cost across deployments (FUNC-AC-FLEET); every read is scoped to a single deployment's records and access boundary.
- **House rules (CI-enforced):** strict-boolean — explicit `=== undefined` / `=== true`, never truthy coercion (test the optional `altMeteredPriceMicrosPerUnit` with `=== undefined`, never `!price` — a micros string `"0"` is truthy while `""` is falsy, so coercion silently misclassifies). ESM `.js` suffixes on every relative import. `eslint src/` must stay clean — fix at the source, do not add suppression entries.

## Concerns This Spec Does Not Cover

- **The `provider` schema change on `cost_events`** — owned by STACK-AC-DATA-PLATFORM (Drizzle forward-only migration + `CostEventStore` exposing the attribute). This spec consumes the attribute; it does not define or migrate it. This is the one cross-architecture dependency named in ARCH-AC-SPEND-OBSERVABILITY.
- **Operator/Viewer authentication and session** (STACK-AC-OPERATOR-AUTH) — enforced at the Surface Client on the trusted-local Control Plane; this API does not re-implement it.
- **The Control-Plane route registration** (the thin adapter mapping `GET /spend/period`, `/spend/by-project`, `/spend/provider-split`, `/spend/savings`, and `GET|PUT /spend/pricing-reference` onto these handlers + the request-body read) — lives in `server.ts`/`daemon.ts` wiring, a thin adapter over these functions.
- **The Dashboard rendering** — period selector, headline, provider split, ranked project report with drill-down, and the savings chart (STACK-AC-DASHBOARD / the operator-surface client chain). This spec is the read/answer surface, not the view.
- **Budget enforcement** (FUNC-AC-SAFETY) — a second reader of the same measured spend; this projection is the measurement it consumes, it does not enforce budgets.
- **Provider log/`ccusage` ingestion** — how the reference "Ledger" prototype (`~/code/agent-spend-dashboard`) sources usage from local logs is non-normative; the platform sources spend from its own `CostEventStore` records (FUNC-AC-DATA-PLATFORM), never a third-party or a provider's external invoice.
