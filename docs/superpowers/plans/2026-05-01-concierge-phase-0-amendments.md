# Concierge Phase 0 — Amendments After Codex Pair-Review (v1 → v2)

This file lists the authoritative replacements for the v1 plan at `2026-05-01-concierge-phase-0.md`. Apply these during execution; the v1 plan is preserved for diff and audit.

Codex GPT-5.5 high-effort review (2026-05-01) surfaced two classes of issues:
- **L1 layer-contract violations** in all five L1 specs (Tasks 4–8). The L1 layer must contain zero technology references; the original drafts named Slack, Block Kit, MCP, SQLite, Bolt-for-JS, code paths, and tool prefixes — all of which belong in L2/L3.
- **Structural issues** in Tasks 14 (L3 references L1), 15 (skip-list weakens traceability), and 23 (wrong daemon labels + parallel issue creation).

The amendments below override the v1 content for the listed tasks. All other tasks stand unchanged.

---

## Task 4 (replaces) — `FUNC-CONCIERGE` (layer-clean)

```markdown
---
id: FUNC-CONCIERGE
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-CONCIERGE — Conversational Concierge

## Problem Statement

The operator manages many parallel workstreams (software engineering, freelance work, ministry, personal life). Each workstream has its own home — a knowledge vault, an issue tracker, a calendar, a mailbox, a delivery pipeline. The cost is not the individual systems; it is the routing decision the operator makes a hundred times a day. The concierge is a single conversational assistant the operator can talk to in plain language. The assistant turns intent into action across the available competences, executes routine work itself, and asks for confirmation only when an action is irreversible or visible to people other than the operator.

## Actors

- **Operator** — the single human user.
- **Assistant** — the conversational agent that owns the conversation with the operator and decides what to do.
- **Capability** — an addressable competence the assistant can invoke (e.g., "look up a vault note", "open a delivery run", "draft an email"). Capabilities have known input shapes and a declared blast radius.
- **Confirmation Gate** — a guard the assistant must pass before invoking a high-blast-radius capability.

## Behavior

### Conversation lifecycle

**Scenario: New conversation**
- Given the operator sends a top-level message
- When the assistant receives it
- Then a new conversation context is established
- And subsequent operator messages within the same context continue that conversation

**Scenario: Operator continues an existing conversation**
- Given a conversation context exists
- When the operator continues it
- Then the assistant has access to all prior turns within that context

**Scenario: Operator requests a fresh start**
- Given the operator explicitly asks to reset
- When the assistant receives the reset signal
- Then the current conversation context is closed
- And the next operator message starts a new context

### Capability invocation

**Scenario: Low-blast-radius capability**
- Given the assistant decides to invoke a capability whose effects are reversible and visible only to the operator
- When the capability is invoked
- Then the work is performed immediately and the result is reported back in the conversation

**Scenario: High-blast-radius capability**
- Given the assistant decides to invoke a capability whose effects are irreversible or affect parties other than the operator
- When the capability is selected
- Then the assistant first asks the operator to approve the proposed action, including a summary of what will be done and why approval is needed
- And on operator approval → the capability runs and the result is reported back
- And on operator denial → the assistant is told the action did not proceed
- And if the operator does not respond within 24 hours → the assistant is told the request expired

**Scenario: Unknown capability**
- Given the assistant attempts to use a capability that is not currently available
- When the request is dispatched
- Then the assistant is told the capability is unavailable and may continue the turn with another approach

### Out-of-scope handling

**Scenario: Operator asks for something outside the assistant's competence**
- Given the operator's intent does not map to any available capability
- When the assistant evaluates the request
- Then the assistant declines the request, briefly stating what kinds of work it does cover, and does not invent a capability

### Recurring patterns

**Scenario: A multi-step procedure repeats**
- Given the operator and assistant have walked through the same multi-step procedure several times in distinct conversations
- When the assistant recognises the recurrence
- Then the assistant proposes saving the procedure as a named, reusable shortcut, and asks the operator to confirm
- And on operator approval → the shortcut becomes invocable in future conversations
- And on operator denial → no shortcut is saved and the assistant continues to walk through the procedure as before

### Coexistence with manual work

**Scenario: Operator works outside the conversation**
- Given the operator performs work in some other tool without involving the assistant
- When the assistant subsequently needs context about that work
- Then the assistant may ask the operator, but does not interrupt the operator with unsolicited commentary about it

## Constraints

- **One thread of work per conversation.** The assistant does not divide a single conversation across parallel workers; long-running work appears as a single ongoing turn from the operator's perspective.
- **Audit trail mandatory.** Every capability invocation — successful, denied, expired, or errored — is recorded.
- **No self-modification.** The assistant cannot change its own configuration, its rules, or its specifications.
- **No autonomous external communication.** Any action whose audience extends beyond the operator (a message to another person, a publication, a cross-system change) flows through the Confirmation Gate.

## Success Criterion

1. The operator's intent expressed in plain language is recognised and acted on.
2. Reversible work proceeds without confirmation; irreversible or externally-visible work always asks first.
3. Recurring procedures are recognised and offered as shortcuts.
4. The assistant maintains conversational coherence across turns within a context.

## Out of Scope

- Multiple simultaneous conversations beyond what the underlying conversation channel naturally supports.
- Voice input.
- Multi-user / shared assistant state.
- Autonomous deployment to production.
- Replacing any of the underlying systems the assistant uses.
```

---

## Task 5 (replaces) — `FUNC-CONCIERGE-MEMORY` (layer-clean)

```markdown
---
id: FUNC-CONCIERGE-MEMORY
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-CONCIERGE-MEMORY — Two-Tier Memory

## Problem Statement

A conversational assistant that helps the operator across days needs durable memory of decisions, captures, and stable preferences, and fast recall of recent operational context. A single store cannot serve both: durable memory must survive process restarts and remain curated by the operator; recent memory must be cheap to read in-loop without round-tripping the durable store. Two stores → two contracts.

## Actors

- **Operator** — the human; sole curator of durable knowledge.
- **Assistant** — reads both tiers; writes ephemeral records directly; writes durable records only on operator request or via the nightly consolidation job, and only into allow-listed locations.
- **Consolidator** — a scheduled job that promotes ephemeral activity into a durable summary.

## Behavior

### Durable memory

**Scenario: Operator asks the assistant to remember something**
- Given the operator says "remember X" (or equivalent intent)
- When the assistant evaluates the request
- Then the assistant proposes the durable record (location, summary, content) for operator approval
- And on operator approval → the record is added to the durable store
- And on operator denial → no record is added

**Scenario: Nightly consolidation**
- Given a 24-hour period of conversation and capability activity has elapsed
- When the consolidator runs
- Then a structured summary of the period is added to the durable store at the operator's daily-summary location
- And the summary does not require operator approval, because no client-sensitive content is included

**Scenario: Assistant tries to write to a sensitive location**
- Given the proposed durable write target is under the operator's client area
- When the write is requested
- Then the Confirmation Gate is invoked regardless of the assistant's prior reasoning
- And only on operator approval does the write proceed

**Scenario: Assistant tries to write outside the allow-list**
- Given the proposed durable write target is not on the allow-list
- When the write is requested
- Then the request is rejected at policy level with a clear reason returned to the assistant
- And no operator confirmation is shown

### Recent memory

**Scenario: Assistant assembles context for a turn**
- Given a current conversation turn is being prepared
- When the assistant assembles its working context
- Then the current conversation history and a precomputed compressed summary of recent activity are available
- And queries against older content fall back to the durable store

**Scenario: Capability invocation**
- Given a capability is invoked
- When the invocation resolves
- Then a record of the invocation (what was asked, what was returned in summary, how long it took, status) is appended to the recent activity log

**Scenario: Recent activity retention**
- Given a recent activity record is older than 30 days
- When the consolidator runs
- Then the raw record is removed
- And the durable summary written by earlier consolidator runs continues to represent it

### Recoverable compression

**Scenario: Capability returns a large result**
- Given a capability returns a result larger than the in-context budget
- When the result is folded into the assistant's working context
- Then the bulk content is replaced with a handle (a stable reference) plus a short description
- And the assistant can re-fetch the bulk content if needed

## Constraints

- **Two-tier separation is non-negotiable.** Durable memory holds curated, lasting knowledge; recent memory holds operational records bounded by retention.
- **Allow-list enforcement.** Durable writes outside an explicitly enumerated set of locations are rejected at policy level.
- **Sensitive-location confirmation.** Writes targeting client-sensitive areas always invoke the Confirmation Gate.
- **No lossy summarisation of audit-grade records.** The recent activity log is the authoritative answer to "what did the assistant do?"; summaries derived from it may be lossy but must not replace it.

## Success Criterion

1. "Remember X" results in a durable record the operator can find tomorrow.
2. "What did we do yesterday?" returns a meaningful answer without requiring a query into the durable store.
3. The assistant never writes outside the allow-list.
4. Recent activity older than 30 days disappears from raw form; its summary persists.

## Out of Scope

- Cross-device or cross-vault sync.
- Vector / embedding-based recall as the primary mechanism.
- Operator-facing memory inspection beyond the standard durable-store browser.
- Memory tiers beyond the two specified.
```

---

## Task 6 (replaces) — `FUNC-CONCIERGE-BOARD` (layer-clean)

```markdown
---
id: FUNC-CONCIERGE-BOARD
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-CONCIERGE-BOARD — Triage Surface

## Problem Statement

The conversation channel is good for back-and-forth. It is bad for "what needs me right now?" and "what is the assistant currently doing?". The operator needs an at-a-glance surface, available on the move, that shows two things: items that need an operator decision, and items currently in flight. The surface offers one-tap actions for common decisions; it does not replicate the conversational channel.

## Actors

- **Operator** — views the surface; performs one-tap actions.
- **Assistant** — places items on the surface and reacts to operator actions.
- **Item** — a single decision-needing or in-flight unit on the surface, with optional pre-declared actions.

## Boundary vs. existing operator dashboard

The auto-claude operator dashboard (governed by `FUNC-AC-DASHBOARD`) remains the deep-control surface for the auto-claude subsystem (configuration, run history, cost reports). The triage surface defined here is the at-a-glance cross-subsystem surface for items that need attention or are in flight. The two surfaces have distinct scopes; they may cross-link, but they share no governing data and have no overlapping responsibilities.

## Behavior

### Item lifecycle

**Scenario: Assistant surfaces a decision-needing item**
- Given the assistant has classified an event as needing operator attention
- When the item is created
- Then a card appears in the "needs you" section of the surface
- And a notification is sent through the conversation channel announcing the item

**Scenario: Operator approves a pre-declared action**
- Given a card with a pre-declared "approve" action is shown
- When the operator selects approve
- Then the configured underlying action is invoked
- And on success → the card status moves to "done"
- And on failure → the card shows the error and remains visible

**Scenario: Operator snoozes a card**
- Given a card supports snooze
- When the operator snoozes for a chosen duration
- Then the card is hidden from the active view
- And it reappears automatically when the snooze expires

**Scenario: Operator dismisses a card**
- Given a card the operator wants to clear without firing its action
- When the operator dismisses it
- Then the card status moves to "dismissed"
- And the underlying event is recorded as acknowledged so it does not re-surface

### In-flight items

**Scenario: Assistant starts a long-running capability**
- Given the assistant invokes a capability whose result will not arrive within the conversation turn
- When the capability is dispatched
- Then a card appears in the "in flight" section showing the work in progress
- And the card updates as progress information is received
- And on completion → the card either auto-clears (no operator action needed) or moves to "needs you" (if review is required)

### Live updates

**Scenario: Multiple devices are open**
- Given the operator has the surface open on multiple devices
- When any item changes
- Then all open views reflect the change without manual refresh

### Empty states

**Scenario: No items need the operator**
- Given the "needs you" section is empty
- When the operator opens the surface
- Then the surface shows an explicit "all clear" state with the count of in-flight items

## Constraints

- **Pre-declared actions only.** A card's actions are static at creation time; the operator does not type free-form instructions on a card.
- **No new conversation surface.** The triage surface does not duplicate or replace the conversation channel; conversational back-and-forth happens elsewhere.
- **Restricted access.** Only the operator may view the surface; no team or shared mode.
- **No overlap with the existing operator dashboard.** The triage surface only shows items needing attention or in flight; deep-control views live on the existing dashboard.

## Success Criterion

1. The operator can scan all decision-needing items in a single screen.
2. A one-tap action either fires its pre-declared underlying action or asks for approval — never asks "what next?".
3. Snoozed items reappear without further input at the chosen time.
4. The surface is viable on a phone-sized viewport.

## Out of Scope

- Composing items by the operator (cards are assistant-generated).
- Editing card text or actions after creation.
- Saved filters or per-section custom views.
- Notification mechanisms beyond the conversation channel.
- Multi-user views.
```

---

## Task 7 (replaces) — Renamed `FUNC-OPERATOR-CHANNEL` (was `FUNC-CHANNEL-SLACK`, layer-clean)

**Why renamed:** the L1 may not name a specific platform. Filename: `.specify/functional/operator-channel.md`. Update all references in traceability.yml, the design doc, and prompts accordingly. The choice of platform (Slack) lives in `STACK-CONCIERGE-NODE`.

```markdown
---
id: FUNC-OPERATOR-CHANNEL
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-OPERATOR-CHANNEL — Operator Conversation Channel

## Problem Statement

The assistant needs an always-available conversational surface that delivers reliable mobile push to the operator, supports parallel topics within a single bidirectional channel, and accepts both natural-language input and one-tap structured replies (for confirmations and quick triage decisions). The channel is the assistant's primary input/output.

## Actors

- **Operator** — the sole counterpart on the channel.
- **Assistant** — the agent maintaining the conversation.
- **Confirmation message** — a structured message the assistant sends when a high-blast-radius action is pending; the operator replies via approve/deny controls.

## Behavior

### Inbound

**Scenario: Operator sends a message**
- Given the operator sends a message in the channel
- When the channel delivers it
- Then the assistant receives the message authenticated as from the operator
- And the message is routed into the appropriate conversation context (new top-level vs. continuation)

**Scenario: Authentication failure**
- Given an inbound delivery fails authentication
- When the channel processes it
- Then the message is rejected and never reaches the assistant
- And the failure is recorded

**Scenario: Reset signal**
- Given the operator sends an explicit reset request
- When the channel processes it
- Then the active conversation context is closed and the operator is acknowledged

### Outbound

**Scenario: Assistant replies in the active conversation**
- Given the assistant produces a reply
- When the channel delivers it
- Then the reply appears in the same conversation context the operator started

**Scenario: Confirmation request**
- Given a high-blast-radius action is pending
- When the assistant asks for confirmation
- Then a structured message is delivered with the proposed action's summary and approve/deny controls
- And on operator selection → the result is routed back to the assistant within the same conversation context

### Resilience

**Scenario: Channel is temporarily unavailable**
- Given the channel cannot deliver outbound messages
- When the assistant produces output
- Then the output is queued
- And on channel recovery → the queue drains in the order it was produced
- And the operator does not see a partial conversation

## Constraints

- **Operator-only.** The channel only carries messages between the operator and the assistant. Inbound messages from any other party are ignored.
- **Single channel per operator.** No multi-channel federation in v1.
- **Structured confirmations preserve identity.** A confirmation reply must be unambiguously bound to the pending action it answers.
- **No autonomous publication.** The assistant never originates a message to a channel other than the operator's, except via a confirmation-gated capability.

## Success Criterion

1. The operator's messages reach the assistant within seconds; replies arrive likewise.
2. Reset signals close the active context cleanly.
3. Confirmations are always traceable from request to response.
4. A short channel outage is invisible to the operator.

## Out of Scope

- Voice messages.
- Operator-initiated channel installation flows.
- Channels other than the operator's primary conversation channel.
- Multi-user / shared channels.
```

---

## Task 8 (replaces) — `FUNC-OBSERVER` (renamed concept; layer-clean)

```markdown
---
id: FUNC-OBSERVER
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-OBSERVER — Activity Awareness

## Problem Statement

The operator does not work exclusively through the assistant. The operator runs other tools, edits work, makes commits — sometimes in parallel with the assistant's own activity. The assistant must be able to answer "what is happening on this machine right now?" without nagging the operator about the operator's own work, and without inventing context.

## Actors

- **Observer** — emits events about activity occurring around the assistant.
- **Assistant** — queries the observer when it needs awareness; never receives unsolicited push from the observer.
- **Activity** — a discrete occurrence the operator might care about (a new branch, a new commit, a status change in a long-running system the assistant collaborates with).

## Behavior

### Watch scope

**Scenario: Observer starts**
- Given the observer is launched
- When it initialises
- Then it adopts the configured allow-list of work areas to watch and the ignore-list of paths to drop within them

**Scenario: Allow-listed activity**
- Given activity occurs in a watched area
- When the activity matches the watch criteria
- Then the observer emits a structured event with metadata only (never content)

**Scenario: Ignore-listed path within a watched area**
- Given activity touches an ignore-listed path within a watched area
- When the activity occurs
- Then no event is emitted

**Scenario: Activity outside the allow-list**
- Given activity occurs in an area not on the allow-list
- When the activity occurs
- Then no event is emitted (the observer is not watching it)

### Read-on-demand

**Scenario: Assistant asks "what has happened recently?"**
- Given the assistant invokes the recent-activity capability with a time window
- When the observer responds
- Then a structured summary of events from that window is returned, grouped by area and type

**Scenario: Assistant asks for a status snapshot**
- Given the assistant invokes the status-snapshot capability
- When the observer responds
- Then a recent (≤ one polling interval old) status snapshot is returned

### Privacy

**Scenario: Sensitive-pattern path changes**
- Given a path matching a sensitive-pattern (e.g., environment files, secret stores) changes within a watched area
- When the change occurs
- Then no event is emitted, and no record persists

## Constraints

- **Write-only.** The observer emits events. It never warns the operator, never originates a message of its own, never invokes capabilities, never mutates the filesystem or any external system.
- **Allow-list only.** The observer watches only what the operator has explicitly enumerated.
- **Ignore-list always applied.** Sensitive patterns are filtered before any event reaches downstream consumers.
- **Metadata only.** Event payloads carry references and short fields, never file contents.
- **Bounded retention.** Events older than the configured window are removed; recent events remain queryable.

## Success Criterion

1. The operator's manual work never causes a notification, message, or alert from the assistant.
2. The assistant can answer "what is happening?" with an accurate, recent snapshot in well under a second.
3. Sensitive paths never appear in any event record.
4. An observer process restart loses at most one polling interval of cached state.

## Out of Scope

- Watching anything outside the allow-list, including general filesystem activity.
- Long-term analytics over operator behaviour.
- Detecting in-progress (uncommitted) work; only completed activity is observable.
- Network-level observation.
- Active responses (the observer does not act).
```

---

## Task 14 (correction) — `STACK-CONCIERGE-BOARD` parent reference

The L3 spec must reference an L2, not an L1. Replace the frontmatter `references:` line:

```yaml
references: ARCH-CONCIERGE-RUNTIME    # was: FUNC-CONCIERGE-BOARD (L1; invalid per layer contract)
```

Rationale: `ARCH-CONCIERGE-RUNTIME` already governs the process layout including the board-server process. The board-frontend stack details (HTMX, Hono routes, SSE format, mobile CSS) are a stack-specific implementation of the runtime architecture, so the reference is sound. (If a separate board-architecture L2 is later needed, introduce it then; not necessary in Phase 0.)

---

## Task 15 (correction) — Replace skip-list with placeholder directories

Original v1 added `SKIP_UNTIL_IMPLEMENTED` to `traceability-paths.test.ts` to bypass missing `packages/concierge/` paths. Codex correctly flags this as weakening validation.

Replacement approach: at end of Task 15 Step 4, before running tests, create the placeholder package skeleton so traceability validation is honest:

```bash
mkdir -p packages/concierge/src/board
touch packages/concierge/.gitkeep packages/concierge/src/board/.gitkeep

cat > packages/concierge/package.json <<'EOF'
{
  "name": "@auto-claude/concierge",
  "version": "0.0.0",
  "private": true,
  "description": "Placeholder; concierge implementation lands in Phase 1.",
  "type": "module",
  "scripts": {
    "test": "echo 'no tests yet' && exit 0",
    "typecheck": "echo 'no typecheck yet' && exit 0"
  }
}
EOF

cat > packages/concierge/README.md <<'EOF'
# @auto-claude/concierge

Placeholder. Phase 1+ of the concierge plan adds real source.
See `docs/superpowers/specs/2026-05-01-concierge-design.md` and
`docs/superpowers/plans/2026-05-01-concierge-phase-0.md`.
EOF
```

And in `traceability-paths.test.ts`: **do NOT add the skip-list**. The placeholder directories satisfy the existing path validator. Glob test paths (`packages/concierge/**/*.test.ts`) match nothing initially, which is fine — the validator already skips globs.

Update the Task 15 commit message accordingly:

```bash
git add .specify/traceability.yml packages/concierge/
git commit -m "spec(traceability): add concierge subtree + placeholder package

Adds L0-CONCIERGE-VISION + 5 L1 + 4 L2 + 2 L3 entries. AC subtree
unchanged. No L0-to-L0 parent: field. Placeholder packages/concierge/
skeleton so traceability path validator does not need a skip-list."
```

---

## Task 23 (correction) — Daemon-feedable issue creation

Two corrections:
1. **Labels.** The daemon recognises `feature-pipeline + ready-to-implement` for direct spec-implementation routing, not `spec-implementation` as a label. Add the `l1-approved,l2-approved,l3-approved` markers so generation phases are bypassed (those bypass paths landed in commits `2432867` and `30dc2ee`).
2. **Sequence.** Open ONE issue (FUNC-CONCIERGE) first and verify the daemon picks it up before creating the others. Don't open all five at once and rely on manual serialisation.

Replacement Step 2 of Task 23:

```bash
# Open ONLY the FUNC-CONCIERGE issue first.
gh issue create \
  --title "Implement FUNC-CONCIERGE (concierge core)" \
  --body "$(cat <<'EOF'
Implements .specify/functional/concierge.md.

Spec ID: FUNC-CONCIERGE
L2 children (already drafted, l2-approved): ARCH-CONCIERGE-RUNTIME, ARCH-TOOL-REGISTRY, ARCH-CONFIRMATION-LIFECYCLE
L3 (already drafted, l3-approved): STACK-CONCIERGE-NODE
code_paths target: packages/concierge/

Daemon should skip l2-brainstorm and l3-generate (specs pre-authored,
labelled approved) and run the spec-implementation phase directly.

Reference: docs/superpowers/specs/2026-05-01-concierge-design.md
Phase 1 of the concierge rollout.
EOF
)" \
  --label "feature-pipeline,ready-to-implement,l1-approved,l2-approved,l3-approved" \
  --label "concierge,phase-1"
```

Replacement Step 3: verify daemon pickup with the same `tail -f` command.

Replacement Step 4: only after FUNC-CONCIERGE merges to `dev`, open the remaining four issues using the same template (one per `FUNC-CONCIERGE-MEMORY`, `FUNC-OPERATOR-CHANNEL`, `FUNC-OBSERVER`, `FUNC-CONCIERGE-BOARD`). The daemon's batch classifier may parallelise them safely once the package skeleton exists; if not, serialise.

---

## Cross-cutting consequence: rename `FUNC-CHANNEL-SLACK` → `FUNC-OPERATOR-CHANNEL`

Apply everywhere the v1 plan references the old name:

- Task 7 file path: `.specify/functional/operator-channel.md` (was `channel-slack.md`).
- Task 15 traceability.yml: replace `FUNC-CHANNEL-SLACK:` with `FUNC-OPERATOR-CHANNEL:`; replace inside `L0-CONCIERGE-VISION.children:` accordingly.
- Task 18 prompts: any prompt that references the old name now references the new name.
- Task 23 issue body for the channel L1: title and body use the new name.
- Design doc (`2026-05-01-concierge-design.md`): update §5.2 spec tree, §5.3 traceability, §6 phasing — replace `FUNC-CHANNEL-SLACK` with `FUNC-OPERATOR-CHANNEL`. (Add this as a separate amendment commit before plan execution begins.)
