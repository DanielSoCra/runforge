---
id: STACK-CONCIERGE-BOARD
type: stack-specific
domain: concierge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-CONCIERGE-RUNTIME
code_paths:
  - packages/concierge/src/board/
test_paths:
  - packages/concierge/src/board/**/*.test.ts
---

# STACK-CONCIERGE-BOARD — Board Frontend (HTMX + Hono)

## Pattern

Server-rendered HTML with HTMX + minimal hyperscript for interactivity. No React, no Next.js, no client-side build pipeline. Hono on the backend, partial-update endpoints for HTMX, SSE for live card updates.

## Why HTMX (rationale, locked)

- **Ship-speed.** No Webpack / esbuild / Next config / TypeScript-for-JSX overhead.
- **Single-user surface.** No need for offline-first, no need for client-side routing.
- **Tiny payload.** HTMX is ~14 KB gzipped. Total page <50 KB.
- **PWA via manifest.** No service-worker complexity beyond install-as-app.

If the surface ever grows (multi-user, complex interactions), revisit. Until then, HTMX wins.

## Layout

```
packages/concierge/src/board/
├── server.ts                  # Hono app entrypoint
├── routes/
│   ├── cards.ts               # GET /, GET /cards (partial), POST /cards/:id/:action
│   ├── stream.ts              # SSE endpoint
│   └── manifest.ts            # PWA manifest.webmanifest
├── ui/
│   ├── layout.tsx             # JSX templates rendered server-side via @kitajs/html
│   ├── card.tsx               # single-card partial
│   ├── needs-you.tsx          # needs-you section
│   ├── in-flight.tsx          # in-flight section
│   └── empty.tsx              # "All clear ✓" view
└── public/
    ├── htmx.min.js            # vendored
    ├── styles.css             # tailwind-inspired hand-rolled CSS, ~5 KB
    └── icons/                 # PWA icons
```

## Endpoints

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/` | Full board page | CF Access |
| GET | `/cards` | HTMX partial (used for refreshes) | CF Access |
| GET | `/stream` | SSE: card_created / card_updated / card_done | CF Access |
| POST | `/cards/:id/:action` | Tap an action (snooze, done, approve, deny, reply) | CF Access |
| GET | `/manifest.webmanifest` | PWA manifest | (public OK) |

## SSE event format

```
event: card_created
data: {"id": "...", "section": "needs_you", "html": "<div ...>...</div>"}

event: card_updated
data: {"id": "...", "section": "in_flight", "html": "<div ...>...</div>"}

event: card_removed
data: {"id": "..."}
```

The HTML is server-rendered. The client just swaps the matching DOM node by id.

## Mobile-first CSS

- Viewport: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- Container width: 100%, max 480 px on tablet+, padding 16 px.
- Card: 12 px padding, 8 px border-radius, 4 px left-border accent (color = blast radius).
- Tap targets: `min-height: 44 px`, `min-width: 44 px`.
- Two sections in a vertical stack (needs-you on top, in-flight below).

## Tests

- `routes/cards.test.ts` — auth header forwarded; action POST invokes the right tool via concierge-core HTTP
- `routes/stream.test.ts` — SSE messages emit on DB writes
- `ui/card.test.ts` — server-rendered HTML matches snapshot for each card type

## PWA

`manifest.webmanifest`:
- `name: "Concierge"`
- `short_name: "Concierge"`
- `display: "standalone"`
- `start_url: "/"`
- `theme_color: "#1a1a1a"`
- `icons` (192, 512 PNG sized)

No service worker in v1 — online-only is fine (the board is useless without the Mac mini reachable anyway).

## Boundaries

- This stack defines the FRONTEND-FACING SLICE. Database read patterns and SSE wiring inside the server live in `STACK-CONCIERGE-NODE` and `ARCH-CONCIERGE-RUNTIME`.
- No styling framework (Tailwind, Bootstrap). Hand-rolled CSS in one file.
- No client-side state management (no Redux, no signals). HTMX swaps server-rendered partials.
