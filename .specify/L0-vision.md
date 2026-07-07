---
id: L0-CONCIERGE-VISION
type: vision
domain: concierge
status: deprecated
deprecated_by: L0-AC-VISION
deprecation_date: 2026-06-24
version: 1
layer: 0
---

> **⚠ DEPRECATED (2026-06-24, decision `concierge-vs-platform`).** This concierge vision is **deprecated** and folded into the unified, Operator-approved **L0-AC-VISION** (`.specify/L0-ac-vision.md`), which is the single canonical platform vision — there is one operations-OS, not a separate single-tenant concierge product. The document below is retained for **history only**; it is no longer a live or "additive" product vision. Its concierge L1s are marked fold-in (see each spec's disposition note); the per-behavior re-parent/approval (re-homing each live behavior onto a platform-native, verifier-gatable mechanism) is a **tracked follow-on**, not yet performed. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`.

# L0-CONCIERGE-VISION — Concierge

**Concierge** is a single conversational entry point — a Slack DM with a bot, served from the Operator's macOS host — that turns intent into action across all the Operator's tools. It is an LLM agent with a fixed toolbox (runforge, the knowledge vault, Slack, calendar, email, GitHub, web, observer) and a single mobile-friendly triage board for the small set of items that genuinely need human judgment.

**Why:** The Operator runs multiple parallel workstreams plus operates an autonomous software-development pipeline (runforge). Each surface (GitHub issues, the knowledge vault, Slack, email, calendar) demands its own context switch. The cost is not the individual tools; it is the routing decision the Operator makes a hundred times a day: "where does this thing live, who needs to act on it, when do I get back to it?" The concierge collapses that routing to one chat.

**For:** the Operator, single-tenant. No multi-user mode. No team accounts.

**What the concierge provides:**

- **One inbox** — a Slack DM with the bot is the primary input/output. Long-form work, decisions, "remember this", "did X happen?", "kick off Y" — all flow through the DM.
- **One triage board** — a small mobile-friendly web view (behind Cloudflare Tunnel from the macOS host, Cloudflare-Access-gated to the Operator's email) holding two sections: items that need the Operator's decision and items currently in flight. Glanceable; not a notification firehose.
- **A fixed toolbox** — the concierge has direct, audited tool calls into ~10 subsystems. Most actions happen autonomously. High-blast-radius actions (external email, public Slack post, merge-to-main, vault writes under client folders) require a Slack-confirm tap before executing.
- **Two-tier memory** — the knowledge vault at `~/code/knowledge-vault` is the durable cortex (decisions, captures, daily summaries written nightly via MCP). A local SQLite store is the ephemeral hippocampus (recent threads, audit log, board cards, 7-day rolling summaries). Older memory always falls back to vault search.
- **Coexistence with manual sessions** — the Operator runs Claude Code, Codex, and pi.dev sessions on their own initiative. The concierge **observes** (commits, branches, worktrees) but never manages or warns about manual work. The Operator can ask the concierge "what am I in the middle of?"; the concierge never volunteers it.
- **Skill-distillation loop (Hermes-inspired)** — when the concierge executes the same multi-step pattern several times, it proposes (with confirmation) a distilled skill file in the knowledge vault's plugin marketplace, named after the pattern. Future executions invoke the skill instead of re-deriving the steps.
- **Subsumes the existing Slack-capture daemon** — the Python daemon currently doing Slack capture, briefing, and agent routing. Its responsibilities are absorbed by the concierge in Phase 1+; the existing daemon stays running until feature parity is reached, then is retired.

**What the harness does NOT provide:**

- Calendar / email / Obsidian replacement. The concierge calls them; it does not replace them.
- Session orchestration. Concierge does not start, supervise, or kill Claude Code / Codex / pi.dev sessions.
- Multi-user / team mode. Single-tenant by design.
- Notification firehose. Only events the concierge has classified as relevant ever surface to the Operator.
- A general-purpose chatbot. The concierge has a toolbox and an opinion. Out-of-scope requests get a polite "that's not what I do."

**Operator role:**

1. Author L1 specs when adding new subsystems.
2. Approve production releases of any subsystem.
3. Decide on board cards the concierge surfaces (snooze, approve, deny, defer).

Everything else is autonomous. The concierge does not ask permission for routine reads, drafts, captures, or audited tool calls below the blast-radius gate.

**Subsystem position of `runforge`:**

The existing `packages/daemon` (the GitHub-issue → PR pipeline) is one subsystem the concierge calls. Its governing L0 is `L0-AC-VISION` (this repository's `.specify/L0-ac-vision.md`); that subtree of 14 `FUNC-AC-*` specs is unchanged by this restructure. The relationship between `L0-CONCIERGE-VISION` and `L0-AC-VISION` is expressed in prose only — there is no `parent:` field in `traceability.yml` linking them. The concierge tree is **additive** to the runforge tree. Spec resolvers that walk children find them as siblings in `traceability.yml` and load both via the multi-L0-aware spec-loader.

**Boundaries:**

- Never sends external email, posts to non-DM Slack channels, merges to `main`, or writes vault notes under the client notes area without explicit Slack confirmation.
- Never deletes vault content, edits knowledge vault notes outside its allow-listed paths, or modifies its own implementation/specs.
- Never warns the Operator about their own manual coding sessions.
- Never spawns parallel writer agents for one logical task (single-threaded linear agent per Cognition's "Don't Build Multi-Agents"). Subagents are spawned only for read-heavy noisy tools (gh log scans, web fetches, email triage) where they return a short summary instead of polluting the main loop.

**Success:** On a typical Tuesday, the Operator sends ≤3 chat messages, glances at the board ≤2 times, and the system handles ≥80 % of routine coordination work — issue triage, draft replies, calendar prep, knowledge vault captures, runforge babysitting — without further input.
