---
date: 2026-03-20
status: superseded
superseded_by: .specify/L0-ac-vision.md  # unified L0-AC-VISION v5 + its L1 children (per the 2026-05-29 spec-reconciliation ledger)
superseded_date: 2026-06-11
---

# Agency Plugin — Design

> **⛔ SUPERSEDED (2026-06-11).** The canonical specs now live in the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children in `.specify/` (per the Spec Reconciliation Ledger, `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). Retained for history — do not act on this doc. <!-- RECONCILIATION-LEDGER-BANNER -->

**Date:** 2026-03-20
**Status:** Draft

---

## Summary

The Agency plugin turns runforge into a professional website production system. It provides a granular, composable skill suite that takes a client website from brief to live deployment — covering intelligence gathering, brand strategy, design, SEO, copywriting, assets, Astro or native HTML build, QA, and deployment. Each skill runs independently or as part of a category workflow. A master orchestrator sequences everything.

The plugin lives in `plugins/agency/` inside the runforge repo. Each client website becomes its own private GitHub repository, created and polled by runforge's existing multi-repo infrastructure. The website workflow runs as a new `website` pipeline variant triggered by an issue in the client repo.

---

## 1. Plugin Structure

```
plugins/agency/
├── manifest.json              # id, name, version, description (required fields only)
├── prompt-injection.md        # Agency context injected into every Claude session
├── skills/
│   ├── Orchestrators (10)
│   ├── Intelligence (4)
│   ├── Brand (7)
│   ├── Design (3)
│   ├── SEO (4)
│   ├── Content (4)
│   ├── Assets (2)
│   ├── Build — Astro (4)
│   ├── Build — Native (2)
│   ├── Features (7)
│   ├── QA (4)
│   └── Launch & Deploy (3)
├── mcps/
│   ├── firecrawl.json         # McpConfig for Firecrawl MCP server
│   └── playwright.json        # McpConfig for Playwright MCP server
├── references/
│   ├── conversion-psychology.md
│   ├── aeo-guide.md
│   ├── brand-frameworks.md    # Sinek, Neumeier, StoryBrand, The Futur
│   └── astro-patterns.md
└── templates/
    ├── brand-guide.md
    ├── design-spec.md
    ├── seo-plan.md
    └── brand-assets.json
```

### manifest.json

```json
{
  "id": "agency",
  "name": "Agency — Website Workflow",
  "version": "1.0.0",
  "description": "Complete website production pipeline: intelligence, brand, design, SEO, content, build, QA, and deployment. Requires Firecrawl and Playwright MCP servers."
}
```

### MCP configs — `mcps/`

Each file follows the existing `McpConfig` interface (`name`, `command`, `args`, `env`). The plugin loader extension described in Section 6 reads these files and populates `mcpConfigs` on the `LoadedPlugin` object.

---

## 2. Three-Tier Invocation Model

Every capability is available at three levels of granularity:

| Tier | Example | When to use |
|---|---|---|
| Single skill | `/keyword-research` | Targeted work on one aspect of an existing site |
| Category workflow | `/seo-workflow` | Redo an entire domain without running the full pipeline |
| Master orchestrator | `/website-workflow` | Build a site from scratch |

The master orchestrator calls category orchestrators. Category orchestrators call individual skills. Customising a category orchestrator propagates to the master automatically.

---

## 3. Full Skill Inventory

### Orchestrators

| Skill | Sequences |
|---|---|
| `website-workflow` | All category workflows in order |
| `intelligence-workflow` | firecrawl-extractor → competitor-research → security-auditor → ux-analyzer |
| `brand-workflow` | [brand-interview if no worksheet] → brand-strategy → color-system → typography-system → brand-voice → design-system → tailwind-theme |
| `design-workflow` | sitemap-generator → page-spec-writer (per page) → stylescape-generator |
| `seo-workflow` | keyword-research → aeo-planner → on-page-seo → schema-markup |
| `content-workflow` | page-copywriter (per page) → blog-post-writer → meta-writer → cta-writer |
| `assets-workflow` | image-art-director → asset-optimizer |
| `build-workflow` | Branches on `stack` config: **astro** → astro-scaffolder → astro-layout → astro-page-builder → astro-content-collections; **native** → html-builder → scroll-animator. Both paths then inject declared feature skills. |
| `qa-workflow` | lighthouse-auditor → accessibility-auditor → link-checker → seo-validator |
| `launch-workflow` | launch-checklist → github-pages-deploy or hetzner-deploy (per `deploy_target` config) |

### Intelligence

| Skill | Responsibility |
|---|---|
| `firecrawl-extractor` | Calls Firecrawl MCP to extract structured data from a URL: colors, fonts, value proposition, tech stack, target audience → `docs/01-analysis/raw_firecrawl_data.json` |
| `competitor-research` | Discovers 3–5 competitors, runs Firecrawl on each, produces comparison → `competitor_overview.md` |
| `security-auditor` | Passive checks via curl/dig: HSTS, CSP headers, DMARC/SPF records, TTFB → `security_report.md` |
| `ux-analyzer` | Evaluates site against StoryBrand and Golden Circle frameworks → `brand_audit_handoff.md` |

### Brand

| Skill | Responsibility |
|---|---|
| `brand-interview` | Structured interview when no completed strategy worksheet exists. Writes `docs/02-brand/strategy_worksheet.md`. `brand-workflow` skips this skill if the worksheet already exists. |
| `brand-strategy` | Develops Golden Circle (WHY/HOW/WHAT) and Onlyness Statement from strategy worksheet or `brand_audit_handoff.md` |
| `color-system` | Builds 60-30-10 palette. Outputs hex codes and usage rules |
| `typography-system` | Selects heading and body fonts. Recommends Google Fonts equivalents |
| `brand-voice` | Defines tone, vocabulary, sentence style, and archetype (e.g. The Sage, The Hero) |
| `design-system` | Defines spacing scale, shadows, border-radius, and component tokens |
| `tailwind-theme` | Generates `tailwind.config.mjs` from `brand_assets.json` |

All brand skills write to `docs/02-brand/`. Key outputs: `brand_guide.md`, `brand_assets.json`, `tailwind.config.mjs`.

### Design

| Skill | Responsibility |
|---|---|
| `sitemap-generator` | Defines page hierarchy, primary navigation, and footer structure |
| `page-spec-writer` | Writes section-by-section spec for one page: goal, layout, content direction, rationale |
| `stylescape-generator` | Produces three visual direction moodboards as HTML files for user selection |

All design skills write to `docs/03-design/`. Key outputs: `sitemap.md`, `design_spec.md`.

### SEO

| Skill | Responsibility |
|---|---|
| `keyword-research` | Discovers and prioritises keywords across three tiers: primary, secondary, long-tail |
| `aeo-planner` | Plans Answer Engine Optimisation: entity ownership, schema.org types per page, FAQ strategy |
| `on-page-seo` | Assigns primary keyword, H1 direction, and meta structure to each page |
| `schema-markup` | Generates JSON-LD structured data for Organisation, Article, FAQPage, HowTo, Product |

All SEO skills write to `docs/04-seo/seo_plan.md`.

### Content

| Skill | Responsibility |
|---|---|
| `page-copywriter` | Writes all copy for one page: headlines, body, CTAs — brand voice + SEO keyword woven in |
| `blog-post-writer` | Writes one complete blog post from a topic brief |
| `meta-writer` | Writes meta title and description for every page in the sitemap |
| `cta-writer` | Generates CTA variants per page and audience segment |

All content skills write to `docs/05-copy/[page].md`.

### Assets

| Skill | Responsibility |
|---|---|
| `image-art-director` | Produces asset manifest with AI image prompts, style reference description, and keyframe plan for scroll animations |
| `asset-optimizer` | Compresses images, converts to WebP, adds alt text from manifest |

Assets write to `docs/06-assets/asset_manifest.md`.

### Build — Astro

| Skill | Responsibility |
|---|---|
| `astro-scaffolder` | Initialises Astro project with pnpm, Tailwind, React integration, and base directory structure |
| `astro-layout` | Builds base layout, Header, and Footer components from design spec and brand assets |
| `astro-page-builder` | Builds one page from design spec and copy files |
| `astro-content-collections` | Sets up content collections for blog and portfolio with schema validation |

### Build — Native

| Skill | Responsibility |
|---|---|
| `html-builder` | Builds native HTML/CSS/JS pages from design spec and copy files using Tailwind CDN |
| `scroll-animator` | Implements scroll-driven keyframe animations using IntersectionObserver and image swapping |

### Features (injected by build-workflow)

Feature skills are injected only when listed in the `features` config array. Names in the array must match skill filenames exactly.

| Skill | `features` value | Responsibility |
|---|---|---|
| `contact-form` | `"contact-form"` | Integrates Netlify Forms, Formspree, or self-hosted endpoint |
| `blog-setup` | `"blog-setup"` | Adds categories, tags, pagination, and RSS feed to Astro content collections |
| `maps-integration` | `"maps-integration"` | Embeds Google Maps using `GOOGLE_MAPS_API_KEY` from global ENV |
| `analytics-setup` | `"analytics-setup"` | Integrates Plausible or GA4 using credentials from global ENV |
| `cookie-consent` | `"cookie-consent"` | Adds GDPR-compliant cookie consent banner, blocks analytics until consent |
| `site-search` | `"site-search"` | Integrates Pagefind for static full-text search |
| `i18n-setup` | `"i18n-setup"` | Configures multilingual support (de/en) using Astro's i18n routing |

### QA

| Skill | Responsibility |
|---|---|
| `lighthouse-auditor` | Runs Lighthouse via Playwright MCP. Pass thresholds: Performance ≥90, A11y ≥95, Best Practices ≥95, SEO ≥95. Auto-fixes missing alt text, meta tags, and broken canonical links in source files. |
| `accessibility-auditor` | Deep WCAG 2.1 AA check via Playwright MCP. Zero tolerance for missing alt text. |
| `link-checker` | Crawls all internal links via Playwright MCP. Flags any 4xx or 5xx responses. |
| `seo-validator` | Validates OG tags, meta titles/descriptions, canonical URLs, and JSON-LD presence per page. |

### Launch & Deploy

| Skill | Responsibility |
|---|---|
| `launch-checklist` | Checks DNS, SSL validity, http→https redirect, sitemap.xml, robots.txt, OG/Twitter tags, favicon, apple-touch-icon, 404 page, cookie consent. Auto-fixes what it can. Issues GO/NO-GO verdict. |
| `github-pages-deploy` | Creates GitHub Actions workflow for Astro static build and gh-pages deployment. |
| `hetzner-deploy` | Builds Astro to `dist/`, rsyncs to configured Hetzner server over SSH. |

---

## 4. Config System

### Plugin-level defaults

`manifest.json` holds the static description. Dashboard-editable plugin defaults are stored in a new `plugin_global_settings` table (see Section 5). On startup the daemon reads this table and makes defaults available to session context.

Default checkpoint values (editable in dashboard):

```json
{
  "checkpoints": {
    "intelligence-workflow": "checkpoint",
    "brand-workflow":        "checkpoint",
    "design-workflow":       "checkpoint",
    "seo-workflow":          "auto",
    "content-workflow":      "checkpoint",
    "assets-workflow":       "auto",
    "build-workflow":        "auto",
    "qa-workflow":           "auto",
    "launch-workflow":       "checkpoint"
  },
  "github_org": "danieleberl",
  "deploy_target": "github-pages",
  "default_language": "de",
  "default_stack": "astro"
}
```

### Per-client config

Per-repo overrides are stored in a `config jsonb` column added to the existing `repo_plugins` table. The daemon writes the merged config to `.agency.json` in the client workspace before each Claude session. `.agency.json` is generated — not hand-edited.

Example merged config written to `.agency.json`:

```json
{
  "client": "Acme GmbH",
  "language": "de",
  "stack": "astro",
  "deploy_target": "hetzner",
  "source_url": "https://old-site.de",
  "features": ["blog-setup", "contact-form", "maps-integration", "i18n-setup"],
  "checkpoints": {
    "brand-workflow":  "auto",
    "launch-workflow": "auto"
  }
}
```

### Checkpoint semantics

Each category workflow boundary has a checkpoint value of `"auto"` or `"checkpoint"`.

- **`"auto"`** — the pipeline continues immediately to the next category workflow after the current one completes.
- **`"checkpoint"`** — the pipeline posts a GitHub comment summarising the phase deliverables (file paths and key decisions), sets the run phase to `paused`, and waits. The operator resumes by adding a `resume` label to the issue or replying with `/resume`. The daemon then starts the next category workflow.

### Credentials — global ENV

All third-party service credentials live as global environment variables in runforge's dashboard settings. No credentials appear in plugin config or client repos.

| Variable | Used by |
|---|---|
| `FIRECRAWL_API_KEY` | Firecrawl MCP server |
| `GOOGLE_MAPS_API_KEY` | `maps-integration` skill |
| `PLAUSIBLE_API_KEY` | `analytics-setup` skill (Plausible path) |
| `GA4_MEASUREMENT_ID` | `analytics-setup` skill (GA4 path) |

---

## 5. Schema Changes

### Extend `repo_plugins`

```sql
ALTER TABLE repo_plugins
  ADD COLUMN config jsonb NOT NULL DEFAULT '{}';
```

Stores per-repo plugin config. The daemon reads `config` when generating `.agency.json`. Dashboard UI edits this column directly. The Hetzner deployment credentials (`hetzner_host`, `hetzner_user`, `hetzner_dest_path`) and SSH key reference are stored here as per-client fields — they are per-repo, not global ENV.

### New table: `plugin_global_settings`

```sql
CREATE TABLE plugin_global_settings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id  text NOT NULL UNIQUE,
  settings   jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users
);

ALTER TABLE plugin_global_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read plugin_global_settings"
  ON plugin_global_settings FOR SELECT USING (is_member());

CREATE POLICY "admins write plugin_global_settings"
  ON plugin_global_settings FOR ALL USING (is_admin()) WITH CHECK (is_admin());
```

Stores dashboard-editable defaults per plugin. One row per plugin. The `agency` plugin row holds the default checkpoint map, github_org, deploy_target, default_language, and default_stack.

---

## 6. Daemon Integration

### New `website` pipeline variant

The existing daemon runs `feature-simple`, `feature`, and `bug` pipeline variants. The agency plugin adds a `website` variant. Four changes are required in the daemon:

1. **`types.ts` — extend `PipelineVariant`**: `'feature' | 'feature-simple' | 'bug' | 'website'`

2. **`types.ts` — extend `Phase`**: add the website pipeline phase literals to the `Phase` union: `'init' | 'intelligence' | 'brand' | 'design' | 'seo' | 'content' | 'assets' | 'build' | 'qa' | 'launch'`. These must be in the union for `TransitionTable` (typed as `Partial<Record<Phase, ...>>`) to accept website phase names without TypeScript errors.

3. **`fsm.ts`** — add a `websiteTransitions` transition table using the new phase literals and register it in the `PIPELINES` record under key `'website'`. Update `getStartPhase` to return `'init'` (not `'detect'`) when `variant === 'website'`. Without this, `getStartPhase('website')` returns `'detect'`, which does not exist in `websiteTransitions`, causing the FSM to fail on the first transition.

4. **Work detection** — the existing `work-detection.ts` queries GitHub for issues labelled `"ready"`. The bootstrap issue (step 4 below) carries **both** `"ready"` and `"website-init"` labels. The variant routing logic reads the issue labels after detection: if `"website-init"` is present, the run is assigned `variant: 'website'`; otherwise the existing classifier determines the variant.

The `website` pipeline phases replace the standard `detect → classify → decompose → implement → review → report` sequence:

```
init → intelligence* → brand → design → seo → content → assets → build → qa → launch → done
```

`*` — `intelligence` runs only when `source_url` is set in config. Each arrow is a checkpoint boundary governed by the merged checkpoint config.

### Checkpoint resume mechanism

When a phase boundary has `"checkpoint"`, the pipeline posts a GitHub comment with deliverables and transitions the run to `phase: 'paused'`. The existing `work-detection.ts` already polls open issues with label `"ready"`. To resume a paused run, the operator adds the `"resume"` label to the issue. The RepoPoller for that repo detects the `"resume"` label on the paused issue, clears the label, and re-enters the pipeline at the next phase. The `start_from` field in `.agency.json` records which phase to resume from; the daemon writes this field when pausing and clears it after the phase starts.

### Plugin loader extension

`plugin-loader.ts` currently sets `mcpConfigs: []` for every loaded plugin. The extension reads `mcps/*.json` files from the plugin directory and populates `mcpConfigs` accordingly. Each file must conform to the existing `McpConfig` interface (`name`, `command`, `args`, `env`).

### Registry update

`plugins/registry.json` must include the agency entry in the top-level `plugins` array:

```json
{
  "version": 1,
  "plugins": [
    { "id": "runforge-dev", "name": "Runforge Dev", "tags": ["typescript", "daemon", "spec-driven", "fsm"] },
    { "id": "agency", "name": "Agency — Website Workflow", "tags": ["website", "astro", "brand", "seo"] }
  ]
}
```

Without this entry, `loadPluginRegistry` throws `Plugin directory not found` and the plugin never loads.

### Client repo lifecycle

```
1. Admin clicks "New Website" in runforge dashboard
   → fills client name, source URL (optional), features, stack, deploy target

2. Dashboard creates private GitHub repo at configured org
   (uses existing github_connections OAuth token)

3. Dashboard upserts repo into repos table (enabled = true)
   → inserts repo_plugins row (plugin_id = 'agency') with config from form input
   → calls POST /repos/reload on daemon control server
   → daemon starts RepoPoller for new repo

4. Dashboard creates bootstrap issue in new repo with labels "ready" and "website-init"
   → issue body contains the client brief from form input

5. RepoPoller detects issue (label "ready"), reads "website-init" label
   → selects website pipeline variant

6. Daemon spawns Claude session
   → reads plugin_global_settings + repo_plugins.config from Supabase
   → merges config (repo-level wins on every key)
   → writes .agency.json into workspace (including start_from: null)
   → loads agency plugin skills and MCP configs

7. Claude reads .agency.json, determines entry point:
     source_url present → starts intelligence-workflow
     strategy_worksheet.md exists → starts brand-workflow (skips brand-interview)
     neither            → starts brand-workflow (runs brand-interview first)

8. website-workflow sequences category workflows
   → checkpoint boundary: posts GitHub comment, sets phase = paused,
     writes start_from to repo_plugins.config, awaits "resume" label
   → auto boundary: continues immediately to next workflow
   → commits docs/ output after each phase with structured git history

9. launch-workflow completes
   → GitHub Pages action triggered, or rsync to Hetzner
   → live URL written back to repo_plugins.config in Supabase
   → dashboard shows client status as "live"
```

---

## 7. Client Repo Structure (after full run)

```
[client-slug]/
├── .agency.json              # Generated by daemon — not hand-edited
├── docs/
│   ├── 01-analysis/          # intelligence-workflow output
│   ├── 02-brand/             # brand-workflow output
│   ├── 03-design/            # design-workflow output
│   ├── 04-seo/               # seo-workflow output
│   ├── 05-copy/              # content-workflow output
│   └── 06-assets/            # assets-workflow output
├── src/
│   ├── components/
│   │   ├── global/           # Button, Card, Header, Footer
│   │   └── sections/         # HomeHero, ServicesGrid, etc.
│   ├── content/              # Astro content collections (blog, portfolio)
│   ├── layouts/
│   └── pages/
├── public/
│   └── assets/               # Optimised images
├── astro.config.mjs
├── tailwind.config.mjs       # Generated by tailwind-theme skill
└── package.json
```

---

## 8. Entry Points

| Entry point | Condition | First workflow |
|---|---|---|
| URL | `source_url` set in config | `intelligence-workflow` |
| Existing brief | `strategy_worksheet.md` exists in `docs/02-brand/` | `brand-workflow` (skips brand-interview) |
| Scratch | neither | `brand-workflow` (runs brand-interview) |
| Resume | `start_from` set in `repo_plugins.config` | that workflow directly |

**`start_from` lifecycle:** The daemon writes `start_from` to `repo_plugins.config` (and regenerates `.agency.json`) when pausing at a checkpoint boundary. The value is the name of the next category workflow to run (e.g., `"design-workflow"`). When the operator adds the `"resume"` label, the daemon reads `start_from`, clears it from `repo_plugins.config`, and spawns a new Claude session that begins at that workflow. After the session starts, `start_from` is null — preventing re-entry on subsequent polling cycles.

---

## 9. Out of Scope

- The agency repo at `/projects/agency` — managed separately, may connect to this plugin in a future iteration
- Image generation — `image-art-director` produces prompts and a manifest; actual generation requires a separate image model integration
- CMS integration — content collections cover blog/portfolio; a headless CMS adapter is a future feature
- E-commerce — not part of v1
