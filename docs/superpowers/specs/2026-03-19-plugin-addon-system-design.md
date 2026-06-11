---
date: 2026-03-19
status: superseded
superseded_by: .specify/L0-ac-vision.md  # unified L0-AC-VISION v5 + its L1 children (per the 2026-05-29 spec-reconciliation ledger)
superseded_date: 2026-06-11
---

# Plugin & Addon System — Design

> **⛔ SUPERSEDED (2026-06-11).** The canonical specs now live in the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children in `.specify/` (per the Spec Reconciliation Ledger, `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). Retained for history — do not act on this doc. <!-- RECONCILIATION-LEDGER-BANNER -->

**Date:** 2026-03-19
**Status:** Draft — Specs Pending (FUNC-AC-PLUGINS, ARCH-AC-PLUGINS, STACK-AC-PLUGINS)
**Author:** the Operator + Claude (brainstorm session)

---

## Problem

Auto-claude is a general-purpose daemon. Different repos need different expertise: a web app repo benefits from Astro patterns and a UI critic agent; an AI agent repo needs FastAPI patterns and a Pydantic validator. Today there is no way to give the daemon domain-specific skills — every session gets the same generic context regardless of what it is building.

Beyond domain skills, repos need different MCP integrations and different validation gates. A design-heavy repo wants Figma access; a Python repo wants a mypy gate. These capabilities should be composable and repo-specific, not hardcoded in the daemon.

---

## Solution

A plugin system built into the auto-claude codebase. Plugins are directories of Markdown files, agent prompts, MCP configs, and validation scripts. The daemon assembles active plugins into a composite context at session spawn time. Users activate plugins per repo through the dashboard. An LLM recommendation call suggests the right plugins when a repo is first added.

---

## Architecture

### Approach: Daemon-owned, injected at spawn

Plugins live in `auto-claude/plugins/` — version-controlled alongside the daemon. No sync problem: when auto-claude updates, plugins update with it. Per-repo activation is stored in Supabase, read as part of the existing config sync. At session spawn time, the daemon assembles active plugins into a composite context and injects it into the initial prompt. No files are written to the target repo during a session.

For interactive developer use (working outside auto-claude), the dashboard provides an explicit "Export to repo" action that copies plugin skills into the repo's `.claude/` directory.

---

## Plugin Format

Each plugin is a directory under `auto-claude/plugins/`:

```
auto-claude/
  plugins/
    registry.json              # flat index of all available plugins
    auto-claude-dev/           # permanent plugin for auto-claude's own repo
    web-stack/
    ai-agents/
    [plugin-id]/
      manifest.json
      skills/
        *.md                   # behavioral guides injected into sessions
      agents/
        *.md                   # specialized subagent prompts
      mcps/
        *.json                 # MCP server configs { name, command, args, env }
      gates/
        *.sh                   # domain-specific validation commands
      prompt-injection.md      # prepended to session context at spawn time
```

**`manifest.json` — required fields:** `id`, `name`, `version`, `description`. Optional fields: `tags` (defaults to `[]`).

```json
{
  "id": "web-stack",
  "name": "Web Stack",
  "version": "1.0.0",
  "description": "Skills and agents for modern web apps with Astro, Tailwind, SEO",
  "tags": ["frontend", "astro", "tailwind", "seo", "typescript"]
}
```

**`registry.json`** is a flat index the daemon and dashboard read at runtime. A startup check validates that every entry corresponds to a real directory containing a `manifest.json` with all required fields present:

```json
{
  "version": 1,
  "plugins": [
    { "id": "auto-claude-dev", "name": "Auto-Claude Dev", "tags": ["typescript", "daemon", "spec-driven"] },
    { "id": "web-stack",       "name": "Web Stack",        "tags": ["frontend", "astro", "tailwind"] },
    { "id": "ai-agents",       "name": "AI Agents",        "tags": ["python", "fastapi", "pydantic"] }
  ]
}
```

---

## Supabase Data Model

Per-repo plugin activation is stored in a `repo_plugins` table. The migration file is `supabase/migrations/002_plugins.sql`, which depends on `001_initial.sql` having already run (it uses the `is_member()` and `is_admin()` helpers defined there).

This is a single-tenant system. `is_member()` and `is_admin()` enforce team-wide access — any authenticated team member can read plugin rows for any repo, and any admin can write them. No per-repo ownership filtering is required.

```sql
-- 002_plugins.sql

CREATE TABLE repo_plugins (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id               uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  plugin_id             text NOT NULL,
  active                boolean NOT NULL DEFAULT false,
  recommended           boolean NOT NULL DEFAULT false,
  recommendation_reason text,
  recommended_at        timestamptz,
  activated_at          timestamptz,
  UNIQUE (repo_id, plugin_id)
);

ALTER TABLE repo_plugins ENABLE ROW LEVEL SECURITY;

-- Members read; admins write
CREATE POLICY "members read repo_plugins"
  ON repo_plugins FOR SELECT USING (is_member());

CREATE POLICY "admins insert repo_plugins"
  ON repo_plugins FOR INSERT WITH CHECK (is_admin());

CREATE POLICY "admins update repo_plugins"
  ON repo_plugins FOR UPDATE USING (is_admin());

CREATE POLICY "admins delete repo_plugins"
  ON repo_plugins FOR DELETE USING (is_admin());

-- Track which plugins were active during each run
ALTER TABLE runs ADD COLUMN active_plugins text[] NOT NULL DEFAULT '{}';
```

The `active_plugins` column on `runs` is written at INSERT (when the run row is first created, before the session begins). The daemon assembles the plugin list from its cached config, writes it into the INSERT payload, and does not update it afterward. This is a best-effort snapshot: `active_plugins` reflects the daemon's cached plugin state at spawn time, which may lag behind the database by up to one config sync interval (60 seconds by default). It is a transparency record, not an authoritative audit trail.

---

## LLM Recommendation Flow

Triggered as a Next.js Server Action when a repo is added. The recommendation call runs **asynchronously** — repo creation succeeds immediately and returns to the user. The call runs in the background (via a fire-and-forget async task within the Server Action, or a lightweight job mechanism). If the call fails for any reason (timeout, API error, rate limit), it fails silently: the repo is fully functional with no recommendations, and the user can trigger re-analysis manually from the dashboard.

**Step 1 — Fingerprint the repo** (server-side, using stored credentials):

```typescript
interface RepoFingerprint {
  languages: string[]     // from file extension scan
  frameworks: string[]    // from package.json, requirements.txt, Cargo.toml
  hasSpecs: boolean       // .specify/ directory present
  description: string     // package.json description or README first paragraph
}
```

**Step 2 — Claude API call:**

Input: `registry.json` (id, name, description, tags per plugin) + the fingerprint.
Output: structured JSON — ranked plugin IDs with confidence and reason.

```typescript
interface PluginRecommendation {
  pluginId: string
  confidence: 'high' | 'medium' | 'low'
  reason: string   // e.g. "Detected Astro in package.json"
}
```

Returned `pluginId` values are validated against `registry.json` before writing. Any ID not present in the registry is silently dropped.

**Step 3 — Write to Supabase:**

Upsert `repo_plugins` rows on conflict `(repo_id, plugin_id)`. The upsert updates only `recommended`, `recommendation_reason`, and `recommended_at` — it never touches `active` or `activated_at`. A plugin the user has already activated remains active regardless of re-analysis.

**Re-analysis** ("Re-analyze repo" button): runs the same flow. Same upsert semantics. Never overwrites `active`.

**Cost:** recommendation API calls are not attributed to any run and do not appear in `cost_events`. This is a known gap; a `system_cost_events` table or a cost category for background calls is deferred to a later iteration.

---

## Daemon Config Sync

The existing config sync loop gains one additional query per repo:

```sql
SELECT plugin_id FROM repo_plugins
WHERE repo_id = $1 AND active = true
```

The result is a `string[]` stored in the cached repo config as `activePlugins`. No new sync mechanism — plugins ride the existing config refresh cycle.

---

## Injection Pipeline

At session spawn time, the daemon builds a `CompositeContext` from all active plugins:

```typescript
interface CompositeContext {
  skills: string[]        // contents of skills/*.md across active plugins
  agents: string[]        // contents of agents/*.md across active plugins
  mcpConfigs: McpConfig[] // union of mcps/*.json
  promptInjection: string // concatenated prompt-injection.md files
  gates: string[]         // paths to gates/*.sh scripts
}
```

**Composition rules:**
- `prompt-injection.md` files are concatenated in the order plugins were activated (by `activated_at` ascending), separated by `\n---\n`.
- Skills and agents: filename collisions across plugins are resolved by `activated_at` ascending — the plugin activated first wins. No repo-local override mechanism exists in this iteration.
- MCP configs: unioned by server name. Duplicate server names log a warning and the first-activated plugin's config wins.
- Gates: additive — all plugin gates run alongside the base `validation.gate1Commands`.
- **Context window budget:** the total length of injected content (all `prompt-injection.md` + all skill and agent file contents) is capped at 20,000 tokens. If active plugins exceed this cap, the daemon logs a warning and truncates in this priority order: `prompt-injection.md` content is always preserved; skills are dropped before agents; within each type, content from the last-activated plugins is dropped first. The exact implementation of this algorithm is left to the L3 spec.

**Injection:** the composite context is prepended to the initial session prompt that auto-claude already controls. No files are written to the target repo during a session.

---

## Dashboard Plugins Tab

Located at `repos/[id]/plugins/page.tsx` — a tab on the repo detail page alongside Settings and API Keys.

**Layout:**

```
┌─────────────────────────────────────────────────────────┐
│  Plugins                          [Re-analyze repo]      │
├─────────────────────────────────────────────────────────┤
│  SUGGESTED                              [Enable All]     │
│  Plugin cards with confidence badge and reason tooltip   │
├─────────────────────────────────────────────────────────┤
│  ACTIVE                                                  │
│  Active plugin cards with [Disable] action               │
├─────────────────────────────────────────────────────────┤
│  ALL PLUGINS                                             │
│  Full catalog — inactive, non-recommended plugins        │
└─────────────────────────────────────────────────────────┘
```

**Plugin card (expanded):** shows name, description, confidence badge (for recommended), reason tooltip, skill count, agent count, MCPs, and gates. Toggle activates/deactivates via Server Action with optimistic UI.

**Interactions:**
- **Enable / Disable** — Server Action validates `plugin_id` against `registry.json` before writing. Unknown plugin IDs (e.g. a plugin removed from the filesystem after a row was created) are rejected with an error. At spawn time, the daemon also skips any `plugin_id` not found in the registry and logs a warning — orphaned rows never cause a session failure.
- **Enable All Suggested** — best-effort batch: each plugin is enabled independently. Failures are reported individually in the UI; successes are not rolled back. The user sees which plugins failed to enable with an error message.
- **Re-analyze repo** — triggers the recommendation Server Action. The Server Action dispatches the background call and returns immediately (fire-and-forget); the button loading state ends when the Server Action returns. New recommendation rows arrive via the existing Supabase Realtime subscription on `repo_plugins`, which updates the Suggested section without a page reload.

**Run transparency** — the run detail page shows "Plugins active during this run" sourced from `runs.active_plugins`.

---

## Dependency Map Against Existing Dashboard Plan

| Existing Task | Change Required |
|---|---|
| Task 1 (Supabase Schema) | Add `supabase/migrations/002_plugins.sql` — `repo_plugins` table + RLS + `active_plugins` column on `runs` |
| Task 3 (Supabase Client + Types) | Generated types pick up `RepoPlugin`; add `PluginManifest` type to `lib/types.ts` |
| Task 7 (Repo Management) | Add Plugins tab to repo detail page; new `actions/plugins.ts` Server Actions |

**New Task 14: Plugin Management** — depends on Tasks 1, 3, and 7:

```
auto-claude/plugins/           # plugin directories + registry.json
actions/plugins.ts             # togglePlugin, triggerRecommendation, enableAllSuggested
app/repos/[id]/plugins/        # Plugins tab page
components/plugin-card.tsx     # card with toggle, badge, reason tooltip
lib/plugins/registry.ts        # reads plugins/registry.json, validates manifest fields
```

---

## Specs Required Before Implementation

This feature needs a new spec chain. No code may be written until all three exist in `.specify/` and are linked in `traceability.yml`:

- `FUNC-AC-PLUGINS` (L1) — functional behavior: activation, recommendations, transparency, export to repo
- `ARCH-AC-PLUGINS` (L2) — data model, API contract, daemon sync, injection pipeline, composition rules
- `STACK-AC-PLUGINS` (L3) — TypeScript patterns, registry loader, Server Action shapes, token budget algorithm

Use `l1-spec-guardian`, `l2-spec-guardian`, and `l3-spec-guardian` skills to write and validate them.

---

## Bootstrap Plugin: `auto-claude-dev`

`auto-claude-dev` is a **permanent production plugin** — not a test fixture. It is the plugin activated on auto-claude's own repo when the daemon watches itself, enabling the meta-loop. It is a deliverable of Task 14.

Contents:
- **Skills:** spec-guardian patterns, FSM patterns, TypeScript daemon conventions, traceability workflow
- **Agents:** spec-reviewer, architecture-critic
- **Prompt injection:** "You are working on the auto-claude daemon. Always check traceability.yml before editing files. Read specs before implementing."
