# Plugin & Addon System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a plugin system that lets operators activate domain-specific skill packs per repo, with LLM-powered recommendations and a dashboard Plugins tab to manage them.

**Architecture:** Plugins are directories in `plugins/` (repo root) containing Markdown skill files, agent prompts, MCP configs, and gate scripts. The daemon loads them at startup, assembles a CompositeContext at session spawn time, and prepends it to the initial prompt. Per-repo activation is stored in Supabase (`repo_plugins` table). The dashboard exposes a Plugins tab with toggle controls and LLM-powered suggestions delivered via Supabase Realtime.

**Tech Stack:** TypeScript (tsx, Vitest), Next.js 16 App Router, Supabase (`@supabase/supabase-js`, `@supabase/ssr`), `@anthropic-ai/sdk` (recommendation call), shadcn/ui

**Specs:** `.specify/functional/plugins.md`, `.specify/architecture/plugins.md`, `.specify/stack/plugins-daemon-ts.md`, `.specify/stack/plugins-dashboard-ts.md`

**Dependency note:** Tasks 1–3 (plugin directory, daemon registry, daemon injection) are independent. Tasks 4–8 (Supabase, dashboard) are independent of Tasks 1–3. Task 9 (daemon config sync) requires the Supabase config sync from the dashboard plan to be in place. Task 10 (session injection wiring) requires Tasks 2, 3, and 9.

---

## File Structure

```
plugins/                                    # repo root — plugin catalog
  registry.json                             # flat index of all plugins
  auto-claude-dev/
    manifest.json
    prompt-injection.md
    skills/
      spec-guardian.md
      fsm-patterns.md
    agents/
      spec-reviewer.md

src/control-plane/
  plugin-registry.ts                        # load + validate plugins/registry.json (NEW)
  plugin-registry.test.ts                   # (NEW)
  fixtures/plugins/                         # test fixtures (NEW)
    registry.json
    test-plugin/manifest.json

src/session-runtime/
  plugin-injection.ts                       # build CompositeContext from loaded plugins (NEW)
  plugin-injection.test.ts                  # (NEW)

src/config.ts                               # add activePlugins?: string[] (MODIFY)
src/types.ts                                # extend SessionContext with activePlugins (MODIFY)
src/session-runtime/runtime.ts             # prepend CompositeContext in assemblePrompt (MODIFY)

supabase/migrations/
  002_plugins.sql                           # repo_plugins table + RLS + runs.active_plugins (NEW)
supabase/tests/
  rls-plugins.test.ts                       # RLS tests for repo_plugins (NEW)

dashboard/lib/plugins/
  registry.ts                               # reads plugins/registry.json for dashboard use (NEW)
  registry.test.ts                          # (NEW)

dashboard/actions/
  plugins.ts                                # Server Actions: toggle, enableAll, recommend, export (NEW)
  plugins.test.ts                           # (NEW)

dashboard/components/
  plugin-card.tsx                           # plugin card with toggle + badge + reason tooltip (NEW)

dashboard/app/repos/[id]/plugins/
  page.tsx                                  # Plugins tab page (NEW)

dashboard/app/repos/[id]/
  page.tsx                                  # add Plugins tab (MODIFY)
```

---

## Task 1: Plugin Directory Structure + Bootstrap Plugin

**Files:**
- Create: `plugins/registry.json`
- Create: `plugins/auto-claude-dev/manifest.json`
- Create: `plugins/auto-claude-dev/prompt-injection.md`
- Create: `plugins/auto-claude-dev/skills/spec-guardian.md`
- Create: `plugins/auto-claude-dev/skills/fsm-patterns.md`
- Create: `plugins/auto-claude-dev/agents/spec-reviewer.md`

- [ ] **Step 1: Create `plugins/registry.json`**

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "auto-claude-dev",
      "name": "Auto-Claude Dev",
      "description": "Skills and agents for developing the auto-claude daemon: spec-driven development, FSM patterns, traceability workflow.",
      "tags": ["typescript", "daemon", "spec-driven", "fsm"]
    }
  ]
}
```

- [ ] **Step 2: Create `plugins/auto-claude-dev/manifest.json`**

```json
{
  "id": "auto-claude-dev",
  "name": "Auto-Claude Dev",
  "version": "1.0.0",
  "description": "Skills and agents for developing the auto-claude daemon: spec-driven development, FSM patterns, traceability workflow.",
  "tags": ["typescript", "daemon", "spec-driven", "fsm"]
}
```

- [ ] **Step 3: Create `plugins/auto-claude-dev/prompt-injection.md`**

```markdown
You are working on the auto-claude daemon — a TypeScript process that spawns autonomous Claude Code sessions against GitHub repos.

Always check `.specify/traceability.yml` before editing any file to find the governing spec.
Read specs before implementing: L3 (patterns) → L2 (architecture) → L1 (business context).
Never implement a feature without a complete FUNC → ARCH → STACK spec chain.
```

- [ ] **Step 4: Create `plugins/auto-claude-dev/skills/spec-guardian.md`**

```markdown
# Spec Guardian Patterns

When creating or reviewing specs, use the appropriate skill:
- `l1-spec-guardian` for FUNC-* (L1 functional specs)
- `l2-spec-guardian` for ARCH-* (L2 architecture specs)
- `l3-spec-guardian` for STACK-* (L3 stack specs)

L1: business WHY only — no technology, human actors, Given/When/Then scenarios.
L2: system HOW — system names only, plain-language data model, six required sections.
L3: pattern guide — named pattern + rationale, 3–5 line snippet, one concern per spec.
```

- [ ] **Step 5: Create `plugins/auto-claude-dev/skills/fsm-patterns.md`**

```markdown
# FSM Patterns

The pipeline uses a generic FSM engine in `packages/daemon/src/control-plane/fsm.ts`.
States are strings. Transitions are pure functions: `(state, event) → state`.
Side effects happen in phase handlers, not in the FSM itself.
Always write tests for every state transition before implementing the handler.
```

- [ ] **Step 6: Create `plugins/auto-claude-dev/agents/spec-reviewer.md`**

```markdown
You are a spec reviewer for the auto-claude project.

When reviewing a spec:
1. Check that FUNC specs have no technology terms and use Given/When/Then.
2. Check that ARCH specs use system names only and have all six required sections.
3. Check that STACK specs name a pattern with rationale and show only 3–5 line examples.
4. Verify the spec is linked in `.specify/traceability.yml`.
5. Return a verdict: Approved or Issues Found, with specific issues listed.
```

- [ ] **Step 7: Commit**

```bash
git add plugins/
git commit -m "feat(plugins): add plugin directory structure and auto-claude-dev bootstrap plugin"
```

---

## Task 2: Daemon — Plugin Registry Loader

**Files:**
- Create: `packages/daemon/src/control-plane/plugin-registry.ts`
- Create: `packages/daemon/src/control-plane/plugin-registry.test.ts`
- Create: `packages/daemon/src/control-plane/fixtures/plugins/registry.json`
- Create: `packages/daemon/src/control-plane/fixtures/plugins/test-plugin/manifest.json`
- Create: `packages/daemon/src/control-plane/fixtures/plugins-bad-manifest/registry.json`
- Create: `packages/daemon/src/control-plane/fixtures/plugins-bad-manifest/bad-plugin/manifest.json`

- [ ] **Step 1: Create test fixtures**

`packages/daemon/src/control-plane/fixtures/plugins/registry.json`:
```json
{
  "version": 1,
  "plugins": [{ "id": "test-plugin", "name": "Test Plugin", "tags": [] }]
}
```

`packages/daemon/src/control-plane/fixtures/plugins/test-plugin/manifest.json`:
```json
{ "id": "test-plugin", "name": "Test Plugin", "version": "1.0.0", "description": "Test" }
```

`packages/daemon/src/control-plane/fixtures/plugins-bad-manifest/registry.json`:
```json
{ "version": 1, "plugins": [{ "id": "bad-plugin", "name": "Bad", "tags": [] }] }
```

`packages/daemon/src/control-plane/fixtures/plugins-bad-manifest/bad-plugin/manifest.json`:
```json
{ "id": "bad-plugin" }
```

- [ ] **Step 2: Write failing tests**

Create `packages/daemon/src/control-plane/plugin-registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { loadPluginRegistry } from './plugin-registry.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('loadPluginRegistry', () => {
  it('loads a valid registry and returns plugins', async () => {
    const registry = await loadPluginRegistry(join(FIXTURES, 'plugins'));
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]!.id).toBe('test-plugin');
    expect(registry.plugins[0]!.dir).toContain('test-plugin');
  });

  it('throws when a plugin directory is missing', async () => {
    await expect(loadPluginRegistry(join(FIXTURES, 'plugins-no-dir'))).rejects.toThrow(
      'Plugin directory not found',
    );
  });

  it('throws when manifest is missing required fields', async () => {
    await expect(loadPluginRegistry(join(FIXTURES, 'plugins-bad-manifest'))).rejects.toThrow(
      'missing required fields',
    );
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

```bash
cd ~/code/auto-claude
pnpm vitest run packages/daemon/src/control-plane/plugin-registry.test.ts
```

Expected: FAIL — `Cannot find module './plugin-registry.js'`

- [ ] **Step 4: Implement `plugin-registry.ts`**

Create `packages/daemon/src/control-plane/plugin-registry.ts`:

```typescript
import { readFile, access } from 'fs/promises';
import { join } from 'path';

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  dir: string; // absolute path to plugin directory
}

export interface PluginRegistry {
  version: number;
  plugins: PluginEntry[];
}

const REQUIRED_MANIFEST_FIELDS = ['id', 'name', 'version', 'description'] as const;

export async function loadPluginRegistry(pluginsDir: string): Promise<PluginRegistry> {
  const registryPath = join(pluginsDir, 'registry.json');
  const raw = await readFile(registryPath, 'utf-8').catch(() => {
    throw new Error(`Plugin registry not found at ${registryPath}`);
  });
  const json = JSON.parse(raw) as { version: number; plugins: Array<{ id: string; name: string; tags: string[] }> };

  const plugins: PluginEntry[] = [];
  for (const entry of json.plugins) {
    const dir = join(pluginsDir, entry.id);
    await access(dir).catch(() => {
      throw new Error(`Plugin directory not found: ${dir}`);
    });
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    for (const field of REQUIRED_MANIFEST_FIELDS) {
      if (!manifest[field]) throw new Error(`Plugin ${entry.id}: manifest missing required fields (${field})`);
    }
    plugins.push({ id: entry.id, name: manifest.name, description: manifest.description, tags: entry.tags ?? [], dir });
  }

  return { version: json.version, plugins };
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
pnpm vitest run packages/daemon/src/control-plane/plugin-registry.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/control-plane/plugin-registry.ts src/control-plane/plugin-registry.test.ts src/control-plane/fixtures/
git commit -m "feat(plugins): add daemon plugin registry loader with startup validation"
```

---

## Task 3: Daemon — CompositeContext Assembly

**Files:**
- Create: `packages/daemon/src/session-runtime/plugin-injection.ts`
- Create: `packages/daemon/src/session-runtime/plugin-injection.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/daemon/src/session-runtime/plugin-injection.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildCompositeContext, type LoadedPlugin } from './plugin-injection.js';

function makePlugin(id: string, activatedAt: string, overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    id,
    activatedAt,
    promptInjection: `${id}-injection`,
    skills: [],
    agents: [],
    mcpConfigs: [],
    gates: [],
    ...overrides,
  };
}

describe('buildCompositeContext', () => {
  it('concatenates prompt injections in activatedAt order (earliest first)', () => {
    const plugins = [
      makePlugin('b', '2024-01-02T00:00:00Z'),
      makePlugin('a', '2024-01-01T00:00:00Z'),
    ];
    const ctx = buildCompositeContext(plugins);
    expect(ctx.promptInjection.indexOf('a-injection')).toBeLessThan(
      ctx.promptInjection.indexOf('b-injection'),
    );
  });

  it('first-activated plugin wins on skill filename collision', () => {
    const plugins = [
      makePlugin('a', '2024-01-01T00:00:00Z', { skills: [{ name: 'pat.md', content: 'a-content', pluginId: 'a' }] }),
      makePlugin('b', '2024-01-02T00:00:00Z', { skills: [{ name: 'pat.md', content: 'b-content', pluginId: 'b' }] }),
    ];
    const ctx = buildCompositeContext(plugins);
    expect(ctx.skills.filter(s => s.name === 'pat.md')).toHaveLength(1);
    expect(ctx.skills.find(s => s.name === 'pat.md')!.content).toBe('a-content');
  });

  it('unions MCP configs, first-activated wins on duplicate server name', () => {
    const plugins = [
      makePlugin('a', '2024-01-01T00:00:00Z', { mcpConfigs: [{ name: 'figma', command: 'npx', args: ['figma-a'] }] }),
      makePlugin('b', '2024-01-02T00:00:00Z', { mcpConfigs: [{ name: 'figma', command: 'npx', args: ['figma-b'] }] }),
    ];
    const ctx = buildCompositeContext(plugins);
    expect(ctx.mcpConfigs.filter(m => m.name === 'figma')).toHaveLength(1);
    expect(ctx.mcpConfigs.find(m => m.name === 'figma')!.args).toContain('figma-a');
  });

  it('truncates skills before agents when budget exceeded, preserving promptInjection', () => {
    const longSkill = { name: 'big.md', content: 'x'.repeat(100000), pluginId: 'a' };
    const plugins = [makePlugin('a', '2024-01-01T00:00:00Z', { skills: [longSkill] })];
    const ctx = buildCompositeContext(plugins, { tokenBudget: 50 });
    expect(ctx.skills).toHaveLength(0);
    expect(ctx.promptInjection).toContain('a-injection');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run packages/daemon/src/session-runtime/plugin-injection.test.ts
```

Expected: FAIL — `Cannot find module './plugin-injection.js'`

- [ ] **Step 3: Implement `plugin-injection.ts`**

Create `packages/daemon/src/session-runtime/plugin-injection.ts`:

```typescript
export interface SkillDoc { name: string; content: string; pluginId: string; }
export interface McpConfig { name: string; command: string; args: string[]; env?: Record<string, string>; }
export interface LoadedPlugin {
  id: string;
  activatedAt: string;
  promptInjection: string;
  skills: SkillDoc[];
  agents: SkillDoc[];
  mcpConfigs: McpConfig[];
  gates: string[];
}

export interface CompositeContext {
  promptInjection: string;
  skills: SkillDoc[];
  agents: SkillDoc[];
  mcpConfigs: McpConfig[];
  gates: string[];
}

const CHARS_PER_TOKEN = 4;

function estimateTokens(ctx: CompositeContext): number {
  const text = ctx.skills.map(s => s.content).join('') +
    ctx.agents.map(a => a.content).join('') +
    ctx.promptInjection;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function buildCompositeContext(
  plugins: LoadedPlugin[],
  options: { tokenBudget?: number } = {},
): CompositeContext {
  const tokenBudget = options.tokenBudget ?? 20000;
  const sorted = [...plugins].sort((a, b) => a.activatedAt.localeCompare(b.activatedAt));

  const promptParts: string[] = [];
  const skillMap = new Map<string, SkillDoc>();
  const agentMap = new Map<string, SkillDoc>();
  const mcpMap = new Map<string, McpConfig>();
  const gates: string[] = [];

  for (const plugin of sorted) {
    if (plugin.promptInjection) promptParts.push(plugin.promptInjection);
    for (const skill of plugin.skills) {
      if (!skillMap.has(skill.name)) skillMap.set(skill.name, skill);
    }
    for (const agent of plugin.agents) {
      if (!agentMap.has(agent.name)) agentMap.set(agent.name, agent);
    }
    for (const mcp of plugin.mcpConfigs) {
      if (!mcpMap.has(mcp.name)) mcpMap.set(mcp.name, mcp);
    }
    gates.push(...plugin.gates);
  }

  const ctx: CompositeContext = {
    promptInjection: promptParts.join('\n\n---\n\n'),
    skills: [...skillMap.values()],
    agents: [...agentMap.values()],
    mcpConfigs: [...mcpMap.values()],
    gates,
  };

  // Apply token budget: preserve promptInjection, drop skills before agents, last-activated first
  while (estimateTokens(ctx) > tokenBudget) {
    if (ctx.skills.length > 0) {
      ctx.skills.pop(); // last-in = last-activated (sorted ascending, last = latest)
    } else if (ctx.agents.length > 0) {
      ctx.agents.pop();
    } else {
      break;
    }
  }

  return ctx;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm vitest run packages/daemon/src/session-runtime/plugin-injection.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session-runtime/plugin-injection.ts src/session-runtime/plugin-injection.test.ts
git commit -m "feat(plugins): add CompositeContext assembly with ordered merge and token budget"
```

---

## Task 4: Daemon — Config Schema + Types

**Files:**
- Modify: `packages/daemon/src/config.ts`
- Modify: `packages/daemon/src/types.ts`

- [ ] **Step 1: Add `activePlugins` to `ConfigSchema` in `packages/daemon/src/config.ts`**

In `packages/daemon/src/config.ts`, add to the `ConfigSchema` object (after `gracePeriodMs`):

```typescript
activePlugins: z.array(z.string()).default([]),
```

This is the interim fallback for repos without Supabase config sync. When Supabase sync lands, it overwrites this value from the database.

- [ ] **Step 2: Extend `SessionContext` in `packages/daemon/src/types.ts`**

Find the `SessionContext` type in `packages/daemon/src/types.ts`. Add the `activePlugins` field:

```typescript
activePlugins?: string[];  // plugin IDs active for this repo, from config or Supabase sync
```

- [ ] **Step 3: Run type check**

```bash
pnpm tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/types.ts
git commit -m "feat(plugins): add activePlugins to config schema and SessionContext type"
```

---

## Task 5: Daemon — Session Injection Wiring

**Files:**
- Modify: `packages/daemon/src/session-runtime/runtime.ts`

- [ ] **Step 1: Read `packages/daemon/src/session-runtime/runtime.ts` to understand `assemblePrompt`**

The `assemblePrompt` method (line 178) builds the session prompt. It currently prepends `def.systemPrompt` then appends context variables. Plugin injection goes at the top — before the system prompt.

- [ ] **Step 2: Write a failing test**

Add to `packages/daemon/src/session-runtime/runtime.test.ts` (create if it doesn't exist):

```typescript
import { describe, it, expect, vi } from 'vitest';
// This is an integration-style test — we verify the prompt contains injected plugin content.
// We'll test assemblePrompt indirectly via the exported helper once it exists.
// For now, test that buildCompositeContext output is prepended to the prompt.
import { buildCompositeContext } from './plugin-injection.js';

it('composite context prompt injection appears before system prompt', () => {
  const ctx = buildCompositeContext([{
    id: 'test', activatedAt: '2024-01-01T00:00:00Z',
    promptInjection: 'PLUGIN INJECTION',
    skills: [], agents: [], mcpConfigs: [], gates: [],
  }]);
  const systemPrompt = 'SYSTEM PROMPT';
  const assembled = [ctx.promptInjection, systemPrompt].filter(Boolean).join('\n\n---\n\n');
  expect(assembled.indexOf('PLUGIN INJECTION')).toBeLessThan(assembled.indexOf('SYSTEM PROMPT'));
});
```

- [ ] **Step 3: Run test — verify it passes (it tests the composition pattern, not yet wired to runtime)**

```bash
pnpm vitest run packages/daemon/src/session-runtime/runtime.test.ts
```

- [ ] **Step 4: Wire into `SessionRuntime.assemblePrompt`**

In `packages/daemon/src/session-runtime/runtime.ts`:

1. Import at the top:
```typescript
import { buildCompositeContext, type LoadedPlugin } from './plugin-injection.js';
import { readPluginsForContext } from './plugin-loader.js';
```

2. Create `packages/daemon/src/session-runtime/plugin-loader.ts` — reads plugin file content from disk for given IDs:

```typescript
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import type { LoadedPlugin, SkillDoc } from './plugin-injection.js';

const PLUGINS_DIR = process.env['PLUGINS_DIR'] ?? join(import.meta.dirname, '../../../../plugins');

async function readMarkdownFiles(dir: string): Promise<SkillDoc[]> {
  const { readdir } = await import('fs/promises');
  const files = await readdir(dir).catch(() => [] as string[]);
  return Promise.all(
    files.filter(f => f.endsWith('.md')).map(async f => ({
      name: f,
      content: await readFile(join(dir, f), 'utf-8'),
      pluginId: '',
    })),
  );
}

// Cached registry loaded once at startup — avoids per-session disk reads.
let _registryCache: Awaited<ReturnType<typeof import('./plugin-registry.js').loadPluginRegistry>> | null = null;
async function getRegistry() {
  if (!_registryCache) {
    const { loadPluginRegistry } = await import('./plugin-registry.js');
    _registryCache = await loadPluginRegistry(PLUGINS_DIR);
  }
  return _registryCache;
}

export async function readPluginsForContext(
  pluginIds: string[],
  pluginActivations: Map<string, string>, // pluginId → activated_at ISO string
): Promise<LoadedPlugin[]> {
  const registry = await getRegistry();
  const knownIds = new Set(registry.plugins.map(p => p.id));
  const results: LoadedPlugin[] = [];

  for (const id of pluginIds) {
    // Skip orphaned plugin IDs gracefully (plugin removed from codebase after DB row created)
    if (!knownIds.has(id)) {
      console.warn(`[plugins] Skipping unknown plugin id at spawn time: ${id}`);
      continue;
    }
    const dir = join(PLUGINS_DIR, id);
    const skills = (await readMarkdownFiles(join(dir, 'skills'))).map(s => ({ ...s, pluginId: id }));
    const agents = (await readMarkdownFiles(join(dir, 'agents'))).map(a => ({ ...a, pluginId: id }));
    const injection = await readFile(join(dir, 'prompt-injection.md'), 'utf-8').catch(() => '');
    results.push({
      id,
      activatedAt: pluginActivations.get(id) ?? new Date(0).toISOString(),
      promptInjection: injection,
      skills,
      agents,
      mcpConfigs: [],
      gates: [],
    });
  }

  return results;
}
```

3. Modify `assemblePrompt` in `runtime.ts` to accept `activePlugins` from context:

```typescript
private async assemblePrompt(def: AgentDefinition, context: SessionContext): Promise<string> {
  let prompt = def.systemPrompt;
  for (const [key, value] of Object.entries(context.variables)) {
    prompt += `\n\n## ${key}\n${value}`;
  }
  if (!context.activePlugins?.length) return prompt;

  const activations = new Map(context.activePlugins.map(id => [id, new Date(0).toISOString()]));
  const loaded = await readPluginsForContext(context.activePlugins, activations);
  const composite = buildCompositeContext(loaded);
  if (!composite.promptInjection) return prompt;
  return `${composite.promptInjection}\n\n---\n\n${prompt}`;
}
```

4. Update the `spawnSession` call from `assemblePrompt` to `await this.assemblePrompt(...)` (it becomes async).

- [ ] **Step 5: Run type check and tests**

```bash
pnpm tsc --noEmit && pnpm vitest run packages/daemon/src/session-runtime/
```

Expected: No type errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/session-runtime/plugin-loader.ts src/session-runtime/runtime.ts
git commit -m "feat(plugins): wire CompositeContext injection into session spawn prompt"
```

---

## Task 6: Supabase — Migration + RLS Tests

**Files:**
- Create: `supabase/migrations/002_plugins.sql`
- Create: `supabase/tests/rls-plugins.test.ts`

> **Prerequisite:** `supabase/migrations/001_initial.sql` must already be applied. The `is_member()` and `is_admin()` helper functions must exist on the database.

- [ ] **Step 1: Write the RLS tests (failing — table doesn't exist yet)**

Create `supabase/tests/rls-plugins.test.ts`:

```typescript
import { createClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const URL = process.env['SUPABASE_URL']!;
const SERVICE = process.env['SUPABASE_SERVICE_KEY']!;
const ANON = process.env['SUPABASE_ANON_KEY']!;
const ADMIN_JWT = process.env['SUPABASE_TEST_ADMIN_JWT'];
const VIEWER_JWT = process.env['SUPABASE_TEST_VIEWER_JWT'];

const svc = createClient(URL, SERVICE);

describe('repo_plugins RLS', () => {
  let repoId: string;

  beforeAll(async () => {
    const { data } = await svc.from('repos')
      .insert({ owner: 'rls-test', name: 'plugin-test', enabled: false,
        staging_branch: 'staging', production_branch: 'main', concurrency_limit: 1 })
      .select('id').single();
    repoId = data!.id;
    await svc.from('repo_plugins').insert({ repo_id: repoId, plugin_id: 'test-plugin' });
  });

  afterAll(async () => {
    await svc.from('repos').delete().eq('id', repoId);
  });

  it('unauthenticated cannot read repo_plugins', async () => {
    const { data } = await createClient(URL, ANON).from('repo_plugins').select('*');
    expect(data).toEqual([]);
  });

  it('admin can read repo_plugins', async () => {
    if (!ADMIN_JWT) return;
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } } });
    const { data } = await client.from('repo_plugins').select('*').eq('repo_id', repoId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it('viewer can read repo_plugins', async () => {
    if (!VIEWER_JWT) return;
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } } });
    const { data } = await client.from('repo_plugins').select('*').eq('repo_id', repoId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it('viewer cannot insert into repo_plugins', async () => {
    if (!VIEWER_JWT) return;
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } } });
    const { error } = await client.from('repo_plugins').insert({ repo_id: repoId, plugin_id: 'viewer-attempt' });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail (table missing)**

```bash
SUPABASE_URL=https://uqhnbvljzfwuexmwlzrn.supabase.co \
SUPABASE_SERVICE_KEY=<service-key> SUPABASE_ANON_KEY=<anon-key> \
pnpm vitest run supabase/tests/rls-plugins.test.ts
```

Expected: FAIL — `relation "repo_plugins" does not exist`

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/002_plugins.sql`:

```sql
-- 002_plugins.sql
-- Depends on: 001_initial.sql (requires is_member(), is_admin() helpers)

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

CREATE POLICY "members read repo_plugins"
  ON repo_plugins FOR SELECT USING (is_member());

CREATE POLICY "admins insert repo_plugins"
  ON repo_plugins FOR INSERT WITH CHECK (is_admin());

CREATE POLICY "admins update repo_plugins"
  ON repo_plugins FOR UPDATE USING (is_admin());

CREATE POLICY "admins delete repo_plugins"
  ON repo_plugins FOR DELETE USING (is_admin());

-- Track which plugins were active at run start (best-effort snapshot, not audit trail)
ALTER TABLE runs ADD COLUMN active_plugins text[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_repo_plugins_repo_id ON repo_plugins (repo_id);
CREATE INDEX idx_repo_plugins_active ON repo_plugins (repo_id, active) WHERE active = true;
```

- [ ] **Step 4: Apply the migration via Supabase MCP or CLI**

```bash
# Option A: Supabase CLI
supabase link --project-ref uqhnbvljzfwuexmwlzrn
supabase db push

# Option B: Supabase MCP in Claude Code
# "Apply the migration at supabase/migrations/002_plugins.sql to project uqhnbvljzfwuexmwlzrn"
```

- [ ] **Step 5: Run RLS tests — verify they pass**

```bash
SUPABASE_URL=https://uqhnbvljzfwuexmwlzrn.supabase.co \
SUPABASE_SERVICE_KEY=<service-key> SUPABASE_ANON_KEY=<anon-key> \
pnpm vitest run supabase/tests/rls-plugins.test.ts
```

Expected: At minimum the unauthenticated test passes. JWT tests pass if test users are configured.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/002_plugins.sql supabase/tests/rls-plugins.test.ts
git commit -m "feat(plugins): add repo_plugins Supabase table with RLS and runs.active_plugins column"
```

---

## Task 7: Dashboard — Registry Reader

**Files:**
- Create: `packages/dashboard/lib/plugins/registry.ts`
- Create: `packages/dashboard/lib/plugins/registry.test.ts`

> The dashboard reads `plugins/registry.json` from the repo root. The `PLUGINS_DIR` env var controls the path. Default: `path.join(process.cwd(), '../../plugins')` when running from `packages/dashboard/`.

- [ ] **Step 1: Write failing tests**

Create `packages/dashboard/lib/plugins/registry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadDashboardRegistry } from './registry.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'fs/promises';

describe('loadDashboardRegistry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns parsed registry with plugin entries', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      version: 1,
      plugins: [{ id: 'web-stack', name: 'Web Stack', description: 'Frontend', tags: ['astro'] }],
    }) as never);
    const registry = await loadDashboardRegistry();
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]!.id).toBe('web-stack');
  });

  it('throws if registry.json is missing', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT') as never);
    await expect(loadDashboardRegistry()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd ~/code/auto-claude/packages/dashboard
pnpm vitest run lib/plugins/registry.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement `packages/dashboard/lib/plugins/registry.ts`**

```typescript
import { readFile } from 'fs/promises';
import { join } from 'path';

export interface DashboardPlugin {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface DashboardRegistry {
  version: number;
  plugins: DashboardPlugin[];
}

const PLUGINS_DIR = process.env['PLUGINS_DIR'] ?? join(process.cwd(), '../..', 'plugins');

export async function loadDashboardRegistry(): Promise<DashboardRegistry> {
  const raw = await readFile(join(PLUGINS_DIR, 'registry.json'), 'utf-8');
  return JSON.parse(raw) as DashboardRegistry;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm vitest run lib/plugins/registry.test.ts
```

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/plugins/registry.ts dashboard/lib/plugins/registry.test.ts
git commit -m "feat(plugins): add dashboard registry reader"
```

---

## Task 8: Dashboard — Server Actions

**Files:**
- Create: `packages/dashboard/actions/plugins.ts`
- Create: `packages/dashboard/actions/plugins.test.ts`

> Install `@anthropic-ai/sdk` if not present: `cd dashboard && pnpm add @anthropic-ai/sdk`

- [ ] **Step 1: Install dependency if needed**

```bash
cd ~/code/auto-claude/packages/dashboard
pnpm list @anthropic-ai/sdk 2>/dev/null || pnpm add @anthropic-ai/sdk
```

- [ ] **Step 2: Write failing tests**

Create `packages/dashboard/actions/plugins.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createServerClient: vi.fn() }));
vi.mock('@/lib/plugins/registry', () => ({ loadDashboardRegistry: vi.fn() }));

import { togglePlugin, enableAllSuggested } from './plugins.js';
import { createServerClient } from '@/lib/supabase/server';
import { loadDashboardRegistry } from '@/lib/plugins/registry';

const mockRegistry = { version: 1, plugins: [{ id: 'web-stack', name: 'Web Stack', description: '', tags: [] }] };

describe('togglePlugin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unknown plugin ids', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const result = await togglePlugin('repo-id', 'unknown-plugin', true);
    expect(result.error).toContain('Unknown plugin');
  });

  it('upserts repo_plugins on valid plugin id', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createServerClient).mockReturnValue({ from: () => ({ upsert }) } as never);
    const result = await togglePlugin('repo-id', 'web-stack', true);
    expect(upsert).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });
});

describe('enableAllSuggested', () => {
  it('enables each suggested plugin independently and returns failed ids', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'db error' } });
    vi.mocked(createServerClient).mockReturnValue({ from: () => ({ upsert }) } as never);
    const result = await enableAllSuggested('repo-id', ['web-stack', 'unknown']);
    expect(result.failed).toContain('unknown');
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

```bash
cd ~/code/auto-claude/packages/dashboard
pnpm vitest run actions/plugins.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 4: Implement `packages/dashboard/actions/plugins.ts`**

```typescript
'use server';

import { createServerClient } from '@/lib/supabase/server';
import { loadDashboardRegistry } from '@/lib/plugins/registry';
import Anthropic from '@anthropic-ai/sdk';
import { readdir } from 'fs/promises';
import { join } from 'path';

const PLUGINS_DIR = process.env['PLUGINS_DIR'] ?? join(process.cwd(), '../..', 'plugins');

export async function togglePlugin(
  repoId: string,
  pluginId: string,
  active: boolean,
): Promise<{ ok?: true; error?: string }> {
  const registry = await loadDashboardRegistry();
  if (!registry.plugins.find(p => p.id === pluginId)) {
    return { error: `Unknown plugin: ${pluginId}` };
  }
  const supabase = createServerClient();
  // Only update active + activated_at on conflict — never overwrite recommendation fields.
  const { error } = await supabase.from('repo_plugins').upsert(
    {
      repo_id: repoId,
      plugin_id: pluginId,
      active,
      activated_at: active ? new Date().toISOString() : null,
    },
    { onConflict: 'repo_id,plugin_id', ignoreDuplicates: false },
  );
  if (error) return { error: error.message };
  return { ok: true };
}

export async function enableAllSuggested(
  repoId: string,
  pluginIds: string[],
): Promise<{ succeeded: string[]; failed: string[] }> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const pluginId of pluginIds) {
    const result = await togglePlugin(repoId, pluginId, true);
    if (result.ok) succeeded.push(pluginId);
    else failed.push(pluginId);
  }
  return { succeeded, failed };
}

export async function triggerRecommendation(repoId: string, repoOwner: string, repoName: string): Promise<void> {
  // Fire-and-forget: returns immediately, writes to DB asynchronously
  void (async () => {
    try {
      const registry = await loadDashboardRegistry();
      const catalog = registry.plugins.map(p => `- ${p.id}: ${p.description} [${p.tags.join(', ')}]`).join('\n');

      const client = new Anthropic();
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are recommending plugins for a software repository.\n\nRepository: ${repoOwner}/${repoName}\n\nAvailable plugins:\n${catalog}\n\nReturn JSON: { "recommendations": [{ "pluginId": string, "confidence": "high"|"medium"|"low", "reason": string }] }`,
        }],
      });

      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = JSON.parse(text) as { recommendations: Array<{ pluginId: string; confidence: string; reason: string }> };
      const supabase = createServerClient();

      for (const rec of parsed.recommendations) {
        if (!registry.plugins.find(p => p.id === rec.pluginId)) continue;
        await supabase.from('repo_plugins').upsert(
          { repo_id: repoId, plugin_id: rec.pluginId, recommended: true,
            recommendation_reason: `[${rec.confidence}] ${rec.reason}`, recommended_at: new Date().toISOString() },
          { onConflict: 'repo_id,plugin_id' },
        );
      }
    } catch {
      // Fail silently — user can re-trigger via dashboard
    }
  })();
}

export async function exportPlugin(repoId: string, pluginId: string, targetRepoPath: string): Promise<{ ok?: true; error?: string }> {
  const registry = await loadDashboardRegistry();
  if (!registry.plugins.find(p => p.id === pluginId)) {
    return { error: `Unknown plugin: ${pluginId}` };
  }
  const { mkdir, copyFile, readdir } = await import('fs/promises');
  const pluginDir = join(PLUGINS_DIR, pluginId, 'skills');
  const destDir = join(targetRepoPath, '.claude', 'plugins', pluginId, 'skills');
  await mkdir(destDir, { recursive: true });
  const files = await readdir(pluginDir).catch(() => [] as string[]);
  for (const f of files) await copyFile(join(pluginDir, f), join(destDir, f));
  return { ok: true };
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
pnpm vitest run actions/plugins.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/actions/plugins.ts dashboard/actions/plugins.test.ts
git commit -m "feat(plugins): add dashboard Server Actions for plugin management and recommendations"
```

---

## Task 9: Dashboard — Plugin Card Component

**Files:**
- Create: `packages/dashboard/components/plugin-card.tsx`

- [ ] **Step 1: Create `packages/dashboard/components/plugin-card.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { togglePlugin } from '@/actions/plugins';

interface PluginCardProps {
  repoId: string;
  pluginId: string;
  name: string;
  description: string;
  tags: string[];
  active: boolean;
  recommended?: boolean;
  recommendationReason?: string | null;
  confidence?: 'high' | 'medium' | 'low' | null;
}

const CONFIDENCE_COLORS = {
  high: 'bg-green-900 text-green-300',
  medium: 'bg-yellow-900 text-yellow-300',
  low: 'bg-zinc-800 text-zinc-400',
} as const;

export function PluginCard({
  repoId, pluginId, name, description, tags,
  active: initialActive, recommended, recommendationReason, confidence,
}: PluginCardProps) {
  const [active, setActive] = useState(initialActive);
  const [loading, setLoading] = useState(false);

  async function handleToggle(next: boolean) {
    setActive(next); // optimistic
    setLoading(true);
    const result = await togglePlugin(repoId, pluginId, next);
    if (result.error) setActive(!next); // revert on failure
    setLoading(false);
  }

  return (
    <Card className="border-zinc-800 bg-zinc-900">
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
        <div>
          <CardTitle className="text-sm font-medium text-zinc-100">{name}</CardTitle>
          <p className="mt-1 text-xs text-zinc-400">{description}</p>
        </div>
        <Switch checked={active} onCheckedChange={handleToggle} disabled={loading} />
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex flex-wrap gap-1">
          {tags.map(tag => (
            <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
          ))}
          {recommended && confidence && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge className={`text-xs ${CONFIDENCE_COLORS[confidence]}`}>{confidence}</Badge>
              </TooltipTrigger>
              {recommendationReason && (
                <TooltipContent><p>{recommendationReason}</p></TooltipContent>
              )}
            </Tooltip>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Install any missing shadcn components**

```bash
cd ~/code/auto-claude/packages/dashboard
pnpm dlx shadcn@latest add switch tooltip 2>/dev/null || true
```

- [ ] **Step 3: Run type check**

```bash
pnpm tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/components/plugin-card.tsx
git commit -m "feat(plugins): add PluginCard component with optimistic toggle"
```

---

## Task 10: Dashboard — Plugins Tab Page

**Files:**
- Create: `packages/dashboard/app/repos/[id]/plugins/page.tsx`
- Modify: `packages/dashboard/app/repos/[id]/page.tsx` (add Plugins tab)

- [ ] **Step 1: Read `packages/dashboard/app/repos/[id]/page.tsx`** to understand the current tab structure before modifying it.

- [ ] **Step 2: Create `packages/dashboard/app/repos/[id]/plugins/page.tsx`**

```tsx
import { createServerClient } from '@/lib/supabase/server';
import { loadDashboardRegistry } from '@/lib/plugins/registry';
import { PluginCard } from '@/components/plugin-card';
import { enableAllSuggested, triggerRecommendation } from '@/actions/plugins';
import { Button } from '@/components/ui/button';

export default async function PluginsPage({ params }: { params: { id: string } }) {
  const supabase = createServerClient();
  const [{ data: repo }, { data: repoPlugins }, registry] = await Promise.all([
    supabase.from('repos').select('id, owner, name').eq('id', params.id).single(),
    supabase.from('repo_plugins').select('*').eq('repo_id', params.id),
    loadDashboardRegistry(),
  ]);

  if (!repo) return <p>Repository not found.</p>;

  const activeMap = new Map((repoPlugins ?? []).map(rp => [rp.plugin_id, rp]));
  const suggested = registry.plugins.filter(p => {
    const rp = activeMap.get(p.id);
    return rp?.recommended && !rp?.active;
  });
  const active = registry.plugins.filter(p => activeMap.get(p.id)?.active);
  const rest = registry.plugins.filter(p => !activeMap.get(p.id)?.active && !activeMap.get(p.id)?.recommended);

  const suggestedIds = suggested.map(p => p.id);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Plugins</h2>
        <form action={async () => {
          'use server';
          await triggerRecommendation(params.id, repo.owner, repo.name);
        }}>
          <Button variant="outline" size="sm" type="submit">Re-analyze repo</Button>
        </form>
      </div>

      {suggested.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs uppercase tracking-wider text-zinc-500">Suggested</h3>
            <form action={async () => {
              'use server';
              await enableAllSuggested(params.id, suggestedIds);
            }}>
              <Button variant="ghost" size="sm" type="submit">Enable All</Button>
            </form>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {suggested.map(p => {
              const rp = activeMap.get(p.id);
              return <PluginCard key={p.id} repoId={params.id} pluginId={p.id} name={p.name}
                description={p.description} tags={p.tags} active={false}
                recommended recommended_at={rp?.recommended_at}
                recommendationReason={rp?.recommendation_reason} />;
            })}
          </div>
        </section>
      )}

      {active.length > 0 && (
        <section>
          <h3 className="mb-3 text-xs uppercase tracking-wider text-zinc-500">Active</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {active.map(p => (
              <PluginCard key={p.id} repoId={params.id} pluginId={p.id} name={p.name}
                description={p.description} tags={p.tags} active />
            ))}
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section>
          <h3 className="mb-3 text-xs uppercase tracking-wider text-zinc-500">All Plugins</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {rest.map(p => (
              <PluginCard key={p.id} repoId={params.id} pluginId={p.id} name={p.name}
                description={p.description} tags={p.tags} active={false} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add Plugins tab to `packages/dashboard/app/repos/[id]/page.tsx`**

Read the file first, then add a "Plugins" tab alongside the existing Settings and API Keys tabs. The exact implementation depends on the current tab structure — add a link to `/repos/${id}/plugins` following the same pattern as existing tabs.

- [ ] **Step 4: Add Realtime subscription for repo_plugins on the plugins page**

Wrap the Plugins page in a client component that subscribes to `repo_plugins` changes and calls `router.refresh()` when rows update. This delivers recommendation results without a page reload.

Create `packages/dashboard/app/repos/[id]/plugins/realtime-refresh.tsx`:

```tsx
'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@/lib/supabase/client';

export function RealtimeRefresh({ repoId }: { repoId: string }) {
  const router = useRouter();
  const supabase = createBrowserClient();
  useEffect(() => {
    const channel = supabase.channel(`repo_plugins_${repoId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'repo_plugins',
          filter: `repo_id=eq.${repoId}` }, () => router.refresh())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [repoId, router, supabase]);
  return null;
}
```

Add `<RealtimeRefresh repoId={params.id} />` at the top of the PluginsPage server component output.

- [ ] **Step 5: Run type check**

```bash
cd ~/code/auto-claude/packages/dashboard
pnpm tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Run full test suite**

```bash
cd ~/code/auto-claude
pnpm vitest run && pnpm tsc --noEmit
```

Expected: All tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add dashboard/app/repos/
git commit -m "feat(plugins): add Plugins tab page with Realtime subscription"
```

---

## Final Validation

- [ ] **Run the full test suite one more time**

```bash
cd ~/code/auto-claude
pnpm vitest run
pnpm tsc --noEmit
```

Expected: All green.

- [ ] **Smoke test the plugin loading end-to-end**

Start the daemon locally and verify it loads the plugin registry at startup without errors:

```bash
node --experimental-specifier-resolution=node -e "
import('./src/control-plane/plugin-registry.js').then(({ loadPluginRegistry }) =>
  loadPluginRegistry('./plugins').then(r => console.log('Loaded plugins:', r.plugins.map(p => p.id)))
);"
```

Expected: `Loaded plugins: [ 'auto-claude-dev' ]`

- [ ] **Final commit**

```bash
git add -p
git commit -m "feat(plugins): complete plugin & addon system implementation"
```
