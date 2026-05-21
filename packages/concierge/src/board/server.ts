import { Hono } from 'hono';
import type { BoardCardActionRequest, BoardCardActionResult } from '../core/board-actions.js';
import type { ConciergeCardRecord, ConciergeCardStore, ConciergeEventStore } from '../memory/state-stores.js';

export interface BoardCardActionClient {
  invoke(request: BoardCardActionRequest): Promise<BoardCardActionResult>;
}

export interface BoardStreamScheduler {
  setInterval(callback: () => void, delayMs?: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface BoardStreamOptions {
  pollIntervalMs?: number;
  scheduler?: BoardStreamScheduler;
}

export interface ConciergeBoardAppOptions {
  cards: ConciergeCardStore;
  events: ConciergeEventStore;
  actions: BoardCardActionClient;
  stream?: BoardStreamOptions;
}

export interface CoreCardActionClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

const DEFAULT_CORE_BASE_URL = 'http://127.0.0.1:3848';
const DEFAULT_STREAM_POLL_INTERVAL_MS = 250;

export function createConciergeBoardApp(options: ConciergeBoardAppOptions): Hono {
  const app = new Hono();

  app.get('/', (context) => {
    return context.html(renderPage(readBoard(options.cards)));
  });

  app.get('/cards', (context) => {
    return context.html(renderSections(readBoard(options.cards)));
  });

  app.get('/stream', () => {
    return createBoardSseResponse(options.cards, options.stream);
  });

  app.post('/cards/:id/:action', async (context) => {
    const id = context.req.param('id');
    const action = context.req.param('action');
    const result = await options.actions.invoke({ cardId: id, action });
    if (result.status === 'errored') return context.text(result.error, 422);
    return context.html(renderActionResult(result.card));
  });

  app.get('/manifest.webmanifest', (context) => {
    return context.json({
      name: 'Concierge',
      short_name: 'Concierge',
      display: 'standalone',
      start_url: '/',
      theme_color: '#1a1a1a',
      icons: [],
    });
  });

  return app;
}

export function createCoreCardActionClient(
  options: CoreCardActionClientOptions = {},
): BoardCardActionClient {
  const baseUrl = options.baseUrl ?? DEFAULT_CORE_BASE_URL;
  const fetchImpl = options.fetch ?? fetch;

  return {
    async invoke(request): Promise<BoardCardActionResult> {
      const url = new URL(
        `/board/cards/${encodeURIComponent(request.cardId)}/${encodeURIComponent(request.action)}`,
        baseUrl,
      );
      const response = await fetchImpl(url, { method: 'POST' });
      const body = await response.text();
      if (!response.ok) {
        return { status: 'errored', error: responseError(body, response.status) };
      }
      return JSON.parse(body) as BoardCardActionResult;
    },
  };
}

interface BoardModel {
  needsYou: ConciergeCardRecord[];
  inFlight: ConciergeCardRecord[];
}

type BoardSection = 'needs_you' | 'in_flight';

interface CardSnapshot {
  card: ConciergeCardRecord;
  fingerprint: string;
  section: BoardSection;
}

type BoardSseEvent =
  | { event: 'card_created' | 'card_updated'; data: { id: string; section: BoardSection; html: string } }
  | { event: 'card_removed'; data: { id: string } };

function readBoard(cards: ConciergeCardStore): BoardModel {
  const visible = cards.list().filter((card) => !['dismissed', 'done', 'snoozed'].includes(card.status));
  return {
    needsYou: visible.filter((card) => ['needs_decision', 'needs_you', 'pending'].includes(card.status)),
    inFlight: visible.filter((card) => ['in_flight', 'running', 'active'].includes(card.status)),
  };
}

function createBoardSseResponse(
  cards: ConciergeCardStore,
  options: BoardStreamOptions = {},
): Response {
  const encoder = new TextEncoder();
  const scheduler = options.scheduler ?? defaultStreamScheduler;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_STREAM_POLL_INTERVAL_MS;
  let previous = readCardSnapshots(cards);
  let interval: unknown;

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(encoder.encode(': connected\n\n'));
      interval = scheduler.setInterval(() => {
        const current = readCardSnapshots(cards);
        for (const event of diffCardSnapshots(previous, current)) {
          controller.enqueue(encoder.encode(formatSse(event)));
        }
        previous = current;
      }, pollIntervalMs);
    },

    cancel(): void {
      if (interval !== undefined) scheduler.clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    },
  });
}

function readCardSnapshots(cards: ConciergeCardStore): Map<string, CardSnapshot> {
  const snapshots = new Map<string, CardSnapshot>();
  for (const card of cards.list()) {
    const section = sectionForCard(card);
    if (!section) continue;
    snapshots.set(card.id, {
      card,
      fingerprint: `${card.status}:${card.title}:${card.body}:${card.updatedAt}`,
      section,
    });
  }
  return snapshots;
}

function diffCardSnapshots(
  previous: Map<string, CardSnapshot>,
  current: Map<string, CardSnapshot>,
): BoardSseEvent[] {
  const events: BoardSseEvent[] = [];
  for (const [id, snapshot] of current) {
    const before = previous.get(id);
    if (!before) {
      events.push(cardChangedEvent('card_created', snapshot));
    } else if (before.fingerprint !== snapshot.fingerprint || before.section !== snapshot.section) {
      events.push(cardChangedEvent('card_updated', snapshot));
    }
  }
  for (const id of previous.keys()) {
    if (!current.has(id)) events.push({ event: 'card_removed', data: { id } });
  }
  return events;
}

function cardChangedEvent(
  event: 'card_created' | 'card_updated',
  snapshot: CardSnapshot,
): BoardSseEvent {
  return {
    event,
    data: {
      id: snapshot.card.id,
      section: snapshot.section,
      html: renderCard(snapshot.card),
    },
  };
}

function sectionForCard(card: ConciergeCardRecord): BoardSection | undefined {
  if (['needs_decision', 'needs_you', 'pending'].includes(card.status)) return 'needs_you';
  if (['in_flight', 'running', 'active'].includes(card.status)) return 'in_flight';
  return undefined;
}

function formatSse(event: BoardSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function renderPage(model: BoardModel): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <link rel="manifest" href="/manifest.webmanifest">
  <title>Concierge</title>
  <script src="https://unpkg.com/htmx.org@2.0.7" defer></script>
  <style>${BOARD_CSS}</style>
</head>
<body>
  <main class="board" hx-get="/cards" hx-trigger="load, every 30s" hx-swap="innerHTML">
    ${renderSections(model)}
  </main>
</body>
</html>`;
}

function renderSections(model: BoardModel): string {
  return `${renderSection('Needs You', model.needsYou, 'All clear')}
${renderSection('In Flight', model.inFlight, 'Nothing in flight')}`;
}

function renderSection(title: string, cards: ConciergeCardRecord[], emptyText: string): string {
  const body = cards.length === 0
    ? `<p class="empty">${escapeHtml(emptyText)}</p>`
    : cards.map(renderCard).join('\n');
  return `<section class="section" aria-label="${escapeHtml(title)}">
  <div class="section-header">
    <h1>${escapeHtml(title)}</h1>
    <span class="count">${cards.length}</span>
  </div>
  ${body}
</section>`;
}

function renderCard(card: ConciergeCardRecord): string {
  return `<article id="card-${escapeHtml(card.id)}" class="card" data-status="${escapeHtml(card.status)}">
  <div>
    <h2>${escapeHtml(card.title)}</h2>
    <p>${escapeHtml(card.body)}</p>
  </div>
  <form method="post" action="/cards/${encodeURIComponent(card.id)}/done" hx-post="/cards/${encodeURIComponent(card.id)}/done" hx-target="#card-${escapeHtml(card.id)}" hx-swap="outerHTML">
    <button type="submit">Done</button>
  </form>
</article>`;
}

function renderActionResult(card: ConciergeCardRecord): string {
  return `<div id="card-${escapeHtml(card.id)}" data-status="${escapeHtml(card.status)}">${escapeHtml(card.status)}</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function responseError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Fall through to the raw body.
  }
  return body || `core card action failed with HTTP ${status}`;
}

const defaultStreamScheduler: BoardStreamScheduler = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const BOARD_CSS = `
:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f7f7f4;
  color: #1a1a1a;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
}
.board {
  width: min(100%, 480px);
  margin: 0 auto;
  padding: 16px;
}
.section {
  margin: 0 0 24px;
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 10px;
}
h1 {
  font-size: 20px;
  line-height: 1.2;
  margin: 0;
}
h2 {
  font-size: 15px;
  line-height: 1.3;
  margin: 0 0 6px;
}
p {
  margin: 0;
  line-height: 1.45;
}
.count {
  min-width: 28px;
  border: 1px solid #c9c7bf;
  border-radius: 999px;
  padding: 2px 8px;
  text-align: center;
  font-size: 13px;
}
.empty {
  border: 1px dashed #c9c7bf;
  border-radius: 8px;
  padding: 14px;
}
.card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  align-items: start;
  border: 1px solid #d6d3c9;
  border-left: 4px solid #2f6f73;
  border-radius: 8px;
  background: #ffffff;
  padding: 12px;
  margin: 0 0 10px;
}
button {
  min-height: 44px;
  min-width: 44px;
  border: 1px solid #1f4d50;
  border-radius: 8px;
  background: #1f4d50;
  color: #ffffff;
  padding: 0 12px;
  font: inherit;
}
@media (prefers-color-scheme: dark) {
  :root {
    background: #161716;
    color: #f2f1ea;
  }
  .card {
    background: #202220;
    border-color: #3a3c38;
    border-left-color: #63a0a3;
  }
  .count,
  .empty {
    border-color: #4b4e48;
  }
}
`;
