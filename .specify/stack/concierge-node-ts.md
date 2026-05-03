---
id: STACK-CONCIERGE-NODE
type: stack-specific
domain: concierge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-CONCIERGE-RUNTIME
code_paths:
  - packages/concierge/
test_paths:
  - packages/concierge/**/*.test.ts
---

# STACK-CONCIERGE-NODE — Concierge (Node + TypeScript)

## Pattern

**Single Node 22 process** for the concierge core, second sibling Node process for the observer. TS source compiled via `tsx` for dev, built with `tsc` for production. pnpm workspace under `packages/concierge/` with subpackages by responsibility (no separate published packages — internal monorepo only).

## Layout

```
packages/concierge/
├── src/
│   ├── core/                  # LLM loop, tool router
│   │   ├── llm.ts
│   │   ├── router.ts
│   │   └── recitation.ts      # Manus-pattern todo.md re-injection every N turns
│   ├── slack/                 # Bolt adapter
│   │   ├── adapter.ts
│   │   ├── confirm.ts         # Block Kit confirm rendering
│   │   └── slash-commands.ts
│   ├── memory/                # SQLite + vault MCP
│   │   ├── sqlite.ts          # better-sqlite3 wrapper
│   │   ├── vault.ts           # @modelcontextprotocol/sdk client for Obsidian
│   │   ├── consolidator.ts    # nightly job
│   │   └── compression.ts     # recoverable compression rules
│   ├── tools/
│   │   ├── registry.ts        # the canonical tool list
│   │   ├── ac.ts              # auto-claude HTTP client
│   │   ├── sb.ts              # knowledge-vault MCP wrapper
│   │   ├── gh.ts              # gh CLI / Octokit
│   │   ├── slack.ts           # cross-channel send
│   │   ├── cal.ts             # calendar
│   │   ├── mail.ts            # email
│   │   ├── web.ts             # fetch + readability
│   │   └── obs.ts             # observer client
│   ├── confirmation/
│   │   ├── state-machine.ts
│   │   └── expiry.ts          # periodic job
│   ├── observer/              # separate process, but shared package
│   │   ├── main.ts
│   │   ├── chokidar.ts
│   │   └── daemon-poll.ts
│   ├── board/                 # Hono app, sibling process
│   │   ├── server.ts
│   │   ├── sse.ts
│   │   └── ui/                # HTMX templates
│   └── prompt/                # OpenClaw-pattern prompt separation
│       ├── soul.md            # operator preferences (read from vault on boot)
│       ├── agents.md          # rules / contracts
│       └── tools.md           # tool descriptions (rendered from registry)
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## Key dependencies

- `@anthropic-ai/sdk` — LLM API (Claude Sonnet 4.6 default; configurable)
- `@slack/bolt` — Slack adapter
- `better-sqlite3` — SQLite (synchronous; fast for local single-user)
- `@modelcontextprotocol/sdk` — Obsidian MCP client
- `chokidar` — filesystem watcher (observer)
- `hono` + `@hono/node-server` — board-server
- `htmx.org` — frontend (CDN, no build)
- `vitest` — test runner

## Cache control

Anthropic prompt cache:
- System prompt + tool defs + user profile read from `prompt/soul.md`+`prompt/agents.md`+`prompt/tools.md` (rendered from registry) → assembled into one block with `cache_control: { type: "ephemeral", ttl: "1h" }`.
- Rolling 7-day summary (composed by consolidator nightly, refreshed on-demand only if older than 24h) → `cache_control: { type: "ephemeral", ttl: "5m" }`.
- Recent turns of current conversation → uncached.
- **No timestamps, no dynamic IDs, no run_ids in any cached block.** Verified by a unit test that takes the cached block bytes from two consecutive turns and asserts byte-equality.

## Process lifecycle

`concierge-core` (`packages/concierge/src/core/main.ts`):
1. Load config from `~/Library/Application Support/concierge/config.json` (env override allowed).
2. Open SQLite (WAL mode); apply pending migrations (`schema_migrations` table).
3. Initialise tool registry from `tools/registry.ts`.
4. Instantiate Slack Bolt receiver bound to `localhost:3848`.
5. Start confirmation expiry job (60 s interval).
6. Start consolidator job (launchd-driven, but also fallback `setInterval` for "if launchd missed it" recovery).
7. Run forever.

`observer` (`packages/concierge/src/observer/main.ts`):
1. Load config (subset of concierge-core's: watched repos, daemon endpoint, polling interval).
2. Open SQLite (WAL mode, read-only on most tables, write to `events` only).
3. Start chokidar watchers + daemon poll loop.
4. Run forever.

`board-server` (`packages/concierge/src/board/server.ts`):
1. Load config.
2. Open SQLite (WAL mode, read-only on most tables, write only to `cards.status` via concierge-core HTTP).
3. Start Hono server on `localhost:3849`.
4. Run forever.

## Subagent dispatch (read-only noisy tools)

For `gh_log_scan`, `mail_triage`, `web_fetch_long`: the tool handler dispatches an Anthropic subagent (separate API call) with a constrained system prompt ("read-only summary; return JSON {key_findings, urls, follow_ups}"). The handler returns ONLY the structured summary to the parent LLM loop. Token cost is logged separately.

## launchd

`scripts/com.concierge.core.plist`, `.observer.plist`, `.board.plist`. All three:
- `RunAtLoad: true`
- `KeepAlive: true`
- `WorkingDirectory: ~/code/auto-claude`
- `StandardOutPath` and `StandardErrorPath` to `~/Library/Logs/concierge/<process>.log` with rotation
- `EnvironmentVariables` loads from a single `~/Library/Application Support/concierge/env` file (so secrets stay out of plists)
- `ProcessType: Background`
- (consolidator) `StartCalendarInterval: { Hour: 3, Minute: 0 }` only on `com.concierge.consolidator` (a separate occasional plist; OR use `setInterval` inside concierge-core — pick one and stay consistent; default: launchd plist for clean separation)

## Cloudflare Tunnel

`cloudflared` is configured (`~/.cloudflared/config.yml`) with two routes:
- `concierge-events.<your-domain>` → `http://localhost:3848`
- `board.<your-domain>` → `http://localhost:3849`

Cloudflare Access policies attached:
- Slack route: service-token policy (Slack signs via signing-secret; CF Access only verifies the request is from cloudflared, no SSO)
- Board route: Google SSO restricted to `operator@example.com`

## Tests

- `core/llm.test.ts` — assert cached prompt block byte-stability across turns
- `core/router.test.ts` — schema validation, blast-radius routing
- `slack/adapter.test.ts` — signature verification, event normalisation
- `confirmation/state-machine.test.ts` — full lifecycle (pending → approved/denied/expired)
- `memory/sqlite.test.ts` — schema migration forward-only invariant
- `memory/vault.test.ts` — allow-list enforcement; client-folder always-confirms
- `observer/chokidar.test.ts` — ignore-list (`.env`, `secrets/`) drops events
- `tools/registry.test.ts` — name-uniqueness, namespace-prefix conventions

Vitest coverage target: ≥80 % statements, ≥70 % branches.

## Conventions

- Filenames: kebab-case `.ts`. One responsibility per file.
- Result-monad for tool handlers: `Result<T, ToolError>` (matches existing `packages/daemon/src/lib/result.ts` pattern; reuse via workspace import).
- No top-level singletons; everything is a class or factory function called from `main.ts` (testability).
- No commented-out code in main; failed experiments live on feature branches and get deleted on merge.

## Boundaries

- Frontend (HTMX templates) lives under `packages/concierge/src/board/ui/` — NOT a separate package. Defined in `STACK-CONCIERGE-BOARD`.
- Daemon coexistence: this stack does NOT modify `packages/daemon/`. The observer reads daemon HTTP; concierge-core calls daemon HTTP via the `ac_*` tools. No cross-package code is shared except the workspace `lib/result.ts` and `lib/git.ts` if needed.
