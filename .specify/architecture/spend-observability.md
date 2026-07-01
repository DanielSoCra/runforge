---
id: ARCH-AC-SPEND-OBSERVABILITY
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-SPEND-OBSERVABILITY
---

# ARCH-AC-SPEND-OBSERVABILITY — Cross-Provider Spend Observability

## Overview

Spend observability is realized as a **read-only projection** over records the platform already owns, not as a new ledger of money. A **Spend Read Model** reads the platform's own per-unit cost records (the cost events attributed to runs, and the runs attributed to projects, owned by ARCH-AC-DATA-PLATFORM), reconciles every amount to one common money unit, and computes period-scoped aggregates — a single total, the per-provider split, the per-project attribution, and the flat-rate-versus-metered savings comparison — each alongside its change versus the immediately preceding equal-length period. A thin **Spend API** projects those aggregates over the Daemon Control Plane to the Dashboard (the surface that displays them, ARCH-AC-DASHBOARD).

The projection owns no second source of spend truth: it never records what a provider billed, never re-runs work to answer a question, and introduces only one new piece of persistent state — an Operator-controlled **Pricing Reference** that declares each provider's billing shape and the alternative metered price used to value flat-rate usage. Every figure is recomputed on demand from the immutable underlying records and the current Pricing Reference, so changing the period or an alternative price re-values estimates only and never alters a recorded actual. This mirrors the Operator Surface pattern (ARCH-AC-OPERATOR-SURFACE): a thin projection that owns its request/response surface and its access boundary but delegates the underlying truth to records another architecture owns.

One dependency crosses an architecture boundary. Cross-provider attribution requires every cost record to name the provider that incurred it. Today's cost event is attributed to a run and a session type but not explicitly to a provider; this architecture requires that the cost record carry — or be joinable to — the **provider** (the model-provider the session ran on, per FUNC-AC-RUNTIME-ADAPTERS). Adding that attribute is a structure change owned by ARCH-AC-DATA-PLATFORM and applied through its Migration Runner, not by this projection. Until a record can be attributed to a provider or a project, its spend is surfaced as **unattributed** — never hidden, never misassigned.

## Data Model

The projection introduces **one** new persistent entity and reads three it does not own.

New, Operator-owned:

- **Pricing Reference** — per provider, the configuration that makes incommensurable bills comparable. It declares the provider's **billing shape** — *metered* (cost accrues per unit of usage, already in the common money unit) or *flat* (a fixed **subscription fee** over a **subscription period**) — and, for a flat provider, an optional **alternative metered price reference**: a per-unit price at which that provider's usage is *estimated* under metered pricing. The Pricing Reference is configuration the Operator controls; it values estimates only and never changes a recorded actual. It is scoped per deployment.

Read, owned by ARCH-AC-DATA-PLATFORM (projected, never copied):

- **Cost Event** — a single cost amount attributed to a run and a session, carrying the **provider** that incurred it (the attribute this architecture requires Data Platform to add) and the time it was incurred. This is the atomic unit of spend.
- **Run** — the unit of work a cost event belongs to, itself attributed to a **project** (repository) and carrying the completion timestamp that places its spend in time.
- **Project** — the repository a run belongs to; the attribution target by which spend is ranked and split.

Derived, never stored (computed per request from the above):

- A **Spend Record** is a cost event reconciled to the common money unit and joined to its provider, project, and time — the row the aggregates sum over. A record that cannot be joined to a provider or a project is marked unattributed on that dimension.
- A **Period Aggregate** is the set of figures scoped to a chosen period: the total in the common money unit and in usage; the per-provider split (each provider's share of money and of usage); the per-project attribution (projects ranked by spend, each with its share of the period total and its split across providers, expandable to the records beneath it); and, for each flat provider, a **Savings Comparison**. Each headline figure carries its **delta** versus the immediately preceding equal-length period.
- A **Savings Comparison** is, for a flat provider over the chosen period: the **apportioned fee** (the subscription fee multiplied by the chosen period's share of the subscription period) set beside the **metered estimate** (the same usage valued at the alternative metered price reference), and the **saving or loss** between them — as a period total and as a within-period time series.
- A **Currency Marker** is the "current as of" timestamp: the latest completion time among the records included, so the Operator can tell how current the figures are.

## API Contract

The Spend API is mounted on the Daemon Control Plane's existing trusted-local control server (the same server that hosts the Operator Surface and run-control routes) and is reached only from the local host. Operator/Viewer authentication is enforced at the Surface Client (FUNC-AC-OPERATOR-AUTH); the API's own contract is period scoping, reconciliation to one common money unit, per-deployment scoping, and fail-safety. Every read takes a **period** (a named window such as today, the last seven days, the last thirty days, or a custom range) and is scoped to a single deployment; every money figure is returned in the common money unit; every headline figure carries its preceding-period delta and the response carries the Currency Marker.

- **Read period spend** — the unified headline: total money and usage for the period, the per-provider split, and the Currency Marker, each headline figure with its delta. Request: the period. Response: `200` with the Period Aggregate's headline and provider split; an empty period is a `200` with zeroed totals and an empty split — the success state, not an error.
- **Read spend by project** — the attribution view: projects ranked by spend, each with its share of the period total and its per-provider split, expandable to the records beneath; spend with no project is returned as a distinct **unattributed** row, never dropped. Request: the period. Response: `200` with the ranked projects plus the unattributed row.
- **Read provider split** — each provider's share of total money and of total usage for the period, distinctly. Request: the period. Response: `200` with the per-provider shares.
- **Read savings comparison** — for each flat provider over the period: apportioned fee, metered estimate, and the resulting saving or loss, as a total and as a within-period time series. Request: the period, and optionally an alternative metered price reference that overrides the configured one for this read only. Response: `200` with the comparison; a provider with no flat plan is simply absent from the comparison (it has nothing to compare), not an error.
- **Read or set the Pricing Reference** — read the per-provider billing shapes and alternative references; set them (Operator only). Setting re-values estimates only and never touches a recorded actual. Response: `200` on read; `200` on a valid set; `400` when a billing shape or price is malformed. Access is enforced at the Surface Client per FUNC-AC-OPERATOR-AUTH.

**Fail-safe across all reads:** when the underlying cost records are unavailable — the Data Service is unreachable or a Store read fails — the API responds `503` and never crashes the control server; a partial or unreconcilable set is reported as such (see Error Handling) rather than presented as a complete total.

## System Boundaries

- The Spend projection OWNS: the period-scoping, reconciliation-to-common-unit, fee apportionment, and delta-versus-preceding-period computations; the Pricing Reference configuration and its per-deployment scope; the Spend API request/response surface on the Control Plane; and the fail-safe mapping of record-source errors to `503`.
- The Spend projection READS: cost events, runs, and projects through ARCH-AC-DATA-PLATFORM's Store contracts (the cost-event and run stores). It never reaches the operational data store directly and never opens its own connection to it.
- The Spend projection REQUIRES (cross-architecture dependency): that each cost record name the provider that incurred it. Adding the provider attribute to the cost record is a structure change owned by ARCH-AC-DATA-PLATFORM and applied through its Migration Runner; this projection consumes that attribute, it does not create it.
- The Spend projection IS CONSUMED BY: the Dashboard / Surface Client (ARCH-AC-DASHBOARD), the only intended consumer, which renders the period selector, headline, provider split, project report, and savings view. Budget enforcement (FUNC-AC-SAFETY) is a second reader of the same measured spend; this architecture is the measurement it consumes — it does not enforce budgets itself.
- The Spend projection NEVER: changes what a provider actually bills (it reports and estimates only); records a second source of spend truth that could drift from the cost events (totals are always recomputed from, and reconcile with, the underlying records); sends usage or cost data to a third party or reads a provider's external invoice (the platform's own owned records are the source, per FUNC-AC-DATA-PLATFORM); crosses a deployment boundary (each deployment's spend stays within its own boundary and access rules, per FUNC-AC-FLEET); or re-runs work to answer a question.
- The trusted-local boundary: the control server binds to the local host and is not internet-facing; the Operator's identity and session live at the Surface Client per FUNC-AC-OPERATOR-AUTH. A reader without Operator or Viewer access to a deployment cannot see that deployment's spend.

## Event Flows

**Operator views spend for a period:**
1. The Surface Client requests period spend from the Spend API with the chosen period and deployment.
2. The API reads the period's cost events (with their providers, runs, and projects) through the Data Platform Stores, and the same shape of window for the immediately preceding equal-length period.
3. The Read Model reconciles each amount to the common money unit, sums the total and usage, and computes the per-provider split and the preceding-period deltas.
4. The API responds `200` with the headline, provider split, deltas, and Currency Marker; the client renders them. An empty period renders zeroed totals, not an error.

**Operator attributes spend to projects:**
1. The client requests spend-by-project for the period.
2. The Read Model groups the period's Spend Records by project, ranks projects by spend, computes each project's share and per-provider split, and gathers records with no project under a single unattributed row.
3. The API responds `200` with the ranked projects and the unattributed row; the client renders the ranking with per-project drill-down.

**Operator compares a flat plan against metered pricing:**
1. The client requests the savings comparison for the period (optionally overriding the alternative metered reference for this read).
2. For each flat provider, the Read Model apportions the subscription fee to the period (fee × the period's share of the subscription period) and values the period's usage at the alternative metered reference, producing the saving or loss as a total and a within-period series.
3. The API responds `200` with the comparison; the client renders fee-versus-estimate and savings-over-time.

**Operator changes an alternative price reference:**
1. The Operator sets a provider's alternative metered price reference through the Pricing Reference route.
2. The projection persists the new reference (configuration only) and the next read re-values the affected estimates; no recorded actual changes.

**Cost records unavailable mid-request:**
1. A read calls a Data Platform Store.
2. The Store reports unavailable (unreachable or rejected).
3. The route maps it to `503` and the control server keeps serving its other routes; the failure is contained to the spend surface and is never presented as a complete total of zero.

## Error Handling

**Records unavailable (Data Service unreachable or a Store read fails):** Respond `503` and keep the control server alive. The spend surface degrades to "unavailable" rather than crashing the Control Plane or any other route; the client surfaces unavailability calmly and never treats `503` as "spend is zero."

**Partial or unreconcilable records:** A period whose records cannot all be reconciled to the common money unit — a record missing the data needed to value it — is reported with the reconcilable total **and** an explicit unreconciled remainder, never silently dropped or folded into the total. The success criterion that totals reconcile with the underlying records is preserved by making any gap visible, not by hiding it.

**Unattributed spend:** A cost record that cannot be joined to a provider or a project is surfaced under an explicit unattributed provider/project, never assigned to an arbitrary one and never omitted from the total.

**Missing or malformed Pricing Reference:** A flat provider with no configured subscription fee or no alternative metered reference yields its known figures with the missing comparison marked unavailable for that provider — the rest of the view still renders. Setting a malformed billing shape or price is rejected `400` at the API boundary before anything is persisted, so a bad configuration never corrupts a later estimate.

**Stale figures:** Figures are only as current as the latest completed work included; the Currency Marker always accompanies them, so "out of date" is shown as a timestamp, never mistaken for "no spend."

**Access denied:** A reader without Operator or Viewer access to a deployment receives no spend for it; denial carries operational status only and never leaks a figure across a deployment boundary.
