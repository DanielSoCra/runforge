# Plugin & Addon System — Design

**Date:** 2026-03-19
**Status:** Approved
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

Plugins live in `auto-claude/plugins/` — version-controlled alongside the daemon. No sync problem: when auto-claude updates, plugins update with it. Per-repo activation is stored in Supabase, read as part of the existing config sync. At session spawn time, the daemon assembles active plugins into a composite context and injects it into the initial prompt. No files are written to the target repo.

For interactive developer use (working outside auto-claude), the dashboard provides an explicit "Export to repo" action that copies plugin skills into the repo's `.claude/` directory.

---

## Plugin Format

Each plugin is a directory under `auto-claude/plugins/`:

```
auto-claude/
  plugins/
    registry.json              # flat index of all available plugins
    auto-claude-dev/           # bootstrap meta-plugin for developing auto-claude
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

**`manifest.json`:**

```json
{
  "id": "web-stack",
  "name": "Web Stack",
  "version": "1.0.0",
  "description": "Skills and agents for modern web apps with Astro, Tailwind, SEO",
  "tags": ["frontend", "astro", "tailwind", "seo", "typescript"],
  "recommends_with": ["typescript"],
  "conflicts_with": []
}
```

**`registry.json`** is a flat index the daemon and dashboard read at runtime:

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

A startup check validates that every entry in `registry.json` corresponds to a real directory with a valid `manifest.json`.

---

## Supabase Data Model

Per-repo plugin activation is stored in a new `repo_plugins` table alongside the existing dashboard schema:

```sql
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

CREATE POLICY "members read repo_plugins" ON repo_plugins FOR SELECT USING (is_member());
CREATE POLICY "admins manage repo_plugins" ON repo_plugins FOR ALL USING (is_admin());
ALTER TABLE repo_plugins ENABLE ROW LEVEL SECURITY;
```

The `runs` table gains an `active_plugins text[]` column — the daemon writes the active plugin IDs at run start so the run detail page can show which plugins were in effect.

---

## LLM Recommendation Flow

Triggered as a Next.js Server Action when a repo is added (and on demand via "Re-analyze" in the dashboard). Runs a single Claude API call — not a full daemon session.

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

Input: `registry.json` (name, description, tags per plugin) + the fingerprint.
Output: structured JSON — ranked plugin IDs with confidence and reason.

```typescript
interface PluginRecommendation {
  pluginId: string
  confidence: 'high' | 'medium' | 'low'
  reason: string   // e.g. "Detected Astro in package.json"
}
```

**Step 3 — Write to Supabase:**

Upsert `repo_plugins` rows with `recommended: true, active: false`. Users see these in the dashboard as suggestions and opt in.

Recommendations are one-shot per repo initialization. Re-analysis is available on demand but does not auto-activate anything — user activation is always explicit.

---

## Daemon Config Sync

The existing config sync loop (daemon reads enabled repos from Supabase on startup and periodically) gains one additional query per repo:

```sql
SELECT plugin_id FROM repo_plugins
WHERE repo_id = $1 AND active = true
```

The result is a `string[]` stored in the cached repo config. No new sync mechanism — plugins ride the existing config refresh cycle.

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
- `prompt-injection.md` files are concatenated with a section separator
- Skills and agents: if two plugins define the same filename, the more specific plugin wins (repo-local beats built-in)
- MCP configs: unioned; duplicate server names log a warning and first one wins
- Gates: additive — all plugin gates run alongside the base `validation.gate1Commands`

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

**Plugin card (expanded):**

Shows name, description, confidence badge (for recommended), reason tooltip, and what it includes: skill count, agent count, MCPs, gates. Toggle activates/deactivates via Server Action with optimistic UI.

**Interactions:**
- **Enable / Disable** — Server Action upserts `repo_plugins`
- **Enable All Suggested** — batch Server Action for all `recommended=true, active=false` rows
- **Re-analyze repo** — triggers recommendation Server Action, updates rows, refreshes

**Run transparency** — the run detail page shows "Plugins active during this run" sourced from `runs.active_plugins`.

---

## Dependency Map Against Existing Dashboard Plan

| Existing Task | Change Required |
|---|---|
| Task 1 (Supabase Schema) | Add `002_plugins.sql` migration — `repo_plugins` table + RLS + `active_plugins` column on `runs` |
| Task 3 (Supabase Client + Types) | Generated types pick up `RepoPlugin`; add `PluginManifest` type to `lib/types.ts` |
| Task 7 (Repo Management) | Add Plugins tab to repo detail page; new `actions/plugins.ts` Server Actions |

New Task 14 (Plugin Management) depends on Tasks 1, 3, and 7:

```
auto-claude/plugins/           # plugin directories + registry.json
actions/plugins.ts             # togglePlugin, triggerRecommendation
app/repos/[id]/plugins/        # Plugins tab page
components/plugin-card.tsx     # card with toggle, badge, reason tooltip
lib/plugins/registry.ts        # reads plugins/registry.json
```

---

## Specs Required

This feature needs a new spec chain before implementation begins:

- `FUNC-AC-PLUGINS` (L1) — functional behavior: activation, recommendations, transparency
- `ARCH-AC-PLUGINS` (L2) — data model, API contract, daemon sync, injection pipeline
- `STACK-AC-PLUGINS` (L3) — TypeScript patterns, registry loader, Server Action shapes

All three must exist in `.specify/` and be linked in `traceability.yml` before any code is written. Use `l1-spec-guardian`, `l2-spec-guardian`, and `l3-spec-guardian` skills to write and validate them.

---

## Bootstrap Plugin: `auto-claude-dev`

The first plugin to build is `auto-claude-dev` — the skills and agents needed to develop auto-claude itself. It validates the entire plugin architecture end-to-end and enables the meta-loop: auto-claude watching its own repo with domain-specific expertise activated.

Contents:
- **Skills:** spec-guardian patterns, FSM patterns, TypeScript daemon conventions, traceability workflow
- **Agents:** spec-reviewer, architecture-critic
- **Prompt injection:** "You are working on the auto-claude daemon. Always check traceability.yml before editing files. Read specs before implementing."
