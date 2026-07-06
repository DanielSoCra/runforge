---
id: STACK-AC-OPERATOR-SURFACE-CLIENT
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-OPERATOR-SURFACE
code_paths:
  - packages/dashboard/app/api/decisions/pending/route.ts
  - packages/dashboard/app/api/decisions/answer/route.ts
  - packages/dashboard/components/decisions/decision-inbox.tsx
  - packages/dashboard/components/decisions/decision-answer.tsx
  - packages/dashboard/app/(dashboard)/steering/page.tsx
test_paths:
  - packages/dashboard/components/decisions/decision-inbox.test.tsx
  - packages/dashboard/components/decisions/decision-answer.test.tsx
  - packages/dashboard/app/api/decisions/pending/route.test.ts
  - packages/dashboard/app/api/decisions/answer/route.test.ts
  - packages/dashboard/app/(dashboard)/steering/page.test.tsx
---

# STACK-AC-OPERATOR-SURFACE-CLIENT — Operator Surface Client: decisions inbox (Next.js dashboard)

> **Implemented scope (slice 7b = READ inbox; slice 7c-ui = ANSWER modal).** The first increment shipped the **read** half of the Surface Client: the ranked pending-decisions inbox on the dedicated operator-surface route (`app/(dashboard)/steering/page.tsx`), alongside the briefing, fed by a daemon-proxy route that projects the daemon Decision API's `GET /decisions/pending` (STACK-AC-OPERATOR-SURFACE-API, shipped in 7a). **Slice 7c-ui adds the operator ANSWER affordance**: each inbox row gets an "Answer" control that opens a modal listing the decision's options (approve/reject); choosing one POSTs through a new daemon-proxy route `app/api/decisions/answer/route.ts` to the daemon's `POST /decisions/:id/answer` (shipped in 7c). The daemon — NOT this client — then publishes a DecisionResponse the resume loop (`resumeParkedRuns`) consumes; the dashboard never writes the ledger, it only drives the answer HTTP transport. The per-run **drill-down** (`GET /decisions/:id` detail with server-side protected reveal) remains a deferred follow-up. This spec governs the inbox list, the answer modal, and both proxy routes (+ steering-route wiring); it documents the deferred drill-down so the next increment slots in without re-deciding the boundary.

## Pattern

**Daemon-proxy route → server component fetch → pure presentational component.** The inbox is three layers with one responsibility each. (1) A Next.js App Router route handler at `app/api/decisions/pending/route.ts` is the dashboard's only door to the daemon control server's `/decisions/pending`; it reaches the daemon through the shared `daemonFetch` helper (`lib/daemon-fetch.ts`), never raw `fetch` to a hand-built URL. (2) The **operator-surface server component** (`app/(dashboard)/steering/page.tsx` — its OWN route, NOT the management home `app/(dashboard)/page.tsx` which is governed by FUNC-AC-DASHBOARD) fetches the inbox server-side and passes a plain `RankedListItem[]` into the view, alongside the briefing. (3) `components/decisions/decision-inbox.tsx` exports a **pure presentational** `DecisionInbox({ items, unavailable })` that renders rows, empty state, and degraded state from props alone — no `fetch`, no `await`, no store access — so it is unit-testable with a hand-rolled `RankedListItem[]` and renders identically on server and client. This mirrors the existing `BriefingCard` (props-only presentational) + server-page-fetches-then-renders split already used across the dashboard.

**The operator surface is its OWN route — decisions + briefing ONLY, not bolted onto the management home.** Per FUNC-AC-OPERATOR-SURFACE the operator surface is a calm pane of *decisions + briefing*; the management content (StatsCards + RunTable, governed by the separate FUNC-AC-DASHBOARD) stays on the home `app/(dashboard)/page.tsx`. The steering route (`app/(dashboard)/steering/page.tsx`) renders `<BriefingCard>` (briefing fetched via the existing `getLatestBriefing()` server action — reuse, the same way `app/(dashboard)/briefing/` fetches it) followed by `<DecisionInbox>`, and nothing else.

**Redaction is rendered by discriminating on the `ListField.kind`, never by reading a value off a protected field.** Each row's `question` (and any other `ListField`) is a discriminated union: `{ kind: 'text'; value }` renders its `value`; `{ kind: 'protected'; field; class }` renders a redaction chip reading `[protected: <class>]` and the protected `field` name — and **nothing else**. The list `ListField` type structurally has no resolvable `ref` (that lives only on the detail `DetailField`), so the component *cannot* leak a protected value: the redaction boundary is the type the daemon API already enforced, and the renderer's job is only to never invent a reveal. A protected field is rendered by its class marker, exactly as the row arrived.

**Daemon-unavailable degrades to a calm panel, never a crash.** The proxy route maps a daemon `503`/unreachable/`DaemonConfigError`/non-JSON body to a typed degraded response the UI can render (`{ items: [], unavailable: true }`), not a thrown error — mirroring the existing `app/api/daemon/status/route.ts` fallback (`503` → `{ state: 'offline' }`). The presentational component renders three terminal states from props: a row per item; a calm **empty state** ("No decisions awaiting you") for `items: []` with `unavailable !== true`; and a **degraded state** ("Decisions are temporarily unavailable") when `unavailable === true`. An empty inbox is the *success* state (L1: "an empty inbox is the success state, not a gap to fill"), visually distinct from the degraded state.

**Mobile-first responsive: cards stack on narrow screens, denser layout on wide.** Mobile is a contract, not an adaptation (L1: "a surface that steers only from a desk does not satisfy this specification"). The inbox renders each decision as a self-contained card in a single stacked column by default (`flex flex-col` / `space-y-*`), with wider breakpoints (`sm:`/`md:`) only *adding* density (e.g. inlining risk badge + timestamp on one row) — never *requiring* width to be usable. No fixed pixel widths, no horizontal scroll, no desktop-only column. Every row's content (risk class, question, created_at) is reachable on a narrow viewport.

**The ANSWER flow is a pure-dialog + fetch-wrapper split, fronting a daemon-proxy mutation route.** The answer affordance is three testable pieces (`components/decisions/decision-answer.tsx`). (1) `DecisionAnswerDialog({ decision, onAnswer, pending, error })` is a **pure presentational** shadcn `Dialog`: the row's "Answer" trigger opens it, it lists the decision's `options` as choice controls (approve/reject), and it renders pending (controls disabled) / error (a calm message) from props alone — no `fetch`, so the gate tests it with a hand-rolled decision and a spy `onAnswer`. (2) `submitDecisionAnswer(decisionId, chosenOption)` is the **fetch wrapper** — `POST /api/decisions/answer` with `{ decision_id, chosen_option }` — returning a typed `AnswerResult` (never throwing). (3) `DecisionAnswer({ decision, onAnswered })` is the thin client wrapper the inbox row mounts: it wires the dialog to the wrapper and owns the pending → success (notify `onAnswered`, the row leaves) / error (row stays, calm message) state machine. The browser-facing proxy `app/api/decisions/answer/route.ts` is a **POST** handler mirroring the sibling mutation proxies (`app/api/daemon/*/route.ts`): guard with `requireDashboardAdmin` + `getDashboardAuthError` (answering resumes a parked run — a state-changing mutation; viewers are read-only, so it uses the privileged gate like every other daemon mutation proxy), forward via `daemonFetch('/decisions/' + encodeURIComponent(decision_id) + '/answer', { method: 'POST', body: JSON.stringify({ chosen_option }) })` (the helper injects the `X-Requested-By: dashboard` CSRF header), and return the daemon's status + JSON verbatim (200 / 400 / 404 / 409 / 503), mapping unreachable → 503, `DaemonConfigError` → 500, non-JSON body → 502.

**Optimistic-confirmed answer UX: the answered decision leaves the pending inbox; 409/error keep it with a calm message.** On a daemon `200` the wrapper notifies `onAnswered(decision_id)` so the row drops (it would drop from the next `/decisions/pending` fetch regardless — the resume loop consumes the response and advances the decision past the answerable set). On `409` ("not answerable" — answered-once / out-of-band-resolved) or any error/unreachable, the wrapper surfaces a calm message inside the dialog and KEEPS the row; it never crashes the surface. The answer transport only recognizes `approve`/`reject` (`AnswerChoice`); an unsupported option id is a daemon `400` the UI shows calmly.

## Key Decisions

**The presentational component takes `items: RankedListItem[]` + `unavailable?: boolean`, not a fetch promise.** Separating the pure render from data fetching is what lets the component test assert rows / empty / degraded / redaction with a hand-rolled array and zero network mocking. The server component (or a future client wrapper for realtime refresh) owns the fetch; `DecisionInbox` owns only the pixels. This is the same seam as `BriefingCard(briefing)` and `LivePanels(activeRuns, ...)` already in the tree.

**Mirror `RankedListItem`/`ListField` as a dashboard-local type, do not import `@runforge/decision-index`.** The dashboard package does **not** depend on `@runforge/decision-index` (it would pull the native better-sqlite/drizzle index into the Next.js bundle). The inbox defines the narrow read-only shape it renders — `RankedListItem` with the fields it actually shows (`decision_id`, `status`, `risk_class`, `created_at`, `question`, `score`, `why_ranked`, …) and the `ListField` discriminated union — as a local TS type co-located with the component, kept structurally compatible with the daemon's wire shape. The boundary is JSON over HTTP, so a structural mirror is the correct coupling, not a package dependency.

**The proxy route is read-only `GET` and reuses `daemonFetch`; it does not re-implement the daemon URL or CSRF.** `daemonFetch(path)` already injects the base URL, the `X-Requested-By: dashboard` header, and a 5s `AbortSignal.timeout`. The route passes `/decisions/pending` (forwarding `request.nextUrl.searchParams` when present, so focus/filters round-trip) and returns the parsed JSON on `200`. It does not add auth here beyond what the platform already enforces — operator auth is FUNC-AC-OPERATOR-AUTH at the surface; this route follows whatever the sibling daemon routes do (`requireDashboardUser` is the established read-route guard) so it stays consistent with `app/api/daemon/status/route.ts`.

**Degraded is a data shape, not an HTTP error the client must interpret.** Rather than make the component branch on HTTP status codes, the route normalizes every non-success daemon condition to `{ items: [], unavailable: true }` (and the success path to `{ items }` / the daemon's array). The component then renders purely off `unavailable`, so "daemon down" and "index disabled" and "config missing" all surface as the same calm panel — the client "never treats `503` as data loss" (L2 error handling).

**The answer modal is the ONE client component in the otherwise-pure inbox; redaction holds inside it too.** The read inbox is pure presentational (props-only) so it renders on the server; the answer affordance needs interactivity (open dialog, fire POST, track pending), so `decision-answer.tsx` is `'use client'`. The seam keeps the *presentational* dialog pure (`DecisionAnswerDialog` takes `onAnswer`, no `fetch`) so the gate tests choices/pending/error without network, and isolates the network in `submitDecisionAnswer`. Critically, an option `label` is a redaction-typed `ListField` (the daemon `ListOption.label`), so the dialog renders it through the SAME `kind`-discrimination as the inbox question: a protected label is `[protected: <class>]`, never its value. The redaction boundary the read inbox upholds is upheld inside the dialog — the modal cannot become a reveal path.

**The answer proxy is a POST mutation route — auth + CSRF like the other daemon mutation proxies, NOT the read-route degrade.** Unlike `/decisions/pending` (a read route that degrades to `{ items: [], unavailable: true }` so the page never errors), the answer route is a mutation the operator initiated from a click: it returns real HTTP status codes (200/400/404/409/500/502/503) the client interprets to confirm or surface a calm message. It guards with `requireDashboardAdmin` (the privileged gate — answering is a mutation viewers must not perform; rejecting unauthenticated→401/unauthorized→403 before any daemon call) and relies on `daemonFetch`'s `X-Requested-By: dashboard` header for CSRF — never a hand-built URL. The daemon decision id is `encodeURIComponent`-ed into the path (`/decisions/<id>/answer`) because ids can carry `/` and `#` (e.g. `owner/repo#42`).

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

```typescript
// app/api/decisions/answer/route.ts — POST mutation proxy: auth-guard, encode id, pass status through.
await requireDashboardAdmin();                                  // mutation → privileged gate; 401/403 before any daemon call
const { decision_id, chosen_option } = await request.json();
const res = await daemonFetch(`/decisions/${encodeURIComponent(decision_id)}/answer`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },              // daemonFetch adds X-Requested-By (CSRF)
  body: JSON.stringify({ chosen_option }),
});
const json = await res.json().catch(() => NON_JSON);            // non-JSON → 502
return NextResponse.json(json, { status: res.status });         // 200/400/404/409 pass through
// catch (DaemonConfigError) → 500 ; (network/timeout) → 503
```

```tsx
// components/decisions/decision-answer.tsx — split so the gate tests the dialog
// without network: a PURE Dialog_(decision, onAnswer, pending, error)_ rendering
// options via <AnswerOptionLabel> (protected → [protected: class]); a fetch wrapper
// submitDecisionAnswer→POST /api/decisions/answer (typed AnswerResult, never throws);
// a thin client wrapper owning pending→answered(disabled confirm)/error state.
```

## Gotchas

- **Never render a protected `ListField.value` — there is no `value` on a protected field.** The protected arm is `{ kind: 'protected'; field; class }` with no `value`/`ref` by type; render only `[protected: <class>]` (and optionally the `field` name). Reaching for a value on the protected arm is a type error *and* the redaction-boundary violation this whole chain exists to prevent. The list never reveals; reveal is server-side on the deferred detail path only.
- **Keep `DecisionInbox` a pure component (no `fetch`/`await`/`'use client'` unless realtime is added).** The test renders it directly with a mock array; if it fetches, the unit test must mock the network and it stops being a pure render. The server page does the fetch. (A future realtime-refresh wrapper may be a client component that *passes* fetched items down — the presentational core stays pure.)
- **Empty state ≠ degraded state.** `items: []` with `unavailable` falsy is the calm success state ("No decisions awaiting you"); `unavailable: true` is the degraded panel. Do not collapse them — the L1 distinguishes "nothing waits on you" (success) from "the surface can't reach the data" (degraded), and the operator must be able to trust the empty state.
- **The proxy must degrade, not 500.** A daemon `503`/timeout/`DaemonConfigError`/non-JSON body must become `{ items: [], unavailable: true }` (HTTP `200` to the client is fine — the degraded flag carries the state). If the route rethrows or returns a 500, the home server component's `fetch` throws and the *whole dashboard page* errors — the opposite of the calm-pane contract.
- **Reuse `daemonFetch`, do not hand-build `process.env.DAEMON_URL + path`.** The helper centralizes the base-URL normalization, the `X-Requested-By` CSRF header, and the timeout. The decisions proxy route is the correct pattern — route handler + `daemonFetch` — and the steering server component reuses `daemonFetch` for the inbox, never a second raw-fetch inline.
- **Mobile-first means base styles stack; breakpoints only add.** Author the narrow-screen layout as the default (`flex-col`, full-width cards) and use `sm:`/`md:` prefixes to *enhance* (inline a row, add columns). Authoring desktop-first and hiding things on mobile risks reserving content for a desktop screen — explicitly forbidden by the L1 mobile contract.
- **`created_at` is an ISO string from the wire — format at the edge.** Render it as a stable, locale-light label (or a relative "Xh ago"); do not assume a `Date` object. Keep formatting deterministic enough for the test to assert (the test asserts the timestamp is present per row).
- **Percent-encode the decision id into the daemon answer path — ids carry `/` and `#`.** A decision id like `owner/repo#42` would corrupt the path (`/decisions/owner/repo#42/answer`) if interpolated raw — the `#` truncates at the fragment and the `/` injects extra segments. Use `encodeURIComponent(decision_id)` so the daemon receives `/decisions/owner%2Frepo%2342/answer`. The route test asserts the encoded path; do not skip it for "simple" ids.
- **The answer modal must render an option `label` through redaction discrimination — it has the same protected arm as `question`.** `ListOption.label` is a `ListField`; a protected label is `{ kind:'protected'; field; class }` with NO `value`/`ref`. Render `[protected: <class>]`, never a value — the dialog is not exempt from the redaction boundary just because it is interactive. The gate's leak-guard asserts `container.textContent` never contains a raw protected value inside the open dialog.
- **The answer proxy is a mutation — return real status codes, do NOT degrade-to-200 like the read route.** `/decisions/pending` swallows failures into `{ items: [], unavailable: true }` so the page renders; `/decisions/answer` must surface the daemon's `409`/`400`/etc. so the client can confirm success vs. show a calm "not answerable" message. Collapsing the answer route to a 200-degrade would tell the operator their answer landed when it did not (the run stays parked) — the opposite of the confirmed-UX contract.
- **`'use client'` only on the answer affordance, never on the inbox.** `decision-answer.tsx` is the one client island (it owns dialog state + the POST); `decision-inbox.tsx` stays a pure server-renderable component. Keep the *presentational* `DecisionAnswerDialog` free of `fetch`/`await` so its gate test needs no network mock — the `submitDecisionAnswer` wrapper and the `DecisionAnswer` wrapper own the network and state.
- **On a successful answer, let the row leave via the next `/decisions/pending` fetch — at minimum disable the control + confirm.** Do not hand-mutate a client list as the source of truth: the resume loop advances the decision past the answerable set, so it drops from the next pending fetch. The wrapper's `onAnswered(decision_id)` is the optimistic hint (remove/penalize the row now); the authoritative state is the daemon's next projection. Never leave the control live-and-clickable after a 200 (double-answer risk).

## Concerns This Spec Does Not Cover

- The **per-run / per-decision drill-down** (`GET /decisions/:id` detail, the `DetailView` with server-side protected reveal inside the trusted Control Plane) — a deferred follow-up increment; the reveal must never happen in this client.
- The **resume transport itself** (how the daemon turns the answer into a DecisionResponse the `resumeParkedRuns` loop consumes) — owned by STACK-AC-OPERATOR-SURFACE-API / ARCH-AC-DECISION-ESCALATION. This client only drives the answer HTTP (`POST /api/decisions/answer` → daemon `POST /decisions/:id/answer`); it never writes the ledger and never posts the GitHub DecisionResponse directly.
- A **free-form / multi-option answer** beyond `approve`/`reject` — the answer transport recognizes only those two (`AnswerChoice`); the modal offers exactly the decision's answerable options and an unsupported id is a daemon `400`.
- The **daily briefing** content and rhythm (batch vs break-through) — owned by FUNC-AC-DECISION-ESCALATION / FUNC-AC-FLEET and rendered by the existing `BriefingCard`; this spec only places the inbox *alongside* the briefing on the operator-surface (steering) route.
- **Inbox ranking and focus semantics** (the order, `score`, `why_ranked`, cross-deployment focus) — owned by FUNC-AC-FLEET and computed by the daemon read model; the client renders the order it receives and does not re-rank.
- **Operator authentication / session** (FUNC-AC-OPERATOR-AUTH) — enforced by the platform's existing route guards (`requireDashboardUser`); this spec consumes that guard, it does not define auth.
- **Playwright e2e** of the inbox on a real mobile viewport — a deferred follow-up; the component unit test covers redaction/empty/degraded/rows, and the e2e covers the rendered route + responsive behavior end-to-end.
- The **daemon Decision API** itself (`/decisions/pending` projection, redaction typing, `503` fail-safe) — STACK-AC-OPERATOR-SURFACE-API; this client consumes that contract.

## Traceability

- **Parent (L2):** ARCH-AC-OPERATOR-SURFACE — the Surface Client renders the minimal inbox + briefing against the Decision API; redaction is class-only on the list; `503` degrades calmly.
- **Sibling (L3):** STACK-AC-OPERATOR-SURFACE-API — the daemon Decision API this client's proxy route consumes (`GET /decisions/pending`).
- **Functional (L1):** FUNC-AC-OPERATOR-SURFACE — the operator surface (its own `steering` route) = decisions inbox + briefing ONLY; empty inbox is the success state; mobile is a non-negotiable requirement; outcome-first. The management content (StatsCards/RunTable) stays on the home `page.tsx` under FUNC-AC-DASHBOARD.
- **Related (L2):** ARCH-AC-DASHBOARD (the management surface the operator surface lives beside, on its own route), ARCH-AC-DECISION-ESCALATION (the inbox/decision semantics this surface fronts), ARCH-AC-OPERATOR-AUTH (the session enforced at the surface).
- **code_paths:** the pending proxy route, the answer proxy route, the inbox component, the answer affordance component, and the steering-route wiring (above).
- **test_paths:** the inbox component test (redaction/empty/degraded/rows), the answer component test (dialog opens / lists options / invokes handler / pending disables / error keeps row / redaction in dialog), the pending proxy-route test, and the answer proxy-route test (encoded path + body / daemon status passthrough / unreachable + config + non-JSON mapping / unauthenticated rejection) (above).
