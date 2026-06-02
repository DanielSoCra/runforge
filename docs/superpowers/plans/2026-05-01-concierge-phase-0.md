> **⛔ SUPERSEDED (2026-06-02).** This design doc's still-valid content has been folded into the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. Retained for history; the canonical specs in `.specify/` govern — do not act on it as a live instruction. See the Spec Reconciliation Ledger (`docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). <!-- RECONCILIATION-LEDGER-BANNER -->

# Concierge Phase 0 — Spec Ladder + Integration Gaps

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author the complete L0/L1/L2/L3 spec chain for the concierge subsystem additions, fix every code/test/prompt integration gap that the spec restructure exposes, and leave the auto-claude daemon in a state where it can pick up GitHub issues for each new spec and self-implement the concierge code in subsequent phases.

**Architecture:** Multi-L0 spec layout (`L0-CONCIERGE-VISION` rewriting `L0-vision.md`, `L0-AC-VISION` extracted to `L0-ac-vision.md`, expressed-in-prose subsystem relationship; **no** L0-to-L0 `parent:` field). Five new L1, four new L2, two new L3 specs in lowercase descriptive filenames. All 14 existing `FUNC-AC-*` specs untouched. Code changes are minimal: spec-loader gains L0 scanning (~50 LOC + tests), prompts/comments/scaffold templates updated to be L0-agnostic, hardcoded L0-AC-VISION test fixtures parameterised.

**Tech Stack:** TypeScript / pnpm monorepo / vitest / Markdown-with-YAML-frontmatter specs / `traceability.yml` line-parser (no YAML lib).

**Successor design doc:** `docs/superpowers/specs/2026-05-01-concierge-design.md` — read it first if you have not already.

**Research integration:** Four parallel research streams informed the spec content:
- **Hermes (NousResearch):** skill-distillation closed loop — concierge promotes recurring trajectories to named skill files in knowledge-vault. Reflected in `FUNC-CONCIERGE` "Learning loop" section.
- **Archon (coleam00):** deterministic DAG-around-LLM pattern. Deferred to a post-Phase-7 enhancement; noted in `FUNC-CONCIERGE` future work but not implemented v1.
- **OpenClaw:** SOUL.md / AGENTS.md / TOOLS.md prompt separation — adopted. The concierge process loads three distinct files at boot.
- **Manus context-engineering playbook:** stable prompt prefix with cache control, file-system-as-memory, recitation, recoverable compression — these are MANDATORY rules in `STACK-CONCIERGE-NODE`.
- **Cognition "Don't Build Multi-Agents":** single-threaded linear concierge; subagents only for read-heavy noisy tools. Reflected in `ARCH-CONCIERGE-RUNTIME`.
- **Local repo audit:** `~/code/knowledge-vault-slack-bot` already exists as a Slack↔Obsidian Python daemon. Concierge **subsumes** it — its capture, briefing, and agent-routing duties become concierge tools. Existing daemon marked deprecated-by-concierge in its README at end of Phase 0; actual deletion comes in Phase 2 once concierge has feature parity. Documented in `L0-CONCIERGE-VISION`.

---

## Daemon coexistence

The auto-claude daemon is running on the Mac mini. Phase 0 only edits specs, prompts, traceability, and adds tests. **No production code under `packages/` is modified.** No daemon restart is required. After Phase 0 commits land on `dev`, the daemon will pick up the new traceability tree on its next config sync.

---

## Tasks

Each task is independent of subsequent tasks where possible. Sequence respects: (1) spec-loader change before any spec uses multi-L0 in a test, (2) L0 split before L1 specs reference it in traceability, (3) L1 before L2 before L3, (4) traceability.yml after all spec files exist.

---

### Task 1: spec-loader.ts gains multi-L0 root scanning

**Why:** `extractSpecId()` and `loadSpecContent()` only walk `functional/`, `architecture/`, `stack/`. The current L0 is referenced only by path (`.specify/L0-vision.md`) in prompts, never loaded by id. After the split, callers like `resolveCurrentSpecRefs` need both `L0-CONCIERGE-VISION` and `L0-AC-VISION` discoverable as content. Without this change, any future caller that wants to load the L0 by id (rather than by path) will fail silently.

**Files:**
- Modify: `packages/daemon/src/infra/spec-loader.ts:5,12-45`
- Create: `packages/daemon/src/infra/spec-loader.test.ts` (if not present, otherwise extend)
- Reference fixture: `.specify/L0-vision.md`, `.specify/L0-ac-vision.md` (do NOT yet exist — test will fixture them in `tmp` dir)

- [ ] **Step 1: Write the failing test**

Append to `packages/daemon/src/infra/spec-loader.test.ts` (create if missing):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpecContent } from './spec-loader.js';

describe('spec-loader multi-L0 support', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'spec-loader-'));
    const specifyDir = join(root, '.specify');
    await mkdir(specifyDir, { recursive: true });
    await mkdir(join(specifyDir, 'functional'), { recursive: true });
    await writeFile(
      join(specifyDir, 'L0-vision.md'),
      `---\nid: L0-CONCIERGE-VISION\ntype: vision\nlayer: 0\n---\n# Concierge L0\n`,
    );
    await writeFile(
      join(specifyDir, 'L0-ac-vision.md'),
      `---\nid: L0-AC-VISION\ntype: vision\nlayer: 0\n---\n# Auto-Claude L0\n`,
    );
    await writeFile(
      join(specifyDir, 'functional/concierge.md'),
      `---\nid: FUNC-CONCIERGE\nlayer: 1\n---\n# concierge L1\n`,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loads both L0 specs by id from the .specify root', async () => {
    const content = await loadSpecContent(
      ['L0-CONCIERGE-VISION', 'L0-AC-VISION'],
      join(root, '.specify'),
    );
    expect(content).toContain('Concierge L0');
    expect(content).toContain('Auto-Claude L0');
  });

  it('still loads subdir specs alongside L0 specs', async () => {
    const content = await loadSpecContent(
      ['L0-CONCIERGE-VISION', 'FUNC-CONCIERGE'],
      join(root, '.specify'),
    );
    expect(content).toContain('Concierge L0');
    expect(content).toContain('concierge L1');
  });

  it('does not match non-L0 root files', async () => {
    await writeFile(
      join(root, '.specify/traceability.yml'),
      'irrelevant: content\n',
    );
    const content = await loadSpecContent(
      ['L0-CONCIERGE-VISION'],
      join(root, '.specify'),
    );
    expect(content).toContain('Concierge L0');
    expect(content).not.toContain('irrelevant');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @auto-claude/daemon exec vitest run src/infra/spec-loader.test.ts
```

Expected: 3 failures — root-level L0 files are not scanned.

- [ ] **Step 3: Implement multi-L0 support**

Edit `packages/daemon/src/infra/spec-loader.ts`:

```typescript
// At top of file, replace SPEC_DIRS with two scans:
const SPEC_DIRS = ['functional', 'architecture', 'stack'] as const;
const ROOT_PATTERN = /^L0-.*\.md$/;

// Add a new helper above loadSpecContent:
async function loadRootLevelSpecs(
  specifyRoot: string,
  refSet: Set<string>,
  matched: string[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(specifyRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!ROOT_PATTERN.test(entry)) continue;
    const filePath = join(specifyRoot, entry);
    const content = await readFile(filePath, 'utf-8');
    const id = extractSpecId(content);
    if (id && refSet.has(id)) {
      matched.push(content);
      refSet.delete(id);
      if (refSet.size === 0) return;
    }
  }
}

// In loadSpecContent, call loadRootLevelSpecs BEFORE the for-loop over SPEC_DIRS:
export async function loadSpecContent(
  specRefs: string[],
  specifyRoot: string,
): Promise<string> {
  if (specRefs.length === 0) return '';

  const refSet = new Set(specRefs);
  const matched: string[] = [];

  await loadRootLevelSpecs(specifyRoot, refSet, matched);
  if (refSet.size === 0) return matched.join('\n\n---\n\n');

  for (const dir of SPEC_DIRS) {
    // ... existing body unchanged
  }

  return matched.join('\n\n---\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @auto-claude/daemon exec vitest run src/infra/spec-loader.test.ts
```

Expected: 3 PASS.

- [ ] **Step 5: Run full daemon test suite to confirm no regression**

```bash
pnpm --filter @auto-claude/daemon test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/infra/spec-loader.ts packages/daemon/src/infra/spec-loader.test.ts
git commit -m "feat(spec-loader): scan .specify/ root for L0 files

Adds multi-L0 root scanning so loadSpecContent() can resolve both
L0-CONCIERGE-VISION and L0-AC-VISION by id. Subdir scanning unchanged.
Required for the concierge spec restructure."
```

---

### Task 2: Extract current L0 content into `.specify/L0-ac-vision.md`

**Why:** The current `L0-vision.md` content is the auto-claude subsystem vision. We preserve it verbatim under a new filename + new path so the rewritten `L0-vision.md` can hold the new product L0 (concierge).

**Files:**
- Create: `.specify/L0-ac-vision.md`
- Source: `.specify/L0-vision.md` (current content, lines 1-40)

- [ ] **Step 1: Copy current `.specify/L0-vision.md` to `.specify/L0-ac-vision.md` verbatim**

```bash
cp .specify/L0-vision.md .specify/L0-ac-vision.md
```

- [ ] **Step 2: Verify the new file has identical content (id still `L0-AC-VISION`)**

```bash
diff .specify/L0-vision.md .specify/L0-ac-vision.md
# Expected: no diff
head -10 .specify/L0-ac-vision.md
# Expected: id: L0-AC-VISION
```

- [ ] **Step 3: Add a short header note above the existing content explaining the new role**

Insert after the frontmatter `---` close (before the `# L0-AC-VISION` heading), one paragraph:

```markdown
> **Note (2026-05-01):** This document is now the **subsystem L0 for `auto-claude`** within the broader concierge product. The product-level vision lives at `.specify/L0-vision.md` (id `L0-CONCIERGE-VISION`). The relationship between the two L0s is expressed in prose, not via a `parent:` field — see "Subsystem position" in the concierge L0.

```

- [ ] **Step 4: Commit**

```bash
git add .specify/L0-ac-vision.md
git commit -m "spec: extract current L0 to L0-ac-vision.md (auto-claude subsystem L0)

Verbatim copy of L0-vision.md under a new path. Adds a one-paragraph
note explaining its new role as the subsystem L0. The L0-vision.md path
will be rewritten in the next commit to hold the product-level L0."
```

---

### Task 3: Rewrite `.specify/L0-vision.md` as `L0-CONCIERGE-VISION`

**Why:** This is the new top-level product narrative — the autonomous-life-OS. It also locks in the research findings so subsequent specs and the daemon's spec-implementation phase can ground in a single coherent product vision.

**Files:**
- Modify: `.specify/L0-vision.md` (full rewrite)

- [ ] **Step 1: Replace the file's full content with the rewritten L0**

```markdown
---
id: L0-CONCIERGE-VISION
type: vision
domain: concierge
status: draft
version: 1
layer: 0
---

# L0-CONCIERGE-VISION — Concierge

**Concierge** is a single conversational entry point — a Slack DM with a bot, served from the Operator's Mac mini — that turns intent into action across all his tools. It is an LLM agent with a fixed toolbox (auto-claude, knowledge-vault Obsidian vault, Slack, calendar, email, GitHub, web, observer) and a single mobile-friendly triage board for the small set of items that genuinely need human judgment.

**Why:** the Operator runs three workstreams in parallel — a B2B CTO role, a freelance product project, and church ministry — plus operates an autonomous software-development pipeline (auto-claude). Each surface (GitHub issues, Obsidian, Slack, email, calendar) demands its own context switch. The cost is not the individual tools; it is the routing decision he makes a hundred times a day: "where does this thing live, who needs to act on it, when do I get back to it?" The concierge collapses that routing to one chat.

**For:** the Operator, single-tenant. No multi-user mode. No team accounts.

**What the concierge provides:**

- **One inbox** — a Slack DM with the bot is the primary input/output. Long-form work, decisions, "remember this", "did X happen?", "kick off Y" — all flow through the DM.
- **One triage board** — a small mobile-friendly web view (behind Cloudflare Tunnel from the Mac mini, Cloudflare-Access-gated to the Operator's email) holding two sections: items that need the Operator's decision and items currently in flight. Glanceable; not a notification firehose.
- **A fixed toolbox** — the concierge has direct, audited tool calls into ~10 subsystems. Most actions happen autonomously. High-blast-radius actions (external email, public Slack post, merge-to-main, vault writes under client folders) require a Slack-confirm tap before executing.
- **Two-tier memory** — the Obsidian vault at `~/code/knowledge-vault` is the durable cortex (decisions, captures, daily summaries written nightly via MCP). A local SQLite store is the ephemeral hippocampus (recent threads, audit log, board cards, 7-day rolling summaries). Older memory always falls back to vault search.
- **Coexistence with manual sessions** — the Operator runs Claude Code, Codex, and pi.dev sessions on his own initiative. The concierge **observes** (commits, branches, worktrees) but never manages or warns about manual work. He can ask the concierge "what am I in the middle of?"; the concierge never volunteers it.
- **Skill-distillation loop (Hermes-inspired)** — when the concierge executes the same multi-step pattern several times, it proposes (with confirmation) a distilled skill file in the knowledge-vault `personal-claude` plugin marketplace, named after the pattern. Future executions invoke the skill instead of re-deriving the steps.
- **Subsumes the existing `~/code/knowledge-vault-slack-bot`** — the Python daemon currently doing Slack capture, briefing, and agent routing. Its responsibilities are absorbed by the concierge in Phase 1+; the existing daemon stays running until feature parity is reached, then is retired (deprecation note in its README at end of Phase 0).

**What the harness does NOT provide:**

- Calendar / email / Obsidian replacement. The concierge calls them; it does not replace them.
- Session orchestration. Concierge does not start, supervise, or kill Claude Code / Codex / pi.dev sessions.
- Multi-user / team mode. Single-tenant by design.
- Notification firehose. Only events the concierge has classified as relevant ever surface to the Operator.
- A general-purpose chatbot. The concierge has a toolbox and an opinion. Out-of-scope requests get a polite "that's not what I do."

**Operator role (the Operator):**

1. Author L1 specs when adding new subsystems.
2. Approve production releases of any subsystem.
3. Decide on board cards the concierge surfaces (snooze, approve, deny, defer).

Everything else is autonomous. The concierge does not ask permission for routine reads, drafts, captures, or audited tool calls below the blast-radius gate.

**Subsystem position of `auto-claude`:**

The existing `packages/daemon` (the GitHub-issue → PR pipeline) is one subsystem the concierge calls. Its governing L0 is `L0-AC-VISION` (this repository's `.specify/L0-ac-vision.md`); that subtree of 14 `FUNC-AC-*` specs is unchanged by this restructure. The relationship between `L0-CONCIERGE-VISION` and `L0-AC-VISION` is expressed in prose only — there is no `parent:` field in `traceability.yml` linking them. The concierge tree is **additive** to the auto-claude tree. Spec resolvers that walk children find them as siblings in `traceability.yml` and load both via the multi-L0-aware spec-loader.

**Boundaries:**

- Never sends external email, posts to non-DM Slack channels, merges to `main`, or writes vault notes under `20-Areas/clients/` without explicit Slack confirmation.
- Never deletes vault content, edits knowledge-vault notes outside its allow-listed paths, or modifies its own implementation/specs.
- Never warns the Operator about his own manual coding sessions.
- Never spawns parallel writer agents for one logical task (single-threaded linear agent per Cognition's "Don't Build Multi-Agents"). Subagents are spawned only for read-heavy noisy tools (gh log scans, web fetches, email triage) where they return a short summary instead of polluting the main loop.

**Success:** On a typical Tuesday, the Operator sends ≤3 chat messages, glances at the board ≤2 times, and the system handles ≥80 % of routine coordination work — issue triage, draft replies, calendar prep, knowledge-vault captures, auto-claude babysitting — without further input.
```

- [ ] **Step 2: Verify the file's frontmatter id is the new value**

```bash
head -10 .specify/L0-vision.md
# Expected: id: L0-CONCIERGE-VISION
```

- [ ] **Step 3: Commit**

```bash
git add .specify/L0-vision.md
git commit -m "spec(L0): rewrite L0-vision.md as L0-CONCIERGE-VISION

Path stays at .specify/L0-vision.md so existing references continue to
resolve. Frontmatter id changes from L0-AC-VISION to L0-CONCIERGE-VISION.
Subsystem relationship to L0-AC-VISION expressed in prose, not as a
parent: field (per Codex spec-restructure review)."
```

---

### Task 4: Author `FUNC-CONCIERGE`

**Files:**
- Create: `.specify/functional/concierge.md`

- [ ] **Step 1: Write the spec**

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

the Operator needs one conversational surface that accepts intent in any form (a one-liner, a paragraph, a voice note transcribed by Slack), routes it to the right subsystem, executes what it can autonomously, and asks for confirmation only when blast radius requires it. The surface must remember what was said, what was done, and what was decided across days — without becoming an unmanaged log.

## Actors

- **Operator** — the Operator. Single user.
- **Concierge** — the LLM agent that owns the conversation.
- **Tool** — a callable subsystem (auto-claude, knowledge-vault, Slack-send, calendar, email, gh, web, observer).
- **Confirmation Gate** — the mechanism that intercepts high-blast-radius tool calls and routes them to a Slack confirm message before execution.

## Behavior

### Conversation lifecycle

**Scenario: Operator sends a top-level Slack DM**
- Given the operator DMs the concierge bot with a top-level message
- When the bot receives the event
- Then a new conversation is created bound to the Slack thread the message starts
- And subsequent messages in that thread continue the same conversation context

**Scenario: Operator sends a reply within an existing thread**
- Given a conversation already exists for the thread
- When the operator replies in the thread
- Then the message is appended to the existing conversation context
- And the LLM turn includes the entire thread history (or a recoverable-compressed version if length exceeds budget)

**Scenario: Operator types `/reset` slash command**
- Given the operator types `/reset` in any thread
- When the slash command is received
- Then the current conversation is marked closed
- And subsequent messages in the same thread start a new conversation

### Tool calls

**Scenario: Low-blast-radius action**
- Given the concierge decides to call `auto_claude.status()` (read-only)
- When the tool is invoked
- Then the call executes immediately and the result feeds back to the LLM
- And the call is recorded in the audit log

**Scenario: High-blast-radius action**
- Given the concierge decides to call `email.send(to: external)` (irreversible)
- When the tool is invoked
- Then a Slack confirm message is posted with the proposed action's full payload
- And the tool call is held pending until the operator taps ✅ or ❌
- And confirmed → executes; denied → returns "denied by operator" to the LLM; expired (24h) → returns "confirmation timed out"

**Scenario: Unknown tool name**
- Given the LLM emits a tool_use with a name not in the registry
- When the tool router receives the call
- Then the call returns an error to the LLM ("unknown tool: <name>")
- And the LLM continues the turn able to retry with a known name

### Out-of-scope handling

**Scenario: Operator asks for something not in the toolbox**
- Given the operator asks something the concierge cannot do (e.g., "play music")
- When the concierge processes the turn
- Then the concierge replies with a polite refusal naming what it does instead of inventing a tool call
- And the message is logged but no tool call is attempted

### Skill distillation

**Scenario: Recurring multi-step pattern**
- Given the concierge has executed the same ordered sequence of ≥3 tool calls ≥3 times across distinct conversations
- When the recognizer detects the pattern
- Then the concierge proposes a distilled skill file (named after the pattern, parametrised on inputs) via Slack confirm message
- And confirmed → the skill file is written to knowledge-vault's `30-Resources/personal-claude-skills/` via MCP
- And future invocations of similar intent prefer calling the skill over re-deriving steps

### Coexistence with manual sessions

**Scenario: Operator opens Claude Code in a worktree**
- Given the operator manually creates a worktree under `workspaces/issue-N` outside the concierge
- When the observer detects the new worktree
- Then the event is logged silently — no Slack DM, no board card, no warning
- And the operator can later ask "what am I in the middle of?" and the concierge replies based on observer events

## Constraints

- **Single-threaded agent.** One LLM loop per conversation. No parallel writer subagents. Read-heavy noisy tools (gh log scans, web fetch, email triage) MAY be dispatched to a subagent that returns a structured summary, never raw content. (Cognition "Don't Build Multi-Agents".)
- **Tool naming convention.** Tools are namespaced by subsystem prefix: `ac_*` for auto-claude, `sb_*` for knowledge-vault, `gh_*` for GitHub, `cal_*` for calendar, `mail_*` for email, `slack_*` for Slack-send-elsewhere, `web_*` for web fetch, `obs_*` for observer. The LLM groups tools cognitively by prefix.
- **No timestamps or dynamic IDs in the prompt prefix.** Cache stability is critical (5 m TTL on rolling summary, 1 h TTL on system+tools). Timestamps in the prefix nuke cache hits.
- **No autonomous external sends.** Email to anyone outside the Operator's own addresses, Slack messages to channels other than the operator DM, GitHub merges to `main`, and vault writes under `20-Areas/clients/` always go through the confirmation gate.
- **No spec self-modification.** The concierge cannot edit `.specify/`, `prompts/`, or its own L0/L1.
- **Audit trail mandatory.** Every tool call (allowed, confirmed, denied, errored) is logged to `tool_calls` with timestamp, args, result, latency, cost.

## Success Criterion

On any given conversation, the concierge:
1. Replies coherently within the same Slack thread.
2. Executes routine intent without confirmation.
3. Surfaces high-blast actions for explicit approval.
4. Persists durable knowledge to knowledge-vault on operator request and on nightly consolidation.
5. Never warns about manual coding sessions; always answers when asked about them.

## Out of Scope

- Any UI surface other than Slack DM + the triage board.
- Voice input (defer; could be added via Whisper transcription of Slack voice notes).
- Multi-conversation parallelism beyond Slack's natural threading.
- Autonomous deployment to production (always operator-approved).
- LLM-classifier for events (the concierge uses the deterministic event-bus classifier — see `ARCH-EVENT-BUS`).
- Tool RAG / semantic tool retrieval (the toolbox stays under ~50 entries; LLM-loop-with-tools is the router).
- Deterministic DAG-style workflows (Archon-pattern, deferred — `FUNC-CONCIERGE` v1 is single-LLM-loop only).
```

- [ ] **Step 2: Lint frontmatter**

```bash
head -8 .specify/functional/concierge.md
# Expected: id: FUNC-CONCIERGE, layer: 1, type: functional
```

- [ ] **Step 3: Commit**

```bash
git add .specify/functional/concierge.md
git commit -m "spec(L1): FUNC-CONCIERGE — conversational concierge"
```

---

### Task 5: Author `FUNC-CONCIERGE-MEMORY`

**Files:**
- Create: `.specify/functional/concierge-memory.md`

- [ ] **Step 1: Write the spec**

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

A concierge that helps across days needs durable memory of decisions, captures, and stable preferences, plus fast access to recent operational context (last 7 days of threads, tool calls, board state). One single store cannot serve both: the durable layer must survive process restarts and be human-curated; the operational layer must be cheap to query in-loop without round-tripping a vault. Two stores → two write contracts.

## Actors

- **Operator** — the Operator; the only writer of curated content into the durable layer (manually or via concierge with confirmation).
- **Concierge** — reads both tiers; writes ephemeral to SQLite directly; writes durable to vault only via MCP and only into allow-listed paths.
- **Consolidator** — a nightly job (launchd `StartCalendarInterval`) that promotes ephemeral logs into a daily summary in the vault.

## Behavior

### Cortex (durable tier — Obsidian vault)

**Scenario: Operator says "remember I prefer X"**
- Given the operator types "remember I prefer X" or equivalent intent
- When the concierge processes the turn
- Then a Slack confirm message is posted showing the proposed vault write (path, frontmatter, body)
- And confirmed → write executes via `mcp__obsidian__patch_note` or `write_note` to `00-inbox/<slug>.md`
- And denied → no write, the LLM is told the operator declined

**Scenario: Concierge writes a daily summary**
- Given the consolidator job runs at 03:00 local
- When yesterday's `tool_calls` audit log + Slack thread cache exist
- Then the concierge composes a structured summary (decisions made, work executed, items deferred)
- And the summary is written via MCP to `~/code/knowledge-vault/50-Daily/YYYY-MM-DD.md`
- And the write does not require a Slack confirm (50-Daily is allow-listed, no client data)

**Scenario: Vault write under `20-Areas/clients/`**
- Given the concierge wants to write any path under `20-Areas/clients/`
- When the tool router intercepts the call
- Then a Slack confirm message is posted regardless of operator intent (always-confirm rule)
- And confirmed → write executes; denied → no write

**Scenario: Vault write outside allow-list**
- Given the concierge attempts to write to a path not on the allow-list (e.g., `30-Resources/Tools/`)
- When the tool router checks the path
- Then the call returns an error to the LLM ("write not permitted: <path>")
- And no Slack confirm is shown (denied-by-policy, not denied-by-operator)

### Hippocampus (ephemeral tier — SQLite)

**Scenario: Slack thread cache**
- Given the concierge processes a Slack message
- When the LLM turn completes
- Then the message + assistant reply are persisted to SQLite `messages` table within the conversation row
- And subsequent turns within the same thread read from SQLite without round-tripping Slack

**Scenario: Tool call audit**
- Given any tool call is invoked (allowed, confirmed, denied, errored)
- When the call resolves
- Then a row is written to `tool_calls` with timestamp, conversation_id, tool_name, args (JSON), result_summary, status, latency_ms, cost_usd
- And the audit row is read-only after write

**Scenario: 7-day rolling summary**
- Given the operator opens a new conversation
- When the LLM turn assembles its prompt
- Then a precomputed compressed summary of the last 7 days of conversations + decisions is injected as a system note
- And the summary is recomputed by the consolidator job nightly (not on-demand)

**Scenario: Retention purge**
- Given a row in `tool_calls` or `messages` is older than 30 days
- When the consolidator job runs
- Then the row is deleted from SQLite
- And the durable summary in `50-Daily/` retains the structured information

### Recoverable compression

**Scenario: Tool returns large payload**
- Given a tool returns >2 KB of content (e.g., a fetched web page, an email body)
- When the result is appended to the LLM context
- Then the content is replaced with a handle (URL, message-id, vault path) plus a one-line description
- And the LLM can re-fetch the content via tool call if it needs the body
- (Manus pattern: drop content, keep handles.)

## Constraints

- **All vault writes go through `mcp__obsidian__*` MCP tools.** Never raw file writes. Preserves frontmatter integrity per `~/code/knowledge-vault/00-Meta/agent-access.md`.
- **Allow-listed write paths:** `00-inbox/`, `50-Daily/`, project-specific paths the operator explicitly grants per-project. Everything under `20-Areas/clients/` always-confirms. Everything under `00-Meta/`, `30-Resources/Frameworks/`, `30-Resources/Tools/` is **read-only** for the concierge.
- **No lossy LLM summarization of audit trails.** The `tool_calls` table is the ground truth for "what did the bot do today." Summaries derived from it can be lossy; the source must not be.
- **No vector embeddings of vault content as primary recall.** Obsidian's full-text search + frontmatter + explicit links is the primary read mechanism. Embeddings may be added later only if grep stops finding things.
- **Read latency budget.** A single LLM turn must not require more than 1 round-trip to Obsidian MCP for context. Anything more goes via the precomputed 7-day summary.
- **Cache control.** The 7-day summary is injected with `cache_control: { type: "ephemeral", ttl: "5m" }`. The user profile (read once at consolidation, embedded in the system prompt) uses `ttl: "1h"`. Recent turns are uncached.

## Success Criterion

1. Asking "remember I prefer X" persists durably and is recallable next day.
2. Asking "what did we do yesterday?" returns a structured summary in <2 s without hitting the vault.
3. The concierge never writes outside its allow-list.
4. SQLite size stays bounded under 100 MB indefinitely (bounded by 30-day retention).

## Out of Scope

- Any cross-vault sync (operator's vault is on this Mac mini only).
- Vector search over chat history.
- LLM-summarised compression of `tool_calls` (use raw rows; trust them).
- Memory tiering beyond cortex/hippocampus (no "neocortex" / extra layer).
```

- [ ] **Step 2: Commit**

```bash
git add .specify/functional/concierge-memory.md
git commit -m "spec(L1): FUNC-CONCIERGE-MEMORY — two-tier memory"
```

---

### Task 6: Author `FUNC-CONCIERGE-BOARD`

**Files:**
- Create: `.specify/functional/concierge-board.md`

- [ ] **Step 1: Write the spec**

```markdown
---
id: FUNC-CONCIERGE-BOARD
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-CONCIERGE-BOARD — Mobile Triage Board

## Problem Statement

The Slack DM is great for back-and-forth and natural language. But scanning "what needs me right now?" or "what's currently in flight?" in a conversational stream is awful: items get pushed up, no batch view, no swipe affordances. the Operator needs a small, fast, mobile-first surface that shows two sections — items needing his decision, items currently being worked on — with one-tap actions.

## Actors

- **Operator** — the Operator; views the board on phone or laptop; taps card actions.
- **Concierge** — writes/updates cards; reacts to operator actions by triggering tool calls.
- **Event bus** — feeds the board with classified events (see `ARCH-EVENT-BUS`).

## Boundary vs. `FUNC-AC-DASHBOARD`

The auto-claude dashboard at `packages/dashboard/` (governed by `FUNC-AC-DASHBOARD`) remains the **operator's deep-control surface for the auto-claude subsystem** — repository config, API keys, run history, cost reports, briefings. the Operator uses it occasionally on a laptop to manage the auto-claude pipeline.

The concierge board is the **ambient mobile triage surface for the entire concierge** — across all subsystems, not just auto-claude. It does not duplicate dashboard responsibilities (no repo config, no API key management, no cost reports). It only surfaces actionable items.

The two surfaces share no code, no schema, no auth provider. Cross-deep-link is allowed (a card may open the dashboard for richer context) but the board never embeds dashboard views.

## Behavior

### Card lifecycle

**Scenario: Concierge surfaces a needs-you item**
- Given the event-bus classifier outputs `surface_card` for a daemon_stuck event on issue #470
- When the card is created
- Then a row is written to the `cards` SQLite table with `status: needs_you`, source subsystem, source event reference, action mapping, created_at
- And an SSE message is pushed to all open board clients
- And a Slack DM is posted with the card summary + a link to the board

**Scenario: Operator taps "Approve" on a card**
- Given a card with `actions: [{label: "Approve", tool: "gh.add_label", args: {label: "l1-approved"}}]` is shown
- When the operator taps Approve
- Then the board-server invokes the configured tool via the concierge tool router
- And on success → card status flips to `done` and SSE pushes the update to other clients
- And on failure → card status flips to `errored`, error reason shown inline, no auto-retry

**Scenario: Operator taps "Snooze 4h"**
- Given a card with snooze action
- When tapped
- Then card status flips to `snoozed_until: now+4h`
- And the card is hidden from the active view but appears again automatically when the snooze expires

**Scenario: Operator taps "Done" without action**
- Given a card the operator wants to dismiss without firing its tool
- When tapped
- Then card status flips to `dismissed`
- And no tool call is made
- And the underlying event (in the event-bus) is marked `acknowledged` so it does not re-surface

### In-flight monitor

**Scenario: Concierge dispatches an autonomous tool call**
- Given the concierge invokes `auto_claude.run(issue: 476)` (long-running)
- When the call returns "started, run_id: <id>"
- Then a card is created with `status: in_flight`, source = auto-claude, label = "Running #476"
- And the card is updated by the observer's polling of daemon status (active phase, cost, ETA)
- And on completion → card flips to `needs_you` if review is needed, or auto-dismisses to `done` if no human action required

**Scenario: Operator opens the board with no needs-you items**
- Given the needs-you section is empty
- When the operator opens the board
- Then the section shows "All clear ✓" with a count of in-flight items below

### Auth

**Scenario: Operator opens the board URL**
- Given the operator visits `board.<your-domain>` from any device
- When the request hits Cloudflare Tunnel
- Then Cloudflare Access enforces Google SSO restricted to `operator@example.com`
- And on auth success → request is forwarded to the board-server with the user identity in headers
- And the board-server trusts the Cloudflare-Access JWT (no app-side auth code)

**Scenario: Unauthenticated request**
- Given any visitor without valid Cloudflare Access JWT
- When they visit the board URL
- Then Cloudflare Access redirects to Google SSO
- And on failed SSO (wrong email, no Google account) → 403, no app code runs

### Updates

**Scenario: Live card update**
- Given the operator has the board open
- When a card is created, updated, or its status changes
- Then an SSE message is pushed to that client
- And the client patches the visible DOM without a full reload (HTMX SSE extension)

## Constraints

- **HTMX-only frontend.** No React, no Next.js. Server-rendered HTML, hyperscript for tiny interactions, HTMX for partial updates and SSE. PWA via web manifest. Rationale: ship-speed; the Operator is the only user.
- **No app-side auth.** Cloudflare Access is the auth boundary. Removing it = the board is unauthenticated. The board-server trusts the JWT header.
- **Card actions are pre-declared.** The set of available actions for a card type is static (defined when the card type is registered). Operators do not type free-form actions on a card — they tap buttons.
- **No write-after-read for tool invocation.** A card action invokes a tool; if the tool requires confirmation, the confirmation flow is the same as for a chat-driven tool call (Slack confirm). The board does not duplicate confirmation UI.
- **Mobile-first.** Layout works on a 375 px wide viewport. Cards stack vertically. Tap targets ≥44 px. Ships before Phase 4 ends.

## Success Criterion

1. the Operator opens the board on his phone in <500 ms (Mac mini → Cloudflare → phone).
2. The needs-you section shows ≤5 items in steady state.
3. Tapping any action either fires a tool or presents a confirm — never a "what next?" question.
4. Snoozed items reappear at the snooze time without further input.

## Out of Scope

- Multi-tenant boards.
- Notifications outside Slack (no native push, no email digest).
- Card composition by the operator (cards are concierge-generated only).
- Editable rich text on cards.
- Custom views or saved filters.
```

- [ ] **Step 2: Commit**

```bash
git add .specify/functional/concierge-board.md
git commit -m "spec(L1): FUNC-CONCIERGE-BOARD — mobile triage board"
```

---

### Task 7: Author `FUNC-CHANNEL-SLACK`

**Files:**
- Create: `.specify/functional/channel-slack.md`

- [ ] **Step 1: Write the spec**

```markdown
---
id: FUNC-CHANNEL-SLACK
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-CHANNEL-SLACK — Slack Channel

## Problem Statement

The concierge needs an always-available conversational surface that delivers reliable mobile push, supports threading for parallel topics, and accepts both natural-language input and structured replies (button taps, slash commands). Slack provides all three via Bolt-for-JS in the Operator's pre-existing `softwarecrafting` workspace.

## Actors

- **Operator** — the Operator; DMs the bot; replies in threads; taps confirmation buttons.
- **Concierge** — receives normalised events; produces text replies and Block Kit confirm messages.
- **Slack** — the platform delivering events via webhook and accepting outbound messages via API.

## Behavior

### Inbound events

**Scenario: Operator DMs the bot**
- Given the operator sends a top-level message in their DM with the concierge bot
- When Slack delivers the event to the configured Events API URL
- Then the slack-adapter verifies the request signature (using the signing secret)
- And on signature valid → the event is normalised to internal shape and dispatched to the concierge
- And on signature invalid → request is rejected with 401, no internal dispatch

**Scenario: Operator replies in an existing thread**
- Given the operator replies in a thread with `thread_ts: T`
- When Slack delivers the message event
- Then the slack-adapter looks up the conversation by thread_ts
- And the message is appended to that conversation's context

**Scenario: `/reset` slash command**
- Given the operator types `/reset` in any thread
- When Slack delivers the slash_command event
- Then the slack-adapter responds with an ephemeral acknowledgement
- And the bound conversation is closed; subsequent messages start a new context

### Outbound messages

**Scenario: Concierge replies in the conversation thread**
- Given the concierge produces a text reply
- When the slack-adapter posts to Slack via `chat.postMessage` with `thread_ts` set to the conversation's thread_ts
- Then the message appears as a thread reply in the operator's DM

**Scenario: Confirmation request**
- Given a tool call requires confirmation
- When the slack-adapter posts the confirm message
- Then the message uses Block Kit with two buttons: ✅ Approve, ❌ Deny
- And the message includes the proposed action's full payload (tool name, args, blast radius reason)
- And the action_id encodes the pending tool_call_id so the response can be routed back

**Scenario: Confirmation response**
- Given the operator taps ✅ or ❌ on a confirm message
- When Slack delivers the interactive block_action event
- Then the slack-adapter looks up the pending tool_call_id and resolves the gate
- And the original message is updated to show "Approved by you" or "Denied by you" with timestamp

### Failure modes

**Scenario: Slack API outage**
- Given Slack's API returns 5xx on `chat.postMessage`
- When the adapter detects the failure
- Then the outbound message is queued in SQLite
- And on Slack recovery → the queue drains in order
- And the operator never sees a partial conversation

**Scenario: Signature verification failure**
- Given a request arrives with an invalid Slack signature
- When the adapter verifies
- Then 401 is returned, no further processing occurs, and the attempt is logged

## Constraints

- **One bot user, one workspace.** The bot is installed only in `softwarecrafting`. No multi-workspace support in v1.
- **Operator scope.** The bot only responds to DMs from the Operator's own user. Messages from any other user (in case the bot is ever invited to a channel) are ignored with a polite ephemeral reply.
- **Bolt-for-JS.** The adapter uses `@slack/bolt` for event handling and `@slack/web-api` for outbound calls. No custom webhook server.
- **Webhook reachability.** Slack's Events API URL is `https://concierge-events.<your-domain>` served via Cloudflare Tunnel (separate route from the board URL).
- **No DM to other users.** The concierge never DMs anyone other than the configured operator. Outbound messages to other channels go through the `slack_send` tool, which always requires confirmation.
- **No app-distributed install.** The bot is installed manually once via Slack admin — no OAuth flow for end-users.

## Success Criterion

1. Operator DMs the bot from phone, sees a reply within 2 s on average.
2. Slash command `/reset` works from any thread.
3. Confirmation taps resolve in <500 ms after Slack delivers the action.
4. Slack outage of <5 min is invisible to the operator (queued + replayed).

## Out of Scope

- Voice notes (deferred — could be added via Whisper transcription).
- Slash commands beyond `/reset` (deferred to per-subsystem design as needed).
- Bot installation flow for other users.
- Channels other than the operator's DM.
```

- [ ] **Step 2: Commit**

```bash
git add .specify/functional/channel-slack.md
git commit -m "spec(L1): FUNC-CHANNEL-SLACK — slack channel"
```

---

### Task 8: Author `FUNC-OBSERVER`

**Files:**
- Create: `.specify/functional/observer.md`

- [ ] **Step 1: Write the spec**

```markdown
---
id: FUNC-OBSERVER
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-OBSERVER — Filesystem & Daemon Observer

## Problem Statement

The concierge must coexist with manual coding sessions (Claude Code, Codex, pi.dev) and with the auto-claude daemon, both of which mutate the local filesystem and the daemon's own state continuously. The concierge needs to know "what is happening on this machine right now?" without becoming a nag, and without requiring the operator to teach it about each new branch or commit. The observer is a write-only event source that emits typed events; classification (surface card / DM / silent) is handled downstream by the event-bus.

## Actors

- **Observer** — the process emitting events.
- **Concierge** — queries the observer on demand via the `obs_*` tool prefix.
- **Event-bus** — receives events and classifies (see `ARCH-EVENT-BUS`).

## Behavior

### Watch scope

**Scenario: Observer starts**
- Given the observer process is launched by launchd
- When it initialises
- Then it reads its watch config from `~/Library/Application Support/concierge/observer.config.json`
- And the config lists: an allow-list of repos to watch (default: just `~/code/auto-claude`), the daemon HTTP endpoint to poll, the polling interval (default 30 s), an ignore-list of paths inside any watched repo (default: `.env`, `secrets/`, `**/*.key`, dotfiles like `.DS_Store`)

**Scenario: Watched repo gains a new worktree**
- Given chokidar observes a new directory created at `<watched-repo>/workspaces/issue-N` or matching the worktree pattern
- When the directory appears
- Then the observer emits an event `{type: "manual_branch_created", repo, path, branch_name, timestamp}` to the event-bus
- And the observer does not warn, comment, or alter the directory

**Scenario: New commit on a watched branch**
- Given a `git commit` lands on any watched branch
- When the post-commit watcher detects the new HEAD
- Then the observer emits `{type: "manual_commit", repo, branch, sha, author, message, timestamp}`
- And the message body is included only if the commit is on a non-daemon branch (anything not under `feature/issue-*` driven by the auto-claude daemon)

**Scenario: Auto-claude daemon status change**
- Given the observer polls `http://127.0.0.1:3847/status` every 30 s
- When the response shows a state diff (new active run, run completed, run stuck, paused, daily cost budget tripped)
- Then the observer emits a typed event with the diff details
- And on poll failure → the observer emits one `{type: "daemon_unreachable"}` event then suppresses further duplicates until reachable again

### Read on demand

**Scenario: Operator asks "what am I in the middle of?"**
- Given the operator's message intent is recognised by the concierge
- When the concierge calls `obs_recent_activity({hours: 24})`
- Then the observer returns a structured summary of all events from the last 24 h, grouped by repo and event type
- And the summary includes counts and most-recent-of-each-type, not raw event list

**Scenario: Operator asks "is the daemon doing anything?"**
- Given the concierge calls `obs_daemon_state()`
- When the observer responds
- Then the latest cached daemon status (active runs, paused state, daily cost so far) is returned
- And the cache is at most 30 s old (one poll interval)

### Privacy / scope rules

**Scenario: File outside allow-list changes**
- Given a file under `~/Documents/` (not on the watch allow-list) changes
- When chokidar would fire
- Then no event is emitted (chokidar simply isn't watching that path)

**Scenario: Ignored file inside watched repo changes**
- Given a `.env` file under a watched repo changes
- When chokidar fires
- Then the event is dropped before being added to the event-bus
- And the operator can verify via `obs_recent_activity` that no .env event was logged (audit transparency)

## Constraints

- **WRITE-ONLY.** The observer never warns, never sends a Slack message of its own, never triggers tool calls, never mutates the filesystem or git state. Its only output is event records via the event-bus.
- **Allow-list only.** No watching paths the operator has not explicitly added. Default is just the auto-claude repo.
- **Ignore-list enforced.** Sensitive patterns (`.env`, `secrets/`, `**/*.key`, dotfiles) are dropped before the event reaches the event-bus.
- **Bounded cache.** The observer holds at most 1000 most-recent events in memory; older events are persisted to SQLite and queried on demand.
- **No Git history mining.** The observer reads HEAD on each watched branch; it does not crawl history beyond what `git log -1` returns.
- **No file content capture.** Events carry metadata (paths, branch names, commit messages, daemon status fields) but never file contents. Tools that need content do their own reads.

## Success Criterion

1. Manual coding sessions never trigger Slack messages or board cards.
2. The operator can ask "what's happening?" and get an accurate answer in <500 ms.
3. `.env` and other ignored paths never appear in the event log.
4. Observer process restart loses at most 30 s of daemon-state polling history.

## Out of Scope

- Watching repos outside the allow-list.
- Long-term filesystem analytics ("how often do I commit on Mondays?").
- Detecting WIP (uncommitted changes); only commits, branches, worktrees are events.
- Watching anything outside `~/code/`.
- Network-level observation (no port-scan, no process listing).
```

- [ ] **Step 2: Commit**

```bash
git add .specify/functional/observer.md
git commit -m "spec(L1): FUNC-OBSERVER — write-only filesystem & daemon observer"
```

---

### Task 9: Author `ARCH-CONCIERGE-RUNTIME`

**Files:**
- Create: `.specify/architecture/concierge-runtime.md`

- [ ] **Step 1: Write the spec**

```markdown
---
id: ARCH-CONCIERGE-RUNTIME
type: architecture
domain: concierge
status: draft
version: 1
layer: 2
references: FUNC-CONCIERGE
---

# ARCH-CONCIERGE-RUNTIME — Concierge Runtime

## Overview

The concierge runtime is a single Node process (`concierge-core`) on the Mac mini that owns the LLM loop, tool router, conversation memory, and Slack adapter. Two sibling processes (`observer`, `board-server`) share the same SQLite file and run under their own launchd plists. This spec defines the runtime's process layout, schema, tool-router contract, and inter-process boundaries.

## Process layout

| Process | Owner |
|---|---|
| `concierge-core` (Node) | LLM loop, tool registry, tool router, slack-adapter (in-process), conversation memory, schema migrations |
| `observer` (Node) | filesystem & daemon polling, event emission to event-bus |
| `board-server` (Hono) | reads `cards`/`messages`/`tool_calls`; serves HTMX UI; SSE fan-out |
| `cloudflared` | tunnel for Slack webhook + board URL |
| (existing) `com.autoclaude.daemon` | unchanged, polled by observer |

## Storage

Single SQLite file at `~/Library/Application Support/concierge/state.db`, opened in WAL mode by all three processes.

### Tables and write boundaries

| Table | Writer | Readers |
|---|---|---|
| `conversations` | concierge-core | concierge-core, board-server |
| `messages` | concierge-core | concierge-core, board-server |
| `tool_calls` | concierge-core | concierge-core, board-server |
| `events` | observer | concierge-core (event-bus consumer), board-server |
| `cards` | concierge-core | concierge-core, board-server |
| `schema_migrations` | concierge-core | concierge-core |

`board-server` is read-only on every table except cards: it writes a card-action result by calling concierge-core's tool router via local HTTP (not by direct SQLite update).

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

In-process. Uses `@slack/bolt`. Verifies signing secret on every event. Normalises events into `{conversation_id?, thread_ts, user, text, type}`. Outbound messages pass through `chat.postMessage`. Block Kit confirm messages encode the `tool_call_id` in `action_id`.

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
  "watchedRepos": ["~/code/auto-claude"],
  "operatorEmail": "operator@example.com"
}
```

## launchd

`com.concierge.core`, `com.concierge.observer`, `com.concierge.board` plists. All three: `RunAtLoad: true`, `KeepAlive: true`, `WorkingDirectory: ~/code/auto-claude`, env loaded from `~/Library/Application Support/concierge/env`.

## Cloudflare Tunnel

Two routes from a single tunnel:
- `concierge-events.<your-domain>` → `localhost:3848` (slack-adapter webhook)
- `board.<your-domain>` → `localhost:3849` (board-server)

Cloudflare Access policy: Google SSO restricted to `operator@example.com`, applied to both routes (the Slack webhook route uses Cloudflare Access service tokens; the board route uses interactive SSO).

## Failure modes

- **SQLite contention** — handled by WAL mode + retry on busy timeout (50 ms backoff, 5 retries).
- **Tool handler throws** — router returns `{error}` to LLM; no retry loop.
- **LLM API outage** — concierge-core retries with exponential backoff (3 attempts); on full failure, posts a one-line "I'm offline, retry in 5 min" reply.
- **Slack API outage** — outbound queue in SQLite drains on recovery.
- **Cloudflare Tunnel down** — Slack webhook fails (Slack auto-retries up to 3x, then drops); the operator sees missed messages on tunnel reconnect via Slack's own thread.

## Boundaries

- This spec defines runtime + schema + router contract. It does NOT define event classification rules (see `ARCH-EVENT-BUS`), confirmation flow details (see `ARCH-CONFIRMATION-LIFECYCLE`), or tool-registry persistence shape (see `ARCH-TOOL-REGISTRY`).
```

- [ ] **Step 2: Commit**

```bash
git add .specify/architecture/concierge-runtime.md
git commit -m "spec(L2): ARCH-CONCIERGE-RUNTIME — process layout & schema"
```

---

### Task 10: Author `ARCH-EVENT-BUS`

**Files:**
- Create: `.specify/architecture/event-bus.md`

- [ ] **Step 1: Write the spec**

```markdown
---
id: ARCH-EVENT-BUS
type: architecture
domain: concierge
status: draft
version: 1
layer: 2
references: FUNC-OBSERVER
---

# ARCH-EVENT-BUS — Event Bus

## Overview

The event-bus is a thin SQLite-backed in-process queue that decouples the observer's event emission from the concierge's classification + reaction logic. Events flow: observer (writer) → `events` table → classifier (rule-based; deterministic) → outcome (`surface_card`, `slack_dm`, `silent_log`). The board-server tails the same table via SSE for real-time card updates.

## Schema

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                    -- e.g. "daemon_stuck", "manual_commit"
  source TEXT NOT NULL,                  -- "observer", "concierge", "auto-claude"
  payload TEXT NOT NULL,                 -- JSON
  classified_outcome TEXT,               -- NULL until classified; then surface_card|slack_dm|silent_log
  created_at INTEGER NOT NULL,           -- unix ms
  classified_at INTEGER,                 -- unix ms; NULL if pending
  acknowledged_at INTEGER                -- unix ms; NULL if not acknowledged (matters for re-surfacing prevention)
);

CREATE INDEX idx_events_pending ON events (classified_at) WHERE classified_at IS NULL;
CREATE INDEX idx_events_type ON events (type, created_at);
```

## Classification rules

Deterministic, rule-based. Implemented as TypeScript code in `packages/concierge/src/event-bus/classifier.ts`. NOT an LLM call. Rules can be added/changed over time as the operator marks events as noise.

| Event type | Outcome | Reason |
|---|---|---|
| `daemon_stuck` | `surface_card` + `slack_dm` | needs operator decision |
| `daemon_run_completed` (success) | `silent_log` | autonomous success; nightly summary suffices |
| `daemon_run_completed` (with concerns) | `surface_card` | needs review |
| `daemon_unreachable` (first occurrence) | `slack_dm` | one-time alert |
| `daemon_unreachable` (subsequent) | `silent_log` | already alerted |
| `daemon_paused` | `slack_dm` | confirms manual pause |
| `daily_cost_threshold_crossed` | `slack_dm` | budget visibility |
| `manual_branch_created` | `silent_log` | manual session noise |
| `manual_commit` (on daemon-driven branch) | `silent_log` | daemon driving |
| `manual_commit` (on operator-driven branch) | `silent_log` | operator awareness, queryable on demand |
| `pr_opened` (by daemon) | `silent_log` | autonomous |
| `pr_opened` (manual) | `silent_log` | observable on demand |
| `slack_message_sent_to_external_channel` | `silent_log` | already audited |
| `confirmation_expired` | `slack_dm` | reminder |
| (unknown type) | `silent_log` | fail-closed: do not surface noise |

The classifier is pure: same event → same outcome. Re-classification is forbidden after the row is updated.

## SSE fan-out

`board-server` opens a long-lived SQLite hook that polls `events` and `cards` for new rows since the last seen id. New rows fan out to all connected SSE clients. Polling interval: 250 ms (good enough for human-perceptible "live"; cheap on local SQLite).

## Retention

`events` rows are kept indefinitely; the table is small (an event is ~200 B, even at 1000 events/day = 70 MB/year). The consolidator job summarises events older than 7 days into the daily summary; raw rows stay for audit.

## Boundaries

- Classification is deterministic. The "classifier could be an LLM" idea is **out of scope** for v1; revisit only if rule explosion exceeds 50 cases.
- The event-bus does not implement retries, dead-letter queues, or partition keys. It is a single-writer-multi-reader SQLite queue.
- The bus does not do cross-process pubsub. Other processes see events via SQLite read-after-write within ~250 ms.

## Failure modes

- **Observer writes a malformed event** — classifier throws, outcome is `errored`, board surfaces a ⚠️ card with the raw payload for operator inspection.
- **Classifier rule has a bug** — the buggy outcome is logged; the operator can manually mark the card / event acknowledged. The buggy rule is fixed in code.
```

- [ ] **Step 2: Commit**

```bash
git add .specify/architecture/event-bus.md
git commit -m "spec(L2): ARCH-EVENT-BUS — sqlite-backed event queue + classifier"
```

---

### Task 11: Author `ARCH-TOOL-REGISTRY`

**Files:**
- Create: `.specify/architecture/tool-registry.md`

- [ ] **Step 1: Write the spec**

```markdown
---
id: ARCH-TOOL-REGISTRY
type: architecture
domain: concierge
status: draft
version: 1
layer: 2
references: FUNC-CONCIERGE
---

# ARCH-TOOL-REGISTRY — Tool Registry

## Overview

The tool registry is the canonical list of tools the concierge LLM may call. It serves three audiences: (1) the LLM, which receives a JSON-schema-shaped tool definition for each entry; (2) the tool router, which dispatches `tool_use` calls to the registered handler; (3) the operator, who reads the registry to audit "what can the bot actually do?". Every tool — including those wrapping subsystems whose full L1 specs are deferred — must have a registry entry before the LLM can call it.

## Registry shape

```typescript
type BlastRadius = 'safe' | 'medium' | 'high';

interface ToolEntry {
  name: string;                          // unique; namespaced (ac_, sb_, gh_, cal_, ...)
  description: string;                    // shown to LLM; ≤200 chars
  argsSchema: JSONSchema;                 // strict; reject additionalProperties
  handler: (args: unknown) => Promise<unknown>;
  blastRadius: BlastRadius;
  audit: 'always' | 'on_error_only';
  cacheable: boolean;                     // identity over args within 60 s
  subsystem: string;                      // e.g. 'auto-claude', 'knowledge-vault'
  governingSpecId: string | null;         // L1 spec governing the subsystem; null until spec authored
  status: 'enabled' | 'disabled' | 'experimental';
}
```

## Initial entries (Phase 0 placeholder set)

These minimal entries live in `packages/concierge/src/tools/registry.ts` (TBD in Phase 1+; documented here for reference). Phase 0 only spec authorship; no code yet.

| Name | Subsystem | Blast | Confirm? | Notes |
|---|---|---|---|---|
| `ac_run` | auto-claude | medium | no | `{issue: number}` → `{run_id: string}` |
| `ac_status` | auto-claude | safe | no | `{}` → daemon status snapshot |
| `ac_pause` | auto-claude | medium | no | pause daemon |
| `ac_unstuck` | auto-claude | medium | no | `{issue: number}` |
| `ac_merge_to_main` | auto-claude | high | yes | always confirm |
| `sb_read` | knowledge-vault | safe | no | `{path: string}` |
| `sb_search` | knowledge-vault | safe | no | `{query: string}` |
| `sb_append_inbox` | knowledge-vault | medium | no | `{slug, body}` → 00-inbox/ |
| `sb_write_decision` | knowledge-vault | medium | no | project notes only |
| `sb_write_client` | knowledge-vault | high | yes | always confirm (20-Areas/clients/) |
| `gh_search` | gh | safe | no | read-only query |
| `gh_comment` | gh | medium | no | non-issue comments below |
| `cal_read` | calendar | safe | no | read events |
| `mail_draft` | email | medium | no | draft only |
| `mail_send` | email | high | yes | always confirm |
| `slack_send_dm` | slack | safe | no | to operator only |
| `slack_send_channel` | slack | high | yes | always confirm |
| `web_fetch` | web | safe | no | URL → text |
| `obs_recent_activity` | observer | safe | no | last N hours |
| `obs_daemon_state` | observer | safe | no | cached daemon status |

The registry is the source of truth. The tool definitions exposed to the LLM are derived from this table; the `name` and `description` are sent verbatim, the args schema is rendered to JSON Schema for the Anthropic API.

## Versioning

When a tool's argsSchema changes incompatibly, the entry's `name` is bumped (e.g. `ac_run` → `ac_run_v2`). The old name remains as `disabled` long enough that any in-flight tool_use from a stale LLM context still resolves to a deprecation message.

## Operator audit

The operator can list all tools via the slash command `/tools` in Slack — the slack-adapter renders the registry as a Block Kit message grouped by subsystem and blast radius.

## Boundaries

- This spec defines REGISTRY SHAPE, not subsystem behaviour. Each subsystem's behaviour lives in its own L1 (existing `FUNC-AC-*` for auto-claude; deferred for others until non-trivial behaviour emerges).
- Confirmation flow (how confirm messages are rendered, how taps are routed) lives in `ARCH-CONFIRMATION-LIFECYCLE`.
- Skill files (Hermes-style distilled trajectories) are NOT tools in this registry. They are scripts the LLM calls via a special `run_skill` tool; the registry has one entry for `run_skill` that takes a skill-id arg.

## Failure modes

- **Tool name collision on registration** — startup throws; concierge-core refuses to start.
- **argsSchema validation failure** — router returns `{error: "invalid args"}` to the LLM; no handler is invoked.
- **Handler runtime exception** — router returns `{error}`; LLM sees the error verbatim.
```

- [ ] **Step 2: Commit**

```bash
git add .specify/architecture/tool-registry.md
git commit -m "spec(L2): ARCH-TOOL-REGISTRY — tool registration, schemas, blast radius"
```

---

### Task 12: Author `ARCH-CONFIRMATION-LIFECYCLE`

**Files:**
- Create: `.specify/architecture/confirmation-lifecycle.md`

- [ ] **Step 1: Write the spec**

```markdown
---
id: ARCH-CONFIRMATION-LIFECYCLE
type: architecture
domain: concierge
status: draft
version: 1
layer: 2
references: FUNC-CONCIERGE
---

# ARCH-CONFIRMATION-LIFECYCLE — Confirmation Lifecycle

## Overview

A first-class cross-cutting concept. Any tool call with `blastRadius: 'high'` (or any tool with `requires_confirmation: true` for non-blast-radius reasons) follows this lifecycle. Confirmation is NOT a tool-router-internal flag — it's a multi-step state machine with its own table, a Slack message, optional board surface, expiry, and audit log.

## State machine

```
                ┌─────────────────────────────────────────────────┐
                │                                                  │
LLM tool_use ──► tool_router intercepts ──► PENDING ──► confirm Slack message posted
                                              │
                          ┌───────────────────┼─────────────────────────┐
                          │                   │                         │
                       APPROVED            DENIED                    EXPIRED (24h)
                          │                   │                         │
                          ▼                   ▼                         ▼
                       handler              tool_use returns          tool_use returns
                       executes             {error: denied}           {error: expired}
                          │
                       SUCCESS or ERRORED
```

## Schema

```sql
CREATE TABLE confirmations (
  id TEXT PRIMARY KEY,                   -- ulid
  tool_call_id TEXT NOT NULL,            -- references tool_calls.id (the pending row)
  conversation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,                    -- JSON
  blast_reason TEXT NOT NULL,            -- "external email", "merge to main", etc.
  status TEXT NOT NULL,                  -- pending|approved|denied|expired|errored
  slack_message_ts TEXT,                 -- the Block Kit message posted; null if not yet sent
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  expires_at INTEGER NOT NULL            -- created_at + 24h
);

CREATE INDEX idx_confirmations_pending ON confirmations (status, expires_at) WHERE status = 'pending';
```

## Slack message shape

A Block Kit message in the operator's DM thread with:
- A header: "Confirm: <tool_name>"
- A section listing the args (formatted for human readability)
- A "Why this needs confirmation" line (`blast_reason`)
- Two buttons: ✅ Approve (`action_id: confirm:<conf_id>:approve`) and ❌ Deny (`action_id: confirm:<conf_id>:deny`)
- A footer with the expiry time

When the operator taps:
- Slack posts a `block_actions` event to the slack-adapter
- The adapter parses the action_id, looks up the confirmation, and sets status accordingly
- The original message is updated: header changes to "Approved by you" / "Denied by you" with timestamp; buttons removed
- The pending tool call is resumed (handler runs on approve; error returned on deny)

## Expiry

A periodic job in `concierge-core` (every 60 s) scans `confirmations WHERE status = 'pending' AND expires_at < now()`. For each, status flips to `expired`, the Slack message is updated to "Expired (no response)", the pending tool call is resumed with `{error: "confirmation timed out"}`, and the LLM sees the error.

## Audit

Every confirmation lifecycle transition writes to `tool_calls`:
- creation: `tool_calls` row with `status: pending_confirmation`
- approval: row updated to `status: confirmed; responded_at = now`
- denial: row updated to `status: denied; responded_at = now`
- expiry: row updated to `status: expired; responded_at = now`

The audit row carries the slack_message_ts for traceability.

## Board interaction

If the same logical action also surfaces a board card (e.g. an "approve auto-claude L1 spec" card), the card and the confirmation share the same `confirmation_id`. Tapping the card's Approve button and the Slack confirm button are equivalent — both resolve the same confirmation. Only one client wins; the other is shown "already approved by you (other surface)".

## Constraints

- **24-hour expiry hard-coded.** Per-tool overrides may be added later but v1 is uniform.
- **No re-confirmation.** Once denied or expired, the LLM must initiate a new tool_use to retry (with the operator's input).
- **Idempotent.** Multiple `block_actions` events for the same confirmation are ignored after the first response.
- **No silent fallthrough.** A pending confirmation cannot be bypassed by another tool call. The LLM is told "you have N pending confirmations" until they resolve, and may reason about the work without firing more high-blast tools.

## Failure modes

- **Slack signature failure** on the response — drop the event, log, no state change.
- **Confirmation row missing for action_id** — respond ephemerally to operator: "this confirmation expired or was already resolved"; no state change.
- **Crash during handler execution after approval** — the tool_call row remains in `confirmed` but no `result`; on restart, concierge-core surfaces a needs-you card "previously confirmed action did not complete: <tool_name>; retry?"
```

- [ ] **Step 2: Commit**

```bash
git add .specify/architecture/confirmation-lifecycle.md
git commit -m "spec(L2): ARCH-CONFIRMATION-LIFECYCLE — confirmation state machine"
```

---

### Task 13: Author `STACK-CONCIERGE-NODE`

**Files:**
- Create: `.specify/stack/concierge-node-ts.md`

- [ ] **Step 1: Write the spec**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add .specify/stack/concierge-node-ts.md
git commit -m "spec(L3): STACK-CONCIERGE-NODE — node 22 + TS implementation contract"
```

---

### Task 14: Author `STACK-CONCIERGE-BOARD`

**Files:**
- Create: `.specify/stack/concierge-board-ts.md`

- [ ] **Step 1: Write the spec**

```markdown
---
id: STACK-CONCIERGE-BOARD
type: stack-specific
domain: concierge
status: draft
version: 1
layer: 3
stack: typescript
references: FUNC-CONCIERGE-BOARD
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
```

- [ ] **Step 2: Commit**

```bash
git add .specify/stack/concierge-board-ts.md
git commit -m "spec(L3): STACK-CONCIERGE-BOARD — htmx + hono frontend contract"
```

---

### Task 15: Update `traceability.yml`

**Files:**
- Modify: `.specify/traceability.yml`

- [ ] **Step 1: Write the failing test**

Append to `packages/daemon/src/infra/traceability-paths.test.ts` a new block:

```typescript
describe('concierge spec tree', () => {
  it('L0-CONCIERGE-VISION exists with five L1 children', () => {
    const raw = readFileSync(resolve(ROOT, '.specify/traceability.yml'), 'utf-8');
    expect(raw).toContain('L0-CONCIERGE-VISION:');
    expect(raw).toMatch(/L0-CONCIERGE-VISION:[\s\S]*?children:\s*\[FUNC-CONCIERGE.*FUNC-OBSERVER\]/);
  });

  it('all new concierge specs have entries', () => {
    const raw = readFileSync(resolve(ROOT, '.specify/traceability.yml'), 'utf-8');
    for (const id of [
      'FUNC-CONCIERGE', 'FUNC-CONCIERGE-MEMORY', 'FUNC-CONCIERGE-BOARD',
      'FUNC-CHANNEL-SLACK', 'FUNC-OBSERVER',
      'ARCH-CONCIERGE-RUNTIME', 'ARCH-EVENT-BUS', 'ARCH-TOOL-REGISTRY',
      'ARCH-CONFIRMATION-LIFECYCLE',
      'STACK-CONCIERGE-NODE', 'STACK-CONCIERGE-BOARD',
    ]) {
      expect(raw, `expected ${id} in traceability`).toContain(`${id}:`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @auto-claude/daemon exec vitest run src/infra/traceability-paths.test.ts -t "concierge spec tree"
```

Expected: FAIL — entries do not exist yet.

- [ ] **Step 3: Append concierge entries to `.specify/traceability.yml`**

Add after the existing AC subtree (after `STACK-AC-CONVENTIONS:` block, near end of AC section):

```yaml
# --- Concierge L0 spec (vision — root of all concierge specs) ---
# Note: relationship to L0-AC-VISION is expressed in prose inside the
# L0-CONCIERGE-VISION document. NO parent: field is set on L0-AC-VISION.

L0-CONCIERGE-VISION:
  children: [FUNC-CONCIERGE, FUNC-CONCIERGE-MEMORY, FUNC-CONCIERGE-BOARD, FUNC-CHANNEL-SLACK, FUNC-OBSERVER]
  status: draft

# --- Concierge L1 specs ---

FUNC-CONCIERGE:
  children: [ARCH-CONCIERGE-RUNTIME, ARCH-TOOL-REGISTRY, ARCH-CONFIRMATION-LIFECYCLE]
  status: draft

FUNC-CONCIERGE-MEMORY:
  children: [ARCH-CONCIERGE-RUNTIME]
  status: draft

FUNC-CONCIERGE-BOARD:
  children: [ARCH-CONCIERGE-RUNTIME, ARCH-EVENT-BUS, STACK-CONCIERGE-BOARD]
  related: [FUNC-AC-DASHBOARD]   # boundary documented in concierge-board.md spec
  status: draft

FUNC-CHANNEL-SLACK:
  children: [STACK-CONCIERGE-NODE]
  status: draft

FUNC-OBSERVER:
  children: [ARCH-EVENT-BUS]
  status: draft

# --- Concierge L2 specs ---

ARCH-CONCIERGE-RUNTIME:
  parent: FUNC-CONCIERGE
  children: [STACK-CONCIERGE-NODE]
  status: draft

ARCH-EVENT-BUS:
  parent: FUNC-OBSERVER
  children: [STACK-CONCIERGE-NODE]
  status: draft

ARCH-TOOL-REGISTRY:
  parent: FUNC-CONCIERGE
  children: [STACK-CONCIERGE-NODE]
  status: draft

ARCH-CONFIRMATION-LIFECYCLE:
  parent: FUNC-CONCIERGE
  children: [STACK-CONCIERGE-NODE]
  status: draft

# --- Concierge L3 specs ---

STACK-CONCIERGE-NODE:
  parent: ARCH-CONCIERGE-RUNTIME
  children: []
  code_paths:
    - packages/concierge/
  test_paths:
    - packages/concierge/**/*.test.ts
  status: draft

STACK-CONCIERGE-BOARD:
  parent: FUNC-CONCIERGE-BOARD
  children: []
  code_paths:
    - packages/concierge/src/board/
  test_paths:
    - packages/concierge/src/board/**/*.test.ts
  status: draft
```

- [ ] **Step 4: Run the traceability path validation test**

```bash
pnpm --filter @auto-claude/daemon exec vitest run src/infra/traceability-paths.test.ts
```

Expected: the existing path-validation test will fail — `packages/concierge/` and `packages/concierge/src/board/` do not yet exist on disk. **This is intentional**; we want the daemon's spec-implementation phase to create those paths in Phase 1+. Mark the new entries' code_paths and test_paths as expected-missing in the test by extending the validator to skip paths under `packages/concierge/` until that package exists.

Add to the validator skip list at top of `traceability-paths.test.ts`:

```typescript
const SKIP_UNTIL_IMPLEMENTED = new Set<string>([
  'packages/concierge/',
  'packages/concierge/src/board/',
]);
```

And in the loop:

```typescript
if (SKIP_UNTIL_IMPLEMENTED.has(path)) continue;
```

- [ ] **Step 5: Run all tests**

```bash
pnpm --filter @auto-claude/daemon exec vitest run src/infra/traceability-paths.test.ts
```

Expected: PASS — concierge entries exist; missing-paths skipped.

- [ ] **Step 6: Commit**

```bash
git add .specify/traceability.yml packages/daemon/src/infra/traceability-paths.test.ts
git commit -m "spec(traceability): add concierge subtree

Adds L0-CONCIERGE-VISION + 5 L1 + 4 L2 + 2 L3 entries. AC subtree
unchanged. No L0-to-L0 parent: field per Codex review. Adds skip-list
to traceability-paths test for packages/concierge/ paths that the
daemon will materialise in Phase 1+."
```

---

### Task 16: Update `signal-analyzer.test.ts` fixture for L0-agnostic tree walks

**Why:** The fixture hardcodes `L0-AC-VISION:` literal. Need an additional fixture exercising `L0-CONCIERGE-VISION` to prove the resolver works for both trees.

**Files:**
- Modify: `packages/daemon/src/coordination/product-owner/signal-analyzer.test.ts:94`

- [ ] **Step 1: Read current fixture**

```bash
sed -n '85,110p' packages/daemon/src/coordination/product-owner/signal-analyzer.test.ts
```

- [ ] **Step 2: Add a second test case after the existing L0-AC-VISION fixture**

The existing test asserts behaviour under L0-AC-VISION. Duplicate the test, swap the literal to `L0-CONCIERGE-VISION` with appropriate children, and assert identical resolution behaviour. This proves the resolver is L0-agnostic.

(Exact code depends on the existing test shape; the added case should mirror it 1:1 with only the L0 id and child list changed.)

- [ ] **Step 3: Run**

```bash
pnpm --filter @auto-claude/daemon exec vitest run src/coordination/product-owner/signal-analyzer.test.ts
```

Expected: both cases pass.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/coordination/product-owner/signal-analyzer.test.ts
git commit -m "test(signal-analyzer): cover both L0 trees in resolver fixture"
```

---

### Task 17: Update `integration.ts` comment for clarity

**Files:**
- Modify: `packages/daemon/src/control-plane/integration.ts:73`

- [ ] **Step 1: Read context**

```bash
sed -n '70,80p' packages/daemon/src/control-plane/integration.ts
```

- [ ] **Step 2: Update the comment**

Replace:
```
// visible to the Operator without manual intervention. Per L0-AC-VISION
```
with:
```
// visible to the Operator without manual intervention. Per L0-AC-VISION
// (the auto-claude subsystem L0; product-level vision lives at L0-CONCIERGE-VISION)
```

- [ ] **Step 3: Verify file compiles**

```bash
pnpm --filter @auto-claude/daemon exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/control-plane/integration.ts
git commit -m "comment(integration): clarify L0-AC-VISION scope post-pivot"
```

---

### Task 18: Update prompts to be L0-agnostic

**Files:**
- Modify: `prompts/l2-designer.md:7`
- Modify: `prompts/l3-generator.md:7`
- Modify: `prompts/spec-implementer.md:7`

- [ ] **Step 1: Read current prompts**

```bash
grep -n "L0-vision\|L0-AC-VISION" prompts/l2-designer.md prompts/l3-generator.md prompts/spec-implementer.md
```

- [ ] **Step 2: For each prompt, replace generic L0 references with multi-L0 instruction**

In each file, replace:
```
L0-vision.md
```
with:
```
the relevant L0 (L0-CONCIERGE-VISION at .specify/L0-vision.md or L0-AC-VISION at .specify/L0-ac-vision.md, whichever the L1 spec falls under per traceability.yml)
```

Specifically `prompts/l2-designer.md:7`:
```
1. **Read the spec chain.** L1 spec → the relevant L0 (`.specify/L0-vision.md` for concierge, `.specify/L0-ac-vision.md` for auto-claude) → existing L2 specs (for patterns) → AGENTS.md rules.
```

Same pattern for `prompts/l3-generator.md:7` and `prompts/spec-implementer.md:7`.

- [ ] **Step 3: Commit**

```bash
git add prompts/l2-designer.md prompts/l3-generator.md prompts/spec-implementer.md
git commit -m "prompts(L2/L3/impl): teach generators about multi-L0"
```

---

### Task 19: Update `spec-guardian` skill to teach concierge L1 patterns

**Files:**
- Modify: `plugins/auto-claude-dev/skills/spec-guardian.md` (or wherever the skill lives — verify path)

- [ ] **Step 1: Locate the spec-guardian skill**

```bash
find . -name "spec-guardian.md" -path "*/skills/*"
find . -name "l1-spec-guardian*" -o -name "l2-spec-guardian*" -o -name "l3-spec-guardian*"
```

- [ ] **Step 2: For each guardian skill, update example sections to include both AC and concierge L1 patterns**

Add a brief note: "L1 specs may be subsystem-scoped (`FUNC-AC-*`) or product-scoped (`FUNC-CONCIERGE`, `FUNC-CONCIERGE-*`, `FUNC-CHANNEL-*`, `FUNC-OBSERVER`). The L0 a spec falls under is determined by which L0 lists it as a child in traceability.yml."

- [ ] **Step 3: Commit**

```bash
git add plugins/auto-claude-dev/skills/  # or correct path
git commit -m "skills(spec-guardian): teach multi-L0 (AC vs concierge)"
```

---

### Task 20: Update dashboard scaffold-templates to teach about multi-L0

**Files:**
- Modify: `packages/dashboard/lib/scaffold-templates.ts`
- Modify: `packages/dashboard/actions/new-project.ts:75`

- [ ] **Step 1: Read current scaffold templates**

```bash
grep -n "L0-vision" packages/dashboard/lib/scaffold-templates.ts packages/dashboard/actions/new-project.ts
```

- [ ] **Step 2: Decide on policy**

The dashboard scaffolds *new projects* — these are by definition new auto-claude-style spec-driven repos. They should still scaffold a single `L0-vision.md`. **No change to scaffold templates.** The only update is a comment clarifying that the scaffold creates an L0-AC-VISION-style L0 by default; new product-level L0s (like concierge) are special-cased one-offs that the dashboard does not need to handle.

Add a one-line comment above the scaffold call:

```typescript
// Scaffolds a single .specify/L0-vision.md with id L0-AC-VISION.
// New top-level L0s (like L0-CONCIERGE-VISION in this very repo) are
// authored by hand once per product and not via the dashboard.
```

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/lib/scaffold-templates.ts packages/dashboard/actions/new-project.ts
git commit -m "docs(scaffold): note that scaffolder creates AC-style L0 only"
```

---

### Task 21: Mark `~/code/knowledge-vault-slack-bot` as deprecated-by-concierge

**Why:** That Python daemon currently does Slack↔Obsidian capture/briefing/agent-routing. The concierge subsumes it in Phase 1+. Add a deprecation note so a future operator (or the operator themselves in 6 months) sees the migration path.

**Files:**
- Modify: `~/code/knowledge-vault-slack-bot/README.md` (NOT in this repo)

- [ ] **Step 1: Append a deprecation note to that repo's README**

```bash
cd ~/code/knowledge-vault-slack-bot
```

Add to top of README (after the title, before any other content):

```markdown
> ⚠️ **Deprecation in progress (2026-05-01).** This daemon's
> responsibilities (Slack capture, daily briefing, agent routing) are
> being absorbed by the concierge in `~/code/auto-claude/packages/concierge/`
> per the design at `~/code/auto-claude/docs/superpowers/specs/2026-05-01-concierge-design.md`.
> This daemon will keep running until the concierge reaches feature
> parity (target: Phase 5 of that plan); then it is retired. Do not
> add new features here — open issues against `~/code/auto-claude` instead.
```

- [ ] **Step 2: Commit in that repo**

```bash
cd ~/code/knowledge-vault-slack-bot
git add README.md
git commit -m "docs: mark deprecated; concierge subsumes responsibilities

See ~/code/auto-claude/docs/superpowers/specs/2026-05-01-concierge-design.md"
```

(Cross-repo commit — not in auto-claude history. Just a heads-up.)

---

### Task 22: Run all daemon tests; ensure Phase 0 produces a green tree

**Files:** none (test execution only)

- [ ] **Step 1: Full daemon test suite**

```bash
pnpm --filter @auto-claude/daemon test
```

Expected: PASS.

- [ ] **Step 2: Full repo typecheck**

```bash
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 3: Full repo lint**

```bash
pnpm -r run lint || true
```

Note any lint warnings introduced by Phase 0; address inline.

- [ ] **Step 4: traceability validation**

The new test added in Task 15 asserts concierge entries exist. Run it again:

```bash
pnpm --filter @auto-claude/daemon exec vitest run src/infra/traceability-paths.test.ts
```

Expected: PASS.

- [ ] **Step 5: If any test fails, fix in place; do not skip**

The plan does not introduce code under `packages/concierge/` so failures must be in the spec-loader, traceability validator, or fixture updates. Address them.

---

### Task 23: Push branch and open daemon-feedable GitHub issues

**Why:** Per the plan goal, after Phase 0 the daemon should be able to pick up the concierge specs and self-implement. The daemon scans GitHub issues with specific labels. To trigger Phase 1 implementation, we open issues — one per L1 spec — with `l1-approved`, `l2-approved`, `l3-approved` labels so the daemon's spec-pipeline skips generation phases (since we already authored L2 and L3) and goes directly to spec-implementation.

**Files:** none (GitHub operations)

- [ ] **Step 1: Push the branch**

The plan is being executed on `chore/concierge-phase-0` (or whatever branch the implementer chose). Push:

```bash
git push -u origin <branch-name>
```

- [ ] **Step 2: Open one issue per implementable concierge L1 spec**

For each of the five new L1 specs, open a GitHub issue using `gh`:

```bash
gh issue create \
  --title "Implement FUNC-CHANNEL-SLACK (concierge subsystem: Slack adapter)" \
  --body "$(cat <<'EOF'
Implements `.specify/functional/channel-slack.md`.

L2: `.specify/architecture/concierge-runtime.md` (already authored, l2-approved)
L3: `.specify/stack/concierge-node-ts.md` (already authored, l3-approved)
code_paths: `packages/concierge/src/slack/`

The daemon's spec-pipeline should skip l2-generate and l3-generate phases
(specs are pre-authored and labelled approved). Pick this up via the
spec-implementation phase.

Reference: docs/superpowers/specs/2026-05-01-concierge-design.md

Phase 1 of the concierge rollout.
EOF
)" \
  --label "spec-implementation,l1-approved,l2-approved,l3-approved" \
  --label "concierge,phase-1"
```

Repeat for `FUNC-CONCIERGE`, `FUNC-CONCIERGE-MEMORY`, `FUNC-OBSERVER`, `FUNC-CONCIERGE-BOARD`. (Each becomes its own issue; the daemon picks them up one at a time and runs spec-implementation, materialising `packages/concierge/src/<subdir>/`.)

**Note on dependencies:** the daemon's batch classifier should detect that these issues all touch new code under `packages/concierge/` and may serialise them. That's acceptable — Phase 1 is sequential by design (per design doc Phase 1: "real bot, zero capability" first; Phase 2 adds tools). The implementer should manually serialise by opening only the FUNC-CONCIERGE issue first, waiting for it to merge, then opening the others.

- [ ] **Step 3: Verify daemon picks up the first issue**

Watch the daemon log:

```bash
tail -f ~/Library/Logs/auto-claude/daemon.log | grep -E "(FUNC-CONCIERGE|concierge|spec-impl)"
```

Expected: within one poll cycle, the daemon classifies the issue and starts a spec-implementation worker for it.

- [ ] **Step 4: If daemon does NOT pick up the issue, diagnose**

Likely causes:
- spec-loader changes not deployed to daemon (require daemon restart)
- New L1 not in traceability.yml's resolved tree from issue body's spec id
- Daemon's classifier rejects the issue type (open issue manually flagged for spec-impl)

Address whichever applies; the plan should not declare Phase 0 done until the daemon successfully picks up at least one concierge issue.

---

### Task 24: Open PR against `dev` for review

**Files:** none (GitHub operations)

- [ ] **Step 1: Open the PR**

```bash
gh pr create --base dev --title "Concierge Phase 0 — spec ladder + integration" --body "$(cat <<'EOF'
## Summary

- Authors L0-CONCIERGE-VISION (rewritten in `L0-vision.md`) and 5 new L1 + 4 new L2 + 2 new L3 specs for the concierge pivot.
- Adds multi-L0 root scanning to `spec-loader.ts` (~50 LOC + 3 tests).
- Updates traceability.yml with concierge subtree (additive — AC subtree unchanged).
- Updates prompts (l2-designer, l3-generator, spec-implementer), spec-guardian skills, and the integration.ts comment to be L0-agnostic.
- Marks `~/code/knowledge-vault-slack-bot` as deprecated-by-concierge in its README.

Per Codex pair-review, the L0-AC-VISION subtree is **unchanged**. Concierge tree is purely additive. Relationship between the two L0s is expressed in prose; no `parent:` field linking them.

After this PR merges, opens 5 GitHub issues with `l1-approved,l2-approved,l3-approved` labels so the daemon picks up Phase 1 implementation autonomously.

## Test plan

- [x] `pnpm --filter @auto-claude/daemon test` green
- [x] `pnpm -r typecheck` green
- [x] `traceability-paths.test.ts` validates concierge subtree
- [x] `spec-loader.test.ts` exercises multi-L0 scanning
- [x] Hand-validated: `git log .specify/` shows additive changes only (no edits to existing FUNC-AC-* files)

## Reviewer focus

1. L0-CONCIERGE-VISION narrative — operator role, success criterion, boundaries.
2. Tool-registry blast-radius assignments — does the always-confirm list match your intent?
3. The board boundary vs. FUNC-AC-DASHBOARD.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Verify PR opens cleanly**

```bash
gh pr view --json url,state,mergeable
```

Expected: state OPEN, mergeable MERGEABLE.

---

## Critical path summary

```
Task 1 (spec-loader) ──► Task 2 (extract L0) ──► Task 3 (rewrite L0)
                                                       │
                              ┌────────────────────────┴────────────────────────┐
                              ▼                                                  ▼
                  Tasks 4–8 (L1 specs, parallel)                Tasks 9–12 (L2 specs, parallel)
                              │                                                  │
                              └────────────────────┬─────────────────────────────┘
                                                   ▼
                                  Tasks 13–14 (L3 specs, parallel)
                                                   ▼
                                           Task 15 (traceability)
                                                   ▼
                          Tasks 16–20 (integration gaps, parallel)
                                                   ▼
                                           Task 21 (deprecation note)
                                                   ▼
                                          Task 22 (test green)
                                                   ▼
                                  Tasks 23–24 (push, issues, PR)
```

Tasks 4–8 and 9–12 can be parallel within each group via subagent dispatch (each task touches a different file). Tasks 16–20 are independent of each other.

## Effort estimate

- Tasks 1, 15, 22: ~1 h each (test-driven; small).
- Tasks 2, 3, 4, 5, 6, 7, 8: ~1 h each authorship + 15 m review.
- Tasks 9, 10, 11, 12, 13, 14: ~1.5 h each (denser content).
- Tasks 16–21: ~30 m each.
- Tasks 23, 24: ~30 m together.

**Total Phase 0:** ~16 h focused work. With subagent-driven-development, parallelisable to ~10 h wall time.

## Definition of done

- All 24 tasks committed.
- All tests green.
- PR open against `dev` with green CI.
- 5 follow-up issues opened with the right labels.
- Daemon log shows pickup of the first FUNC-CONCIERGE issue (or a diagnosed reason if not).

## Risks (Phase 0 specifically)

| Risk | Mitigation |
|---|---|
| Daemon doesn't recognise FUNC-CONCIERGE issue type | Task 23 Step 4 has a diagnose loop. Worst case: implement Phase 1 manually using subagent-driven-development. |
| Spec-loader change breaks an existing prompt that loads L0 by path | The path stays at `.specify/L0-vision.md`; only the id within changes. Task 17 (integration.ts) and Task 18 (prompts) explicitly cover comment / instruction wording. |
| the Operator disagrees with a draft L1 spec content | All L1 commits are separate atomic commits. Revert is a one-liner per spec. |
| Codex review surfaces a structural change after plan execution starts | Acceptable — the plan was reviewed before execution. New findings get folded into Phase 1 specs, not Phase 0. |
