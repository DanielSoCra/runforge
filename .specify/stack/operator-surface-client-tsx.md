---
id: STACK-AC-OPERATOR-SURFACE-CLIENT
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-OPERATOR-SURFACE
code_paths:
  - packages/dashboard/app/api/decisions/pending/route.ts
  - packages/dashboard/components/decisions/decision-inbox.tsx
  - packages/dashboard/app/(dashboard)/page.tsx
test_paths:
  - packages/dashboard/components/decisions/decision-inbox.test.tsx
  - packages/dashboard/app/api/decisions/pending/route.test.ts
---

# STACK-AC-OPERATOR-SURFACE-CLIENT — Operator Surface Client: decisions inbox (Next.js dashboard)

> **Implemented scope (slice 7b = READ inbox).** This increment ships the **read** half of the Surface Client: the ranked pending-decisions inbox on the default dashboard view, fed by a daemon-proxy route that projects the daemon Decision API's `GET /decisions/pending` (STACK-AC-OPERATOR-SURFACE-API, shipped in 7a). The per-run **drill-down** (`GET /decisions/:id` detail with server-side protected reveal) and the operator **ANSWER** flow are **deferred follow-ups** — the answer must resume the parked run through the decision-escalation DecisionResponse transport (`resumeParkedRuns`), not a direct ledger write, so it lands with the detail surface. This spec governs the inbox list (proxy route + presentational component + home wiring) only; it documents the deferred pieces so the next increment slots in without re-deciding the boundary.

## Pattern

**Daemon-proxy route → server component fetch → pure presentational component.** The inbox is three layers with one responsibility each. (1) A Next.js App Router route handler at `app/api/decisions/pending/route.ts` is the dashboard's only door to the daemon control server's `/decisions/pending`; it reaches the daemon through the shared `daemonFetch` helper (`lib/daemon-fetch.ts`), never raw `fetch` to a hand-built URL. (2) The default dashboard server component (`app/(dashboard)/page.tsx`) fetches the inbox server-side and passes a plain `RankedListItem[]` into the view. (3) `components/decisions/decision-inbox.tsx` exports a **pure presentational** `DecisionInbox({ items, unavailable })` that renders rows, empty state, and degraded state from props alone — no `fetch`, no `await`, no store access — so it is unit-testable with a hand-rolled `RankedListItem[]` and renders identically on server and client. This mirrors the existing `BriefingCard` (props-only presentational) + server-page-fetches-then-renders split already used across the dashboard.

**Redaction is rendered by discriminating on the `ListField.kind`, never by reading a value off a protected field.** Each row's `question` (and any other `ListField`) is a discriminated union: `{ kind: 'text'; value }` renders its `value`; `{ kind: 'protected'; field; class }` renders a redaction chip reading `[protected: <class>]` and the protected `field` name — and **nothing else**. The list `ListField` type structurally has no resolvable `ref` (that lives only on the detail `DetailField`), so the component *cannot* leak a protected value: the redaction boundary is the type the daemon API already enforced, and the renderer's job is only to never invent a reveal. A protected field is rendered by its class marker, exactly as the row arrived.

**Daemon-unavailable degrades to a calm panel, never a crash.** The proxy route maps a daemon `503`/unreachable/`DaemonConfigError`/non-JSON body to a typed degraded response the UI can render (`{ items: [], unavailable: true }`), not a thrown error — mirroring the existing `app/api/daemon/status/route.ts` fallback (`503` → `{ state: 'offline' }`). The presentational component renders three terminal states from props: a row per item; a calm **empty state** ("No decisions awaiting you") for `items: []` with `unavailable !== true`; and a **degraded state** ("Decisions are temporarily unavailable") when `unavailable === true`. An empty inbox is the *success* state (L1: "an empty inbox is the success state, not a gap to fill"), visually distinct from the degraded state.

**Mobile-first responsive: cards stack on narrow screens, denser layout on wide.** Mobile is a contract, not an adaptation (L1: "a surface that steers only from a desk does not satisfy this specification"). The inbox renders each decision as a self-contained card in a single stacked column by default (`flex flex-col` / `space-y-*`), with wider breakpoints (`sm:`/`md:`) only *adding* density (e.g. inlining risk badge + timestamp on one row) — never *requiring* width to be usable. No fixed pixel widths, no horizontal scroll, no desktop-only column. Every row's content (risk class, question, created_at) is reachable on a narrow viewport.

## Key Decisions

**The presentational component takes `items: RankedListItem[]` + `unavailable?: boolean`, not a fetch promise.** Separating the pure render from data fetching is what lets the component test assert rows / empty / degraded / redaction with a hand-rolled array and zero network mocking. The server component (or a future client wrapper for realtime refresh) owns the fetch; `DecisionInbox` owns only the pixels. This is the same seam as `BriefingCard(briefing)` and `LivePanels(activeRuns, ...)` already in the tree.

**Mirror `RankedListItem`/`ListField` as a dashboard-local type, do not import `@auto-claude/decision-index`.** The dashboard package does **not** depend on `@auto-claude/decision-index` (it would pull the native better-sqlite/drizzle index into the Next.js bundle). The inbox defines the narrow read-only shape it renders — `RankedListItem` with the fields it actually shows (`decision_id`, `status`, `risk_class`, `created_at`, `question`, `score`, `why_ranked`, …) and the `ListField` discriminated union — as a local TS type co-located with the component, kept structurally compatible with the daemon's wire shape. The boundary is JSON over HTTP, so a structural mirror is the correct coupling, not a package dependency.

**The proxy route is read-only `GET` and reuses `daemonFetch`; it does not re-implement the daemon URL or CSRF.** `daemonFetch(path)` already injects the base URL, the `X-Requested-By: dashboard` header, and a 5s `AbortSignal.timeout`. The route passes `/decisions/pending` (forwarding `request.nextUrl.searchParams` when present, so focus/filters round-trip) and returns the parsed JSON on `200`. It does not add auth here beyond what the platform already enforces — operator auth is FUNC-AC-OPERATOR-AUTH at the surface; this route follows whatever the sibling daemon routes do (`requireDashboardUser` is the established read-route guard) so it stays consistent with `app/api/daemon/status/route.ts`.

**Degraded is a data shape, not an HTTP error the client must interpret.** Rather than make the component branch on HTTP status codes, the route normalizes every non-success daemon condition to `{ items: [], unavailable: true }` (and the success path to `{ items }` / the daemon's array). The component then renders purely off `unavailable`, so "daemon down" and "index disabled" and "config missing" all surface as the same calm panel — the client "never treats `503` as data loss" (L2 error handling).

## Examples

```typescript
// components/decisions/decision-inbox.tsx — the local wire mirror (no decision-index import).
export type ListField =
  | { kind: 'text'; value: string }
  | { kind: 'protected'; field: string; class: string };
export interface RankedListItem {
  decision_id: string; status: string; risk_class: string;
  created_at: string; question: ListField; score: number; why_ranked: string;
}
export interface DecisionInboxProps { items: RankedListItem[]; unavailable?: boolean }
```

```tsx
// Redaction render: discriminate on kind — a protected field NEVER prints a value.
function QuestionField({ field }: { field: ListField }) {
  if (field.kind === 'protected')
    return <span className="...">[protected: {field.class}]</span>;
  return <span>{field.value}</span>;
}
```

```tsx
// Three terminal states, props-only (empty = success, distinct from degraded).
if (unavailable === true) return <Card>…Decisions are temporarily unavailable…</Card>;
if (items.length === 0) return <Card>…No decisions awaiting you…</Card>;
return <div className="flex flex-col gap-3">{items.map((d) => <DecisionRow key={d.decision_id} item={d} />)}</div>;
```

```typescript
// app/api/decisions/pending/route.ts — proxy via daemonFetch; degrade, never throw.
const res = await daemonFetch(`/decisions/pending${search}`, { cache: 'no-store' });
const json = await res.json().catch(() => null);
if (!res.ok || json === null) return NextResponse.json({ items: [], unavailable: true });
return NextResponse.json({ items: Array.isArray(json) ? json : (json.items ?? []) });
// catch (DaemonConfigError | network) → NextResponse.json({ items: [], unavailable: true })
```

## Gotchas

- **Never render a protected `ListField.value` — there is no `value` on a protected field.** The protected arm is `{ kind: 'protected'; field; class }` with no `value`/`ref` by type; render only `[protected: <class>]` (and optionally the `field` name). Reaching for a value on the protected arm is a type error *and* the redaction-boundary violation this whole chain exists to prevent. The list never reveals; reveal is server-side on the deferred detail path only.
- **Keep `DecisionInbox` a pure component (no `fetch`/`await`/`'use client'` unless realtime is added).** The test renders it directly with a mock array; if it fetches, the unit test must mock the network and it stops being a pure render. The server page does the fetch. (A future realtime-refresh wrapper may be a client component that *passes* fetched items down — the presentational core stays pure.)
- **Empty state ≠ degraded state.** `items: []` with `unavailable` falsy is the calm success state ("No decisions awaiting you"); `unavailable: true` is the degraded panel. Do not collapse them — the L1 distinguishes "nothing waits on you" (success) from "the surface can't reach the data" (degraded), and the operator must be able to trust the empty state.
- **The proxy must degrade, not 500.** A daemon `503`/timeout/`DaemonConfigError`/non-JSON body must become `{ items: [], unavailable: true }` (HTTP `200` to the client is fine — the degraded flag carries the state). If the route rethrows or returns a 500, the home server component's `fetch` throws and the *whole dashboard page* errors — the opposite of the calm-pane contract.
- **Reuse `daemonFetch`, do not hand-build `process.env.DAEMON_URL + path`.** The helper centralizes the base-URL normalization, the `X-Requested-By` CSRF header, and the timeout. The home `page.tsx` currently inlines a raw `fetch` for `/status` (a pre-existing wart); the new decisions proxy route is the correct pattern — route handler + `daemonFetch` — and the home page should call the *proxy route* or reuse `daemonFetch` for the inbox, not add a second raw-fetch inline.
- **Mobile-first means base styles stack; breakpoints only add.** Author the narrow-screen layout as the default (`flex-col`, full-width cards) and use `sm:`/`md:` prefixes to *enhance* (inline a row, add columns). Authoring desktop-first and hiding things on mobile risks reserving content for a desktop screen — explicitly forbidden by the L1 mobile contract.
- **`created_at` is an ISO string from the wire — format at the edge.** Render it as a stable, locale-light label (or a relative "Xh ago"); do not assume a `Date` object. Keep formatting deterministic enough for the test to assert (the test asserts the timestamp is present per row).

## Concerns This Spec Does Not Cover

- The **per-run / per-decision drill-down** (`GET /decisions/:id` detail, the `DetailView` with server-side protected reveal inside the trusted Control Plane) — a deferred follow-up increment; the reveal must never happen in this client.
- The operator **ANSWER** flow (submitting a chosen option / free-form answer) — deferred; it routes through the decision-escalation DecisionResponse resume transport (`resumeParkedRuns`), not a dashboard ledger write, per ARCH-AC-OPERATOR-SURFACE's sequencing note.
- The **daily briefing** content and rhythm (batch vs break-through) — owned by FUNC-AC-DECISION-ESCALATION / FUNC-AC-FLEET and rendered by the existing `BriefingCard`; this spec only places the inbox *alongside* the briefing on the default view.
- **Inbox ranking and focus semantics** (the order, `score`, `why_ranked`, cross-deployment focus) — owned by FUNC-AC-FLEET and computed by the daemon read model; the client renders the order it receives and does not re-rank.
- **Operator authentication / session** (FUNC-AC-OPERATOR-AUTH) — enforced by the platform's existing route guards (`requireDashboardUser`); this spec consumes that guard, it does not define auth.
- **Playwright e2e** of the inbox on a real mobile viewport — a deferred follow-up; the component unit test covers redaction/empty/degraded/rows, and the e2e covers the rendered route + responsive behavior end-to-end.
- The **daemon Decision API** itself (`/decisions/pending` projection, redaction typing, `503` fail-safe) — STACK-AC-OPERATOR-SURFACE-API; this client consumes that contract.

## Traceability

- **Parent (L2):** ARCH-AC-OPERATOR-SURFACE — the Surface Client renders the minimal inbox + briefing against the Decision API; redaction is class-only on the list; `503` degrades calmly.
- **Sibling (L3):** STACK-AC-OPERATOR-SURFACE-API — the daemon Decision API this client's proxy route consumes (`GET /decisions/pending`).
- **Functional (L1):** FUNC-AC-OPERATOR-SURFACE — default view = decisions inbox + briefing; empty inbox is the success state; mobile is a non-negotiable requirement; outcome-first.
- **Related (L2):** ARCH-AC-DASHBOARD (the management surface this default view lives within), ARCH-AC-DECISION-ESCALATION (the inbox/decision semantics this surface fronts), ARCH-AC-OPERATOR-AUTH (the session enforced at the surface).
- **code_paths:** the proxy route, the inbox component, and the home-page wiring (above).
- **test_paths:** the component test (redaction/empty/degraded/rows) and the proxy-route test (above).
