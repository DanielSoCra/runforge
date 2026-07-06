---
id: FUNC-AC-SPEND-OBSERVABILITY
type: functional
domain: runforge
status: draft
version: 1
layer: 1
---

# FUNC-AC-SPEND-OBSERVABILITY — Cross-Provider Agent Spend Observability

## Problem Statement

The platform dispatches work to several reasoning-model providers, and it is bound to none of them by design. The Operator pays for that work in different shapes: some providers bill a flat periodic subscription, others bill per unit of usage. Each provider keeps its own record of what was consumed and what it cost — in its own place, in its own units. As a result the Operator cannot answer basic stewardship questions in one place: over a chosen period, how much did agent work cost in total; how does that split across providers; which projects and runs consumed it; and — because some providers are flat-rate — would the same usage have been cheaper or dearer under metered pricing.

This gap undermines promises the platform already makes. Budgets cannot be steered with evidence when spend is scattered across providers and expressed in incommensurable units. The Operator cannot tell which deployments or projects are consuming the scarce budget, cannot justify keeping or dropping a provider plan, and cannot see whether a flat-rate commitment is still paying for itself. Because the Operator's attention is the scarce resource, spend must be observable at a glance and attributable to the work that caused it — without the Operator reconciling provider invoices by hand.

## Actors

- **Operator** — steers the platform, sets budgets, and chooses provider plans; needs spend visible, attributable, and comparable to decide where money and budget go.
- **Viewer** — has read-only visibility into spend and cost reports but cannot change configuration.
- **Platform** — the autonomous system that performs the work and records, per unit of work, what was consumed and on which provider.

## Behavior

**Scenario: Unified spend for a period**
- Given agent work has run across more than one provider
- When the Operator views spend for a chosen period
- Then a single total cost and total usage is shown, expressed in one common money unit, regardless of how many providers were involved

**Scenario: Choose the period and compare to the one before**
- Given the Operator is viewing spend
- When they select a period (for example today, the last seven days, the last thirty days, or a custom range)
- Then every figure on the view is scoped to that period, and each headline figure is shown alongside its change relative to the immediately preceding period of equal length

**Scenario: Attribute spend to the work that caused it**
- Given spend exists for the chosen period
- When the Operator opens the spend-by-project view
- Then projects are ranked by spend, each with its share of the period total and the split of its spend across providers, and the Operator can expand a project to see the breakdown beneath it

**Scenario: Split spend by provider**
- Given spend exists across providers for the chosen period
- When the Operator views the provider breakdown
- Then each provider's share of total spend and of total usage is shown distinctly

**Scenario: Compare a flat-rate commitment against metered pricing**
- Given at least one provider is paid as a flat periodic subscription
- When the Operator views the savings comparison for the chosen period
- Then the view shows, side by side, what the period's usage actually cost (the subscription fee, apportioned to the period) and what the same usage would have cost under metered pricing, and states the resulting saving or loss — both as a total and over time within the period

**Scenario: Estimate a flat-rate provider's usage under alternative pricing**
- Given a provider whose usage carries no per-unit charge under its subscription
- When the Operator selects an alternative metered price reference for that provider
- Then the provider's usage is re-valued at that reference and reflected in the comparisons, without changing what was actually billed

**Scenario: Spend reflects the latest completed work**
- Given new agent work has completed since the spend view was last current
- When the Operator requests current figures
- Then the view reflects the latest completed work, and shows when it was last brought current

**Scenario: Spend visibility respects access**
- Given a person without Operator or Viewer access to a deployment
- When they attempt to see that deployment's spend
- Then they cannot

## Success Criteria

- For any chosen period, the Operator can see — in one place — total spend, the per-provider split, and the per-project attribution, without consulting any individual provider's records.
- Every unit of agent work's cost is attributable to the project (and the run) that caused it; spend that cannot be attributed to a project is shown as unattributed rather than hidden or misassigned.
- Totals shown reconcile with the sum of the underlying per-work records for the same period and providers.
- For each flat-rate provider, the Operator can obtain the period's apportioned fee and an estimate of the same usage under metered pricing, and a saving (or loss) derived from the two.
- All comparisons are recomputable for a different period or a different price reference without re-running the underlying work.
- The Operator can tell how current the figures are.

## Constraints

- Spend observability is read-only with respect to billing: it reports and estimates cost; it never changes what a provider actually bills.
- Coverage follows the platform's provider-agnostic stance: every provider the platform can dispatch work to is included, and adding a provider must not require redesigning how spend is observed.
- Money figures from different providers and pricing models are reconciled to one common unit and period before they are compared or summed.
- A flat periodic fee is apportioned to a period by the share of the period it covers, so that subscription cost and metered estimates are compared over the same span.
- Alternative metered price references are configuration the Operator controls; changing one re-values estimates only, never recorded actuals.
- Spend records are operational data the platform owns; observing spend must not require sending usage or cost data to a third party. (See FUNC-AC-DATA-PLATFORM.)
- Spend is observed per deployment: each deployment's spend stays within its own boundary and access rules.

## Related Specs

- **FUNC-AC-DASHBOARD** — the operator-facing surface on which spend, cost reports, and budgets are displayed. This spec defines *what* spend must be observable; the dashboard defines *where* it is shown.
- **FUNC-AC-DATA-PLATFORM** — owns the operational records (including per-run cost) that spend observability reads, and guarantees they are project-owned and recoverable.
- **FUNC-AC-SAFETY** — budget enforcement (daily and per-run) consumes spend observability; spend cannot be held within a budget it cannot measure.
- **FUNC-AC-FLEET** — each deployment bounds its own spend; spend must be observable and attributable per deployment.
- **FUNC-AC-RUNTIME-ADAPTERS** — the provider-agnostic execution layer; spend spans whichever providers the adapters dispatch to.

## Reference Implementation (non-normative)

> This section is illustrative, not part of the specification. It points to an existing working prototype that already demonstrates the behavior above, so a builder can see one concrete shape of the capability. The spec — not this prototype — is the source of truth; an implementation inside the platform may differ.

A standalone prototype, **"Ledger" — the agent-spend dashboard**, lives at `~/code/agent-spend-dashboard` (a local-only repository on the Operator's machine; no public remote). Built 2026-06-17/18 (see its `docs/execution-log.md`), it already realizes every scenario in this spec against the Operator's real local usage records:

- Unifies token usage and cost across the three providers the Operator runs today (Claude, Codex, Kimi) from local provider logs, into one common money unit.
- A global timeframe selector (today / 7 days / 30 days / custom) scopes the whole view, with a delta versus the preceding equal-length period.
- A spend-by-project report (ranked, share of total, per-project provider mix, drill-down), modeled on cloud cost-report tooling, with a cost/tokens metric toggle.
- A subscription-versus-metered-API comparison with savings over time, apportioning flat subscription fees across the selected period.
- An alternative-pricing overlay that re-values a flat-rate provider's usage at a chosen metered reference (e.g. an aggregator or the provider's own metered API), changing estimates only.

It is a single-Operator, loopback-bound tool reached over SSH — deliberately outside the platform. Folding the capability into the platform proper (per-deployment, access-controlled, sourced from the platform's own owned records under FUNC-AC-DATA-PLATFORM, and surfaced via FUNC-AC-DASHBOARD) is the work tracked by the implementation issue that accompanies this spec.
