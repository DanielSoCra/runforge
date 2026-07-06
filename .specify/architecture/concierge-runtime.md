---
id: ARCH-CONCIERGE-RUNTIME
type: architecture
domain: concierge
status: draft
version: 1
layer: 2
references: FUNC-CONCIERGE-CORE
---

# ARCH-CONCIERGE-RUNTIME — Concierge Runtime

## Overview

The concierge runtime is a single runtime process (`concierge-core`) on the local host that owns the LLM loop, tool router, conversation memory, and Slack adapter. Two sibling processes (`observer`, `board-server`) share the same local relational data file and run under their own supervisor definitions. This spec defines the runtime's process layout, schema, tool-router contract, and inter-process boundaries.

## Process layout

| Process | Owner |
|---|---|
| `concierge-core` | LLM loop, tool registry, tool router, slack-adapter (in-process), conversation memory, schema migrations |
| `observer` | filesystem & daemon polling, event emission to event-bus |
| `board-server` | reads `cards`/`messages`/`tool_calls`; serves board UI; SSE fan-out |
| `cloudflared` | tunnel for Slack webhook + board URL |
| (existing) `com.runforge.daemon` | unchanged, polled by observer |

## Storage

Single local relational data file at `~/Library/Application Support/concierge/state.db`, opened in concurrent-reader mode by all three processes.

### Tables and write boundaries

| Table | Writer | Readers |
|---|---|---|
| `conversations` | concierge-core | concierge-core, board-server |
| `messages` | concierge-core | concierge-core, board-server |
| `tool_calls` | concierge-core | concierge-core, board-server |
| `events` | observer | concierge-core (event-bus consumer), board-server |
| `cards` | concierge-core | concierge-core, board-server |
| `schema_migrations` | concierge-core | concierge-core |

`board-server` is read-only on every table except cards: it writes a card-action result by calling concierge-core's tool router via local HTTP (not by direct store update).

### Migrations

`concierge-core` is the sole owner of schema migrations. On boot it checks `schema_migrations` and applies any pending up-migrations (forward-only). The other processes refuse to start if their compiled-in schema hash does not match the latest applied migration.

## Tool router contract

The tool router is an in-process module inside `concierge-core`. It accepts a `tool_use` from the LLM, looks up the registered handler by name, validates args against the registered JSON schema, decides confirmation policy via `ARCH-CONFIRMATION-LIFECYCLE`, executes (or queues for confirmation), and returns a `tool_result` to the LLM.

### Registration

```typescript
interface ToolDefinition<Args, Result> {
  name: string;                          // e.g. "ac_run", "sb_read"
  description: string;                    // shown to the LLM
  argsSchema: JSONSchema;                 // strict; rejects unknown keys
  handler: (args: Args) => Promise<Result>;
  blastRadius: 'safe' | 'medium' | 'high';// drives confirmation policy
  audit: 'always' | 'on_error_only';      // drives audit log granularity
  cacheable: boolean;                     // hint for memoisation
}
```

`safe` → execute immediately. `medium` → execute, but audit and notify on the board. `high` → confirmation required (see `ARCH-CONFIRMATION-LIFECYCLE`).

### Failure semantics

Handler throws → router catches, returns `{ error: <message> }` to the LLM. No retry. The LLM decides whether to retry or report.

### Audit

Every tool call writes a `tool_calls` row with status (`allowed`, `confirmed`, `denied`, `errored`, `expired`), latency, and cost. Costs are computed by tools that wrap LLM calls or paid APIs; otherwise 0.

## LLM loop

### Single-threaded

One LLM session per conversation. No parallel writer agents per Cognition's guidance. Subagents for read-heavy noisy tools (gh log scans, web fetches, email triage) MAY be dispatched but their return value is constrained to a structured summary.

### Prompt structure (cache-aware)

```
[ stable system prompt + tool defs + user profile ]   ← cache_control: 1h
[ rolling 7-day summary ]                              ← cache_control: 5m
[ recent turns of current conversation ]               ← uncached
```

Critical rules:
- **No timestamps in the cached blocks.** Cache-busts on every turn otherwise.
- **No dynamic IDs in the cached blocks.** Same.
- **Tool defs are stable across turns** unless a new tool is added; reorder/rename = cache miss.
- **Logit-mask or prefill to disable a tool per state**, do not remove it from the schema.

### Recitation

Every N=10 turns, the LLM is reminded of its current `todo.md` (compact intent summary) injected near the tail of context.

### Recoverable compression

Tool returns >2 KB are replaced in context with a handle (URL / message-id / vault path) plus a one-line description. Full content is fetched on demand via tool call.

## Slack adapter

In-process. Uses Bolt-for-JS. Verifies signing secret on every event. Normalises events into `{conversation_id?, thread_ts, user, text, type}`. Outbound messages pass through `chat.postMessage`. Block Kit confirm messages encode the `tool_call_id` in `action_id`.

## Configuration

`~/Library/Application Support/concierge/config.json`:

```json
{
  "slackBotToken": "xoxb-...",
  "slackSigningSecret": "...",
  "operatorSlackUserId": "U...",
  "anthropicApiKey": "sk-...",
  "modelId": "claude-sonnet-4-6",
  "tunnelHostname": "concierge.<your-domain>",
  "boardHostname": "board.<your-domain>",
  "vaultPath": "~/code/knowledge-vault",
  "watchedRepos": ["~/code/runforge"],
  "operatorEmail": "operator@example.com"
}
```

## launchd

`com.concierge.core`, `com.concierge.observer`, `com.concierge.board` plists. All three: `RunAtLoad: true`, `KeepAlive: true`, `WorkingDirectory: ~/code/runforge`, env loaded from `~/Library/Application Support/concierge/env`.

## Cloudflare Tunnel

Two routes from a single tunnel:
- `concierge-events.<your-domain>` → `localhost:3848` (slack-adapter webhook)
- `board.<your-domain>` → `localhost:3849` (board-server)

Cloudflare Access policy: Google SSO restricted to `operator@example.com`, applied to both routes (the Slack webhook route uses Cloudflare Access service tokens; the board route uses interactive SSO).

## Failure modes

- **Storage contention** — handled by concurrent-reader mode + retry on busy timeout (50 ms backoff, 5 retries).
- **Tool handler throws** — router returns `{error}` to LLM; no retry loop.
- **LLM API outage** — concierge-core retries with exponential backoff (3 attempts); on full failure, posts a one-line "I'm offline, retry in 5 min" reply.
- **Slack API outage** — outbound queue in the local store drains on recovery.
- **Cloudflare Tunnel down** — Slack webhook fails (Slack auto-retries up to 3x, then drops); the operator sees missed messages on tunnel reconnect via Slack's own thread.

## Boundaries

- This spec defines runtime + schema + router contract. It does NOT define event classification rules (see `ARCH-EVENT-BUS`), confirmation flow details (see `ARCH-CONFIRMATION-LIFECYCLE`), or tool-registry persistence shape (see `ARCH-TOOL-REGISTRY`).
