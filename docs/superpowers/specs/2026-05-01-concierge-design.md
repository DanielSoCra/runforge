# Concierge — the Operator's Autonomous-Life-OS Design

**Date:** 2026-05-01
**Status:** Brainstorm complete; awaiting review before implementation plan.
**Brainstormed by:** the Operator + Claude Opus 4.7 + Codex GPT-5.5 (pair-review of spec restructure).
**Successor to:** the current `auto-claude` L0 vision. `auto-claude` becomes one subsystem under a broader L0.

---

## 1. L0 Vision

### 1.1 Pitch

A single conversational entry point — a Slack DM with a bot — that turns the Operator's intent into action across his tools. The concierge is an LLM agent with a fixed toolbox (auto-claude pipeline, knowledge-vault MCP, GitHub CLI, calendar, email, Slack-send, file-system observer). It acts directly when it can. When it can't — ambiguous, high-blast-radius, or genuinely needing human judgment — it surfaces a single card on a mobile-friendly board served from the Mac mini behind a Cloudflare Tunnel.

Heavy compute (auto-claude runs, knowledge-vault edits, manual coding sessions) lives on the Mac mini. The Slack bot and the web board are thin surfaces over the same process.

### 1.2 Operator role (replaces the current L0 operator clause)

1. Author L1 specs when adding new subsystems.
2. Approve production releases of any subsystem.
3. Decide on board cards the concierge surfaces.

Everything else is autonomous.

### 1.3 Boundaries — what this is NOT

- Not a calendar / email / Obsidian replacement — it *uses* them, doesn't replace them.
- Not a session orchestrator. Manual Claude Code / Codex / pi.dev sessions are *observed* (commits, branches, worktrees) but never managed.
- Not multi-user. Single-tenant, the Operator only. No team mode in v1.
- Not a notification firehose. Only events the concierge has *classified as relevant* reach the board or Slack DM.

### 1.4 Success criterion (one, falsifiable)

> On a typical Tuesday, the Operator sends ≤3 chat messages, glances at the board ≤2 times, and the system handles ≥80 % of routine coordination work (issue triage, draft replies, calendar prep, knowledge-vault captures, auto-claude babysitting) without further input.

### 1.5 Subsystem position of `auto-claude`

The existing `packages/daemon` (the GitHub-issue → PR pipeline) becomes the **`auto-claude` subsystem** — one tool the concierge calls. Its current `FUNC-AC-*` specs stay verbatim, governed by `L0-AC-VISION` (which itself is now a subsystem-scope L0, conceptually under the new product L0 but expressed in prose, not via a `parent:` field — see §5).

---

## 2. Architecture

### 2.1 Topology

```
                                    ┌───────── Phone / Laptop ─────────┐
                                    │  Slack iOS/Mac    Browser (PWA)  │
                                    └─────────┬───────────────┬────────┘
                                              │               │
                                              ▼               ▼
                                    ┌──── Slack API ────┐  ┌── Cloudflare Tunnel ──┐
                                    │  Events / Bot DM  │  │  board.<your-domain>  │
                                    └─────────┬─────────┘  └────────────┬──────────┘
                                              │ (webhook)               │
                                              ▼                         ▼
═══════════════════════════════════ Mac mini ═════════════════════════════════════
                          ┌──────────────────────────────────────────────────┐
                          │             concierge-core  (Node)               │
                          │  ┌────────────┐  ┌─────────────┐  ┌───────────┐  │
                          │  │  LLM loop  │◄─┤ tool router │──┤  memory   │  │
                          │  │ (Claude API│  │             │  │ (sqlite)  │  │
                          │  │   /Sonnet) │  └──────┬──────┘  └───────────┘  │
                          │  └────────────┘         │                        │
                          └─────────────────────────┼────────────────────────┘
                                                    │  (tool calls)
        ┌────────────────────┬─────────────┬────────┼────────┬──────────────┬──────────────┐
        ▼                    ▼             ▼        ▼        ▼              ▼              ▼
┌─────────────────┐ ┌──────────────┐ ┌────────┐ ┌──────────┐ ┌─────────────┐ ┌─────────┐
│   auto-claude   │ │ knowledge-vault │ │   gh   │ │ calendar │ │   email     │ │   web   │
│  (HTTP→3847)    │ │  (Obsidian   │ │ (CLI/  │ │  (Google │ │   (Gmail    │ │ (fetch) │
│  pause/run/...  │ │     MCP)     │ │Octokit)│ │   MCP)   │ │     MCP)    │ │         │
└────────┬────────┘ └──────┬───────┘ └────────┘ └──────────┘ └─────────────┘ └─────────┘
         │ runs on...      │
         ▼                 ▼
┌─────────────────┐ ┌──────────────┐
│ daemon (exists) │ │ ~/code/      │
│  workspaces/    │ │ knowledge-vault │
└─────────────────┘ └──────────────┘

                          ┌──────────────────────────────────────────────────┐
                          │              observer  (Node, separate)          │
                          │   chokidar on workspaces/*  +  git polling       │
                          │   emits events: new commit, new worktree,        │
                          │   PR created, daemon-status-change.              │
                          │   WRITE-ONLY: never warns, never mutates,        │
                          │   never triggers actions.                        │
                          └──────────────────────┬───────────────────────────┘
                                                 │
                                                 ▼
                          ┌──────────────────────────────────────────────────┐
                          │      event-bus  (sqlite + Server-Sent-Events)    │
                          │  classifier:  surface_card | slack_dm | silent   │
                          └──────────────────────┬───────────────────────────┘
                                                 │
                                                 ▼
                          ┌──────────────────────────────────────────────────┐
                          │             board-server  (Hono)                 │
                          │   GET  /cards          (mobile UI fetches)       │
                          │   POST /cards/:id/...  (snooze/done/reply)       │
                          │   SSE  /stream         (live updates)            │
                          └──────────────────────────────────────────────────┘
                                                 │
                                                 ▼ (served via tunnel)
                                         browser PWA
```

### 2.2 Components

| Component | Responsibility |
|---|---|
| `concierge-core` | Single Node process. LLM loop (Claude API). Tool registry. SQLite memory. Embeds the Slack adapter (Bolt-for-JS or raw webhook handler) — no separate process. |
| `slack-adapter` | In-process. Verifies Slack signatures, normalises events to internal shape. |
| `board-server` | Tiny Hono app. Reads/writes the same SQLite as concierge. Serves an HTMX PWA. Auth = Cloudflare Access with Google SSO restricted to the Operator's email. |
| `observer` | Separate small Node process. Watches `workspaces/*` and configurable allow-listed `~/code/*` repos. Polls daemon HTTP for status. Emits typed events. **Read-only.** |
| `event-bus` | SQLite table + classifier (deterministic rules first; LLM-classifier later). Each event resolves to `surface_card`, `slack_dm`, or `silent_log`. |
| `subsystem clients` | One TS module per subsystem in `packages/concierge/src/tools/`. Each exports a Claude-tool-shaped function. |
| `storage` | Single SQLite file (`~/Library/Application Support/concierge/state.db`). Tables: `conversations`, `messages`, `events`, `cards`, `tool_calls`. Backed up nightly. Schema ownership rules in `ARCH-CONCIERGE-RUNTIME` (§5). |

### 2.3 Process model on launchd

| Plist | Purpose | New / existing |
|---|---|---|
| `com.autoclaude.daemon` | Existing auto-claude pipeline daemon | unchanged |
| `com.concierge.core` | LLM loop + Slack adapter + tool router | NEW |
| `com.concierge.observer` | Filesystem + git watcher | NEW |
| `com.concierge.board` | Hono board server | NEW |
| `cloudflared` | Tunnel for Slack webhook + board URL | new or existing |

### 2.4 Storage

Single SQLite file, accessed by all four processes. Schema migration owned by `concierge-core`. Other processes read/write specific tables only — boundaries documented in `ARCH-CONCIERGE-RUNTIME`. Auth on board = Cloudflare Access (Google SSO restricted to `operator@example.com`); zero auth code in app.

---

## 3. Data Flows

Four canonical paths.

### 3.1 Inbound chat — the Operator DMs the bot

Slack webhook → `slack-adapter` verifies + normalises → `concierge-core` loads conversation history (current Slack thread + 7-day compressed summary from SQLite + relevant knowledge-vault notes if memory tool is queried) → LLM turn with tools → tool calls dispatched → tool results fed back → LLM continues → reply text → `slack-adapter` posts to Slack thread → turn persisted to SQLite.

### 3.2 Reactive event — auto-claude gets stuck

`observer` polls daemon HTTP every 30 s → diff vs prior status → inserts event `daemon_stuck` into event-bus → classifier rule: stuck → `surface_card` + `slack_dm` → board card row inserted, Block Kit DM sent via `slack-adapter`. SSE stream pushes the new card to any open board client.

### 3.3 Manual session — the Operator opens Claude Code himself

the Operator runs `git worktree add feature/x` → chokidar fires → observer inserts event `manual_branch_created` → classifier: `silent_log` (passive). the Operator commits → another silent log entry. Later, the Operator asks the bot "what am I in the middle of?" → concierge calls `observer.recent_activity()` tool → reports back. **Observer never warns the Operator about his own work.**

### 3.4 Board action — the Operator taps "Approve" on a card

Browser → `board-server` POST `/cards/:id` action=approve → board-server loads card spec (action mapping) → invokes the configured tool (e.g. `gh.add_label "l1-approved"`) via concierge's tool router → audit log entry → card marked `done` → SSE pushes `card_done` to other open clients.

### 3.5 Memory model

Two tiers, governed by `FUNC-CONCIERGE-MEMORY`:

- **Cortex (durable, institutional) — knowledge-vault.** All writes go through `mcp__obsidian__*` per `~/code/knowledge-vault/00-Meta/agent-access.md` (preserves frontmatter integrity). Concierge writes to:
  - `50-Daily/YYYY-MM-DD.md` — nightly consolidated summary.
  - `00-inbox/` — captures from "remember this" requests.
  - Project notes — decisions worth keeping (only with confirmation if writing under `20-Areas/clients/`).
- **Hippocampus (ephemeral, operational) — SQLite.** Slack-thread cache (Slack is source of truth; SQLite avoids round-trip on every turn), tool-call audit log, event-bus log, board cards, rolling 7-day compressed summaries. Raw log purged after 30 days.

A nightly **consolidation job** (launchd `StartCalendarInterval`) scans yesterday's threads + audit log, produces a structured daily summary, writes it to knowledge-vault via MCP. Vault write contract (paths whitelist, frontmatter shape, allowed tags) enforced by the spec.

### 3.6 Confirmation lifecycle

`ARCH-CONFIRMATION-LIFECYCLE` is a first-class concept (not a tool-registry flag). Tool calls marked `requires_confirmation: true` are intercepted by the tool router; instead of executing, a Block Kit confirm message is posted to Slack with ✅/❌ buttons. Confirmed → execute. Denied → tool returns "denied by operator" to the LLM. Expired (24 h) → tool returns "confirmation timed out". Every confirmation event goes to the audit log.

Default-confirm list:
- `email.send` to anyone external.
- `slack.send` to channels other than the Operator's DM.
- `auto_claude.merge_to_main`.
- `second_brain.write` under `20-Areas/clients/`.

Anything else: autonomous, audited.

### 3.7 Failure modes

- **Subsystem down** (Mac mini Wi-Fi flaky, daemon crashed): tool throws → LLM sees tool error → reports honestly in Slack. Concierge stays alive. **No retry loops by default.**
- **LLM hallucinates a tool name:** tool router rejects unknown names, surfaces error to the LLM.
- **Slack outage:** events queue in event-bus; on reconnect, concierge processes backlog (collapsed if many).
- **Cloudflare tunnel down:** board unreachable from phone, but Slack still works via separate tunnel route. If both die: offline. Accepted.
- **SQLite contention:** all four processes use WAL mode; writes through documented owner-process per table.

---

## 4. Memory model details

See `FUNC-CONCIERGE-MEMORY` for the governing contract. Key rules:

| Rule | Why |
|---|---|
| All vault writes via `mcp__obsidian__*`, never raw file writes. | Preserves frontmatter integrity per vault contract. |
| Concierge may only write to `50-Daily/`, `00-inbox/`, and explicitly-allowed project notes. | Prevents pollution of curated areas (`20-Areas/clients/`, `30-Resources/`). |
| Writes under `20-Areas/clients/` always require Slack confirmation. | Client data is sensitive; agent shouldn't write there autonomously. |
| Concierge reads any vault path on demand. | Reads are safe; vault is local. |
| SQLite raw log retention = 30 days. | Bounded growth; durable knowledge already in knowledge-vault. |
| Nightly consolidation runs at 03:00 local. | Off-hours; doesn't compete with daytime usage. |
| Compressed 7-day summary kept in SQLite as system-note for fast context. | Avoids hitting Obsidian MCP every turn for "what happened recently". |

---

## 5. Spec Restructure (post-Codex pair review)

### 5.1 Resolved findings

| Codex finding | Resolution |
|---|---|
| v1 dropped 11+ existing FUNC-AC-* specs from tree | All 14 existing FUNC-AC-* stay under `L0-AC-VISION` subtree, untouched. Concierge tree is **additive only.** |
| L0-to-L0 `parent:` field violates resolver contract | No L0-to-L0 parent. Relationship expressed in prose inside `L0-CONCIERGE-VISION`. |
| L1s contained architecture/API detail | "Slack Events API / Block Kit / SSE / LLM loop / tool registry" wording belongs in L2/L3. L1s describe **observable behavior only**. |
| Moving L0 into `vision/` breaks scaffolding | L0 path stays. `L0-vision.md` is rewritten as `L0-CONCIERGE-VISION` (id changes; path doesn't). New file `.specify/L0-ac-vision.md` holds extracted AC content. `spec-loader.ts` learns to scan multi-L0 (~30 LOC). |
| `FUNC-BOARD` overlapped `FUNC-AC-DASHBOARD` | New spec is `FUNC-CONCIERGE-BOARD`; existing `FUNC-AC-DASHBOARD` stays in its lane (auto-claude operator dashboard). Boundary documented in both specs' "Related" section. |
| Deferred subsystem L1s leave tool surface ungoverned | `ARCH-TOOL-REGISTRY` carries minimal entries (name, blast-radius, audit, failure semantics) for every tool, even those without a full subsystem L1. |
| Filename convention | Lowercase descriptive: `concierge.md`, `concierge-board.md`, `channel-slack.md`, `observer.md`, `concierge-memory.md`. IDs uppercase in frontmatter. |
| Launchd / cloudflared deserves L3 | Folded into `STACK-CONCIERGE-NODE`. Split out to `STACK-CONCIERGE-LAUNCHD` if it grows. |
| Memory needs governing contract | `FUNC-CONCIERGE-MEMORY` is its own L1. |
| Confirmation is cross-cutting | `ARCH-CONFIRMATION-LIFECYCLE` is its own L2. |
| Observer "write-only" too vague | `FUNC-OBSERVER` says explicitly: emits events; does not warn, mutate, or trigger actions. |
| SQLite shared across processes | `ARCH-CONCIERGE-RUNTIME` defines schema ownership: who writes which table, who runs migrations. |
| Manual-session observation needs scope rules | `FUNC-OBSERVER` defines watched paths/repos and an explicit ignore-list (`.env`, `secrets/`, dotfiles). |

### 5.2 Spec tree (additive only)

```
.specify/
├── L0-vision.md                              ← REWRITTEN. id: L0-CONCIERGE-VISION.
│                                                Includes inline "Subsystem: auto-claude
│                                                (governed by L0-AC-VISION)" section.
├── L0-ac-vision.md                           ← NEW. id: L0-AC-VISION.
│                                                Holds current L0 content verbatim
│                                                (extracted from old L0-vision.md).
├── functional/
│   ├── (existing 14 FUNC-AC-* — unchanged)
│   ├── concierge.md                          ← NEW. id: FUNC-CONCIERGE.
│   ├── concierge-memory.md                   ← NEW. id: FUNC-CONCIERGE-MEMORY.
│   ├── concierge-board.md                    ← NEW. id: FUNC-CONCIERGE-BOARD.
│   ├── channel-slack.md                      ← NEW. id: FUNC-CHANNEL-SLACK.
│   └── observer.md                           ← NEW. id: FUNC-OBSERVER.
├── architecture/
│   ├── (existing ARCH-AC-* — unchanged)
│   ├── concierge-runtime.md                  ← NEW. id: ARCH-CONCIERGE-RUNTIME.
│   ├── event-bus.md                          ← NEW. id: ARCH-EVENT-BUS.
│   ├── tool-registry.md                      ← NEW. id: ARCH-TOOL-REGISTRY.
│   └── confirmation-lifecycle.md             ← NEW. id: ARCH-CONFIRMATION-LIFECYCLE.
├── stack/
│   ├── (existing STACK-AC-* — unchanged)
│   ├── concierge-node-ts.md                  ← NEW. id: STACK-CONCIERGE-NODE.
│   └── concierge-board-ts.md                 ← NEW. id: STACK-CONCIERGE-BOARD.
└── traceability.yml                          ← UPDATED (additive only)
```

### 5.3 traceability.yml additions

```yaml
specs:
  L0-CONCIERGE-VISION:
    children: [FUNC-CONCIERGE, FUNC-CONCIERGE-MEMORY, FUNC-CONCIERGE-BOARD,
               FUNC-CHANNEL-SLACK, FUNC-OBSERVER]
    related: [L0-AC-VISION]   # prose only; not a parent field

  L0-AC-VISION:
    children: [(unchanged list of 14 FUNC-AC-*)]

  FUNC-CONCIERGE:
    children: [ARCH-CONCIERGE-RUNTIME, ARCH-TOOL-REGISTRY, ARCH-CONFIRMATION-LIFECYCLE]

  FUNC-CONCIERGE-MEMORY:
    children: [ARCH-CONCIERGE-RUNTIME]

  FUNC-CONCIERGE-BOARD:
    children: [ARCH-CONCIERGE-RUNTIME, ARCH-EVENT-BUS, STACK-CONCIERGE-BOARD]
    related: [FUNC-AC-DASHBOARD]   # boundary — see prose in spec

  FUNC-CHANNEL-SLACK:
    children: [STACK-CONCIERGE-NODE]

  FUNC-OBSERVER:
    children: [ARCH-EVENT-BUS]

  ARCH-CONCIERGE-RUNTIME:
    children: [STACK-CONCIERGE-NODE]

  ARCH-EVENT-BUS:
    children: [STACK-CONCIERGE-NODE]

  ARCH-TOOL-REGISTRY:
    children: [STACK-CONCIERGE-NODE]

  ARCH-CONFIRMATION-LIFECYCLE:
    children: [STACK-CONCIERGE-NODE]
```

### 5.4 Spec authorship plan

Per L0 operator role, **L1 specs are the Operator's responsibility.** Workflow:

| Spec | Author | Method |
|---|---|---|
| `L0-CONCIERGE-VISION` (rewritten `L0-vision.md`) | the Operator | drafted from this design doc, stamped |
| `L0-AC-VISION` (new file, extracted) | mechanical | extract current `L0-vision.md` → `L0-ac-vision.md`, change id |
| `FUNC-CONCIERGE` | the Operator | drafted via `l1-spec-guardian`, stamped |
| `FUNC-CONCIERGE-MEMORY` | the Operator | drafted via `l1-spec-guardian`, stamped |
| `FUNC-CONCIERGE-BOARD` | the Operator | drafted via `l1-spec-guardian`, stamped |
| `FUNC-CHANNEL-SLACK` | the Operator | drafted via `l1-spec-guardian`, stamped |
| `FUNC-OBSERVER` | mechanical | drafted by `l1-spec-guardian`, the Operator stamps |
| `ARCH-*` (4 new) | autonomous | `l2-spec-guardian` |
| `STACK-*` (2 new) | autonomous | `l3-spec-guardian` |

---

## 6. Phasing

Sequence: **bot-first** (chosen variant `i`).

### Phase 0 — Spec ladder *(blocks everything; no code)*

- Author the new specs above.
- `spec-loader.ts` multi-L0 support (~30 LOC + tests).
- traceability passes.

**Effort:** ~1–2 days of authorship + a few hours of code.

### Phase 1 — Concierge skeleton + Slack happy path *(real bot, zero capability)*

- `packages/concierge/` scaffolding (TS, vitest, tsx for dev).
- Slack app installed in `softwarecrafting` workspace; signing-secret verification; Bolt-for-JS receiver.
- Cloudflare Tunnel route for Slack webhook.
- LLM loop with **zero tools** — pure conversation echo.
- SQLite + better-sqlite3 + initial migrations (`conversations`, `messages`).
- `com.concierge.core` launchd plist.

**Output:** the Operator DMs the bot from his phone, it responds. No skills yet.
**Effort:** ~2–3 days.

### Phase 2 — First subsystem: auto-claude tool *(first real capability)*

- `ARCH-TOOL-REGISTRY` implemented: tool registration, schema, audit log.
- Tool clients: `auto_claude.run`, `.status`, `.pause`, `.unstuck`, `.paused_state`.
- `ARCH-CONFIRMATION-LIFECYCLE` for `merge_to_main`.
- Conversation memory: current thread context only; no consolidation yet.

**Output:** "Hey bot, run issue 470" → daemon kicks off → "in progress" → "merged ✅" later.
**Effort:** ~3–4 days.

### Phase 3 — Observer + reactive Slack notifications *(system becomes proactive)*

- `com.concierge.observer` launchd plist; chokidar on `workspaces/*`; daemon-status polling.
- Event-bus SQLite + deterministic classifier rules.
- Reactive flows: stuck-issue → DM; daemon-recovered → DM; manual-commit → silent log.
- **No web board yet.**

**Output:** Bot proactively pings about stuck issues.
**Effort:** ~3 days.

### Phase 4 — Web board *(killer surface)*

- `com.concierge.board` launchd plist.
- Hono + HTMX. SSE for live updates. PWA manifest.
- Cloudflare Tunnel + Cloudflare Access (Google SSO restricted to the Operator's email).
- Card lifecycle (in-flight + needs-you), actions (snooze/done/reply/approve).

**Output:** Mobile board at `board.<your-domain>`.
**Effort:** ~4–5 days.

### Phase 5 — Second-brain memory + tool subsystem

- `second_brain` tool client wrapping `mcp__obsidian__*`.
- Memory consolidation job (nightly, 03:00 local).
- Vault-write contract enforced (paths whitelist, frontmatter validation).
- Tools: `second_brain.read/search/append_inbox/write_decision`.

**Output:** "remember I prefer X" persists; "what did we decide last week?" works.
**Effort:** ~3–4 days. **Can run parallel to Phase 4.**

### Phase 6 — Manual-session awareness

- Observer extends to `~/code/*` (configurable allow-list).
- Privacy/scope rules from `FUNC-OBSERVER` enforced.
- Tool: `observer.recent_activity()`.

**Output:** Bot can answer "what am I in the middle of?".
**Effort:** ~2 days.

### Phase 7 — More subsystems *(open-ended, demand-driven)*

Each new subsystem = `ARCH-TOOL-REGISTRY` entry + minimal client. Promote to its own L1/L2/L3 only when behavior gets non-trivial. Likely order: `gh` (read-only first) → `calendar` → `email` (draft-only by default) → `web` → `slack_send` (high-blast-radius, requires confirmation).

**Effort:** ~1–2 days each.

### Critical path

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──┬──► Phase 4 (board)    ──┐
                                              │                          ├──► Phase 7
                                              ├──► Phase 5 (knowledge-vault)┤
                                              └──► Phase 6 (observer ext)┘
```

Phases 0–3 sequential. Phase 4, 5, 6 can run in parallel after Phase 3. Phases 0–4 ≈ 2.5–3 weeks of focused subagent-driven work.

---

## 7. Open Decisions Resolved

| # | Decision | Choice |
|---|---|---|
| 1 | Coordinator shape | One reasoning concierge (LLM agent) |
| 2 | Where it runs | Mac mini |
| 3 | Surfaces | Slack chat + small web board |
| 4 | Chat platform | Slack `softwarecrafting` workspace |
| 5 | Board content | HITL queue + in-flight monitor (two sections) |
| 6 | Action shape | Direct tools only (no session orchestration); coexists with manual sessions |
| 7 | Repo structure | Same monorepo, rewritten L0 (Approach 3) |
| 8 | Process model | 3 new launchds (concierge-core, observer, board-server) + cloudflared |
| 9 | Storage | Single SQLite |
| 10 | Board auth | Cloudflare Access (Google SSO) |
| 11 | L0 layout | Multi-L0; rewrite `L0-vision.md`, add `L0-ac-vision.md` |
| 12 | Dashboard fate | Keep both `FUNC-AC-DASHBOARD` and `FUNC-CONCIERGE-BOARD` (distinct scopes) |
| 13 | Memory model | Two-tier (knowledge-vault durable + SQLite ephemeral); separate L1 |
| 14 | Phasing variant | `i` — bot-first |
| 15 | Filename convention | Lowercase descriptive paths, uppercase IDs |
| 16 | Confirmation as L2 | Yes — `ARCH-CONFIRMATION-LIFECYCLE` is first-class |
| 17 | Deferred subsystem L1s | OK; placeholders live in `ARCH-TOOL-REGISTRY` |
| 18 | Web stack | Hono + HTMX (not React) |

---

## 8. Out of scope (v1)

- Multi-user / team mode.
- Calendar / email replacement (we *use* them only).
- Session orchestration (concierge does not start or supervise Claude Code / Codex / pi.dev sessions; it observes them).
- Voice input from Slack voice notes (could be added later via Whisper; not in v1).
- LLM-classifier for events (deterministic rules first; LLM classifier only if rules prove insufficient).
- Automatic public Slack posts (channels other than the bot DM are confirmation-gated).
- Notification firehose (only classified-relevant events surface).

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Concierge sends a wrong email/Slack | Hard-coded confirmation gate for any external send (§3.6). |
| Concierge pollutes knowledge-vault | Vault-write whitelist + confirmation for `20-Areas/clients/`. Daily backup of vault recommended. |
| Mac mini downtime kills everything | Accepted in v1. Slack/board both depend on Mac mini. Cloudflare Tunnel auto-reconnects on Mac wake. |
| LLM cost spikes | Tool-call audit log includes cost. Daily cost cap + Slack alert if exceeded. |
| Subsystem schema drift breaks shared SQLite | Schema ownership rules in `ARCH-CONCIERGE-RUNTIME`; only `concierge-core` runs migrations. |
| Observer surfaces noise | Classifier rules deterministic + auditable; tunable thresholds. the Operator can mark a card as "stop showing me this kind of thing" → adds rule. |
| Manual coding sessions get scolded by the bot | Observer is **write-only** by spec contract. Cannot warn, cannot mutate. the Operator must explicitly query. |
| LLM hallucinates a tool | Tool router rejects unknown names; surfaces error to LLM, which reports honestly. |

---

## 10. Success criterion (restated)

> On a typical Tuesday, the Operator sends ≤3 chat messages, glances at the board ≤2 times, and the system handles ≥80 % of routine coordination work without further input.

---

## 11. Next step

After the Operator reviews this design, invoke `superpowers:writing-plans` to produce the implementation plan covering Phase 0 (spec authorship + spec-loader change) as the first executable plan. Subsequent phases each get their own plan once the prior phase's specs are approved.
