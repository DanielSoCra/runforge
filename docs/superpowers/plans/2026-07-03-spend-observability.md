# Spend Observability (FUNC-AC-SPEND-OBSERVABILITY, #753) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-only cross-provider spend projection on the daemon Control Plane: a pure `SpendReadModel` over the #836 narrow readers, six thin `{ status, body }` `spend-api` handlers, an Operator-owned Zod-validated `PricingReference` JSON config store, and the minimal server/daemon route wiring — per STACK-AC-SPEND-OBSERVABILITY.

**Architecture:** Mirrors STACK-AC-OPERATOR-SURFACE-API (decision-api.ts): decision in a pure function, I/O at the edge. The read model injects the three narrow readers (`CostEventStore.listForWindow`, `RunStore.attributionFor`, `RepoStore.namesFor` — landed in #836), fetches the period window plus the immediately-preceding equal-length window, reconciles every amount to integer micro-units (`bigint` accumulation, decimal-integer strings on the wire), joins provider/project/completion-time into `SpendRecord[]`, and folds a `PeriodAggregate`. Fail-safety is structural: `StoreResult.unavailable` → typed `SpendUnavailableError` → handler `503`; empty period → zeroed `200`; unreconcilable rows → explicit `unreconciled` remainder; NULL provider/project → explicit `unattributed` bucket.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` relative-import suffixes), Zod v4, Vitest, `writeJsonSafe`/`readJsonSafe` from `packages/daemon/src/lib/json-store.ts`.

## Global Constraints

- **Never float money; never store/transport `bigint`.** Accumulate in `bigint` micro-units (1 money unit = 1,000,000 micros); every money field at rest and on the wire is a decimal-integer string (`/^-?\d+$/`; PricingReference fields are non-negative `/^\d+$/`), parsed to `bigint` at the read-model boundary. (L3 Gotcha 1.)
- **NULL `provider`/`usageUnits`/`projectId` = unattributed** — surfaced as an explicit bucket, never invented, guessed, or dropped from the total. (#836 landed semantics + L3 Gotcha 2.)
- **`StoreResult.unavailable` → `503`; branch on `category` (`unreachable`|`rejected`), never parse text.** Empty period → zeroed `200`, never 404. `503` is never "spend is zero". (L3 Gotchas 3–4.)
- **Apportion, don't full-charge:** `apportionedFee = feeMicros × windowMs / (periodDays × DAY_MS)` in `bigint` (generalizes the L3's whole-day example to custom ranges). (L3 Gotcha 5.)
- **Currency Marker is data-derived** (max completion timestamp of included records, `completedAt ?? recordedAt` fallback per record); `null` on an empty period, never `Date.now()`. Named-period resolution takes an injected `now` — no `Date.now()` inside the read model. (L3 Gotcha 6.)
- **Preceding window is equal-length AND immediately preceding, computed from the resolved window length** (works for custom ranges). (L3 Gotcha 7.)
- **Read-only authority:** no writer/ledger in any signature except the PricingReference set; setting re-values estimates only, never a recorded actual. Per-deployment scope only.
- **House rules (CI-enforced):** strict-boolean (`=== undefined`, never truthy coercion on optional micros strings), ESM `.js` suffixes, `eslint src/` clean without suppressions. Do not modify `packages/db`.
- **Traceability:** all code under `packages/daemon/src/control-plane/spend/**`; update `.specify/traceability.yml` is NOT needed (glob already covers it) but run `node scripts/check-traceability-paths.mjs`.

## File Structure

- `packages/daemon/src/control-plane/spend/types.ts` — `Window`, `PeriodQuery`, `SpendRecord`, `PeriodAggregate`, `ProviderShare`, `ProjectAttribution`, `SavingsComparison`, response envelopes, `SpendUnavailableError`.
- `packages/daemon/src/control-plane/spend/windows.ts` — `periodWindow(query, now)`, `precedingWindow(window)` (the one place, L3 Key Decision 4).
- `packages/daemon/src/control-plane/spend/pricing-reference.ts` — Zod schemas (`Micros`, `BillingShape`, `PricingReferenceSchema`) + `PricingReferenceStore` (JSON config at `state/pricing-reference.json`, atomic `writeJsonSafe`).
- `packages/daemon/src/control-plane/spend/read-model.ts` — `reconcile()`, `SpendReadModel` (headline / byProject / providerSplit / savings) over injected narrow readers.
- `packages/daemon/src/control-plane/spend/spend-api.ts` — `listPeriodSpend`, `spendByProject`, `providerSplit`, `savingsComparison`, `readPricingReference`, `setPricingReference` (thin `{status, body}` handlers, Zod-validated query/body at the boundary).
- Tests colocated: `windows.test.ts`, `pricing-reference.test.ts`, `read-model.test.ts`, `spend-api.test.ts`.
- Modify: `packages/daemon/src/control-plane/server.ts` (routes: `GET /spend/period|/spend/by-project|/spend/provider-split|/spend/savings`, `GET|PUT /spend/pricing-reference`; extend the CSRF header guard to PUT), `packages/daemon/src/control-plane/daemon.ts` (hold the spend readers from `createPostgresStores`, build read model + pricing store, wire handlers exactly like the decision-api precedent).

---

### Task 1: Plan doc (this file)

- [x] Commit: `plan(spend): implementation plan for STACK-AC-SPEND-OBSERVABILITY (#753)`

### Task 2: Types + windows (pure)

**Produces:** `Window {from: Date, to: Date}`, `PeriodQuery` (`{kind:'named', period:'today'|'7d'|'30d'}` | `{kind:'custom', from: Date, to: Date}`), `periodWindow(q, now): Window`, `precedingWindow(w): Window`, `SpendUnavailableError(category)`.

- [x] Write `windows.test.ts`: named periods resolve against injected `now` (today = UTC midnight→now... decision: `today` = `[startOfUtcDay(now), now)`; `7d`/`30d` = `[now − N days, now)`); custom passes through; preceding window is equal-length immediately before for both named and odd-length custom ranges.
- [x] Implement `types.ts` + `windows.ts`; tests green.
- [x] Commit: `feat(spend): period windowing + core types`

### Task 3: PricingReference store

**Produces:** `MicrosSchema` (`/^\d+$/`), `BillingShapeSchema` (discriminated union `metered` | `flat{feeMicros, periodDays, altMeteredPriceMicrosPerUnit?}`), `PricingReferenceSchema = z.record(providerId, BillingShape)`, `PricingReferenceStore{ read(): Promise<PricingReference>, write(ref): Promise<void> }` at `state/pricing-reference.json`.

- [x] Write `pricing-reference.test.ts`: round-trip write→read in a temp dir; missing file → `{}`; corrupt/invalid JSON → `{}` (logged, never a throw on the read path); schema rejects negative/float/decimal-string money, non-positive `periodDays`, unknown `kind`; `"0"` is a valid micros string (strict-boolean trap).
- [x] Implement with `writeJsonSafe`/`readJsonSafe`; tests green.
- [x] Commit: `feat(spend): Zod-validated PricingReference JSON config store`

### Task 4: SpendReadModel (pure, fake readers)

**Consumes:** `CostEventStore.listForWindow`, `RunStore.attributionFor`, `RepoStore.namesFor` types from `@auto-claude/db` (structural narrow interfaces `CostEventReader`/`RunReader`/`RepoReader` defined locally).
**Produces:** `reconcile(ev, shape)`, `SpendReadModel({costEvents, runs, repos, loadPricing, now})` with `headline(q)`, `byProject(q)`, `providerSplit(q)`, `savings(q, overrides?)`.

- [x] Write `read-model.test.ts` with hand-rolled reader fakes (no Postgres, no port):
  - reconcile: metered cost 1.5 → `1500000n`; flat with alt price values `usageUnits × alt`; flat without alt price (and no override) → unreconciled; flat with NULL `usageUnits` → unreconciled; unknown/NULL provider defaults to metered (cost is recorded truth).
  - headline: totals in micros strings; usage totals; per-provider split of money AND usage; NULL provider → `provider: null` unattributed bucket in split; unreconciled remainder `{count, usageUnits}`; deltas vs preceding window (signed strings); Currency Marker = max `completedAt ?? recordedAt`; empty period → zeroed totals, empty split, `currencyMarker: null`.
  - byProject: ranked desc by money, each with share, per-provider split, and the `SpendRecord[]` beneath (drill-down-ready); NULL/unjoinable `projectId` → single unattributed row, never dropped.
  - savings: per flat provider `apportionedFeeMicros` (pro-rated by windowMs/periodMs — a 1-day window over a 30-day sub apportions 1/30), `meteredEstimateMicros`, `savingMicros`, daily series within the window; no alt price → `comparisonAvailable: false` with known figures; per-read override replaces the configured alt price for this read only; metered providers absent from the comparison.
  - fail-safety: reader returns `{ok:false, error:'unavailable', category:'unreachable'}` → throws `SpendUnavailableError('unreachable')` (same for `rejected`).
- [x] Implement `read-model.ts`; tests green.
- [x] Commit: `feat(spend): pure SpendReadModel — reconcile, aggregate, savings, deltas`

### Task 5: spend-api handlers

**Produces:** six handlers returning `HandlerResult<T>` (imported from `../decision-api.js`), each taking its injected dep + the raw `URLSearchParams`/parsed JSON body and Zod-validating at the boundary.

- [x] Write `spend-api.test.ts` mirroring `decision-api.test.ts` style: 200 happy paths; malformed period query → 400; `SpendUnavailableError` → 503 (category logged, never rethrown); unexpected throw → 503; `setPricingReference` malformed body → 400 before any write, valid body → persisted then 200, write failure → 503; `readPricingReference` → 200 with stored config; savings `alt=<provider>:<micros>` overrides parsed, never persisted.
- [x] Implement `spend-api.ts`; tests green.
- [x] Commit: `feat(spend): control-plane spend API handlers`

### Task 6: Route wiring (server.ts + daemon.ts)

- [x] `server.ts`: add optional `ControlHandlers` fields (`getSpendPeriod`, `getSpendByProject`, `getSpendProviderSplit`, `getSpendSavings`, `getPricingReference`, `setPricingReference`); route each GET as a one-line `json(res, result.status, result.body)` adapter (mirroring `/metrics/escalation`); PUT `/spend/pricing-reference` reads the body with the existing 10KB-cap pattern (mirroring `/decisions/:id/answer`); extend the CSRF `X-Requested-By` guard from POST-only to POST+PUT; absent handler → `501` (decision-api precedent).
- [x] `daemon.ts`: hold `{costs, runs, repos}` readers next to `configReader` at store construction; at control-server wiring build `PricingReferenceStore(join(stateDir, 'pricing-reference.json'))` + `SpendReadModel` and pass the six closures.
- [x] Run `pnpm --filter @auto-claude/daemon typecheck` + the spend tests + `server.test.ts`.
- [x] Commit: `feat(spend): mount spend routes on the control plane`

### Task 7: Full verification

- [x] `pnpm --filter @auto-claude/daemon test` (no NEW failures vs origin/main; daemon-boot load flake is documented pre-existing), `pnpm --filter @auto-claude/daemon typecheck`, lint, `node scripts/check-traceability-paths.mjs`.
- [x] Codex review round if available; fix P1s.
- [x] Push + PR (`Closes #753`). Do not merge.
