---
id: STACK-AC-PLUGINS-DAEMON
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-PLUGINS
code_paths:
  - auto-claude/plugins/
  - src/control-plane/plugin-registry.ts
  - src/session-runtime/plugin-injection.ts
test_paths:
  - src/control-plane/plugin-registry.test.ts
  - src/session-runtime/plugin-injection.test.ts
---

# STACK-AC-PLUGINS-DAEMON — Plugin Registry & Session Injection (TypeScript)

## Pattern

**Startup-validated filesystem registry.** The plugin catalog is a `registry.json` file alongside plugin directories in `auto-claude/plugins/`. On daemon startup, the registry is loaded, each entry is cross-validated against the filesystem (directory exists, `manifest.json` present with required fields), and the result is cached in memory for the lifetime of the process. No database round trip is needed to serve the catalog — plugins are code-owned, not operator-configured.

**Ordered-merge CompositeContext assembly.** At session spawn time, active plugin identifiers (from cached repo config) are resolved against the in-memory registry. Content is merged in `activated_at` ascending order. Filename collisions resolve to first-activated. A token-budget guard truncates by priority (prompt-injection preserved, skills before agents, last-activated first) if the combined content exceeds 20,000 tokens.

## Key Decisions

**Filesystem JSON over database for the catalog.** Plugin definitions are versioned with the daemon codebase — they change when the daemon is deployed, not when an operator clicks a button. Storing them in the database would require a migration on every plugin update and a sync mechanism between code and DB state. A filesystem registry avoids both. The tradeoff: the registry can drift from `repo_plugins` rows if a plugin is removed from the codebase; the daemon handles this gracefully by skipping orphaned identifiers at spawn time.

**In-memory cache for registry and config.** The plugin registry is small (tens of entries) and static for the lifetime of a process. Reading it from disk on every session spawn would add file I/O per session. Caching at startup costs nothing and eliminates the I/O. Active plugin identifiers per repo are cached as part of the existing config sync result — no separate cache is needed.

**`activated_at` order for deterministic merge.** Multiple active plugins may contribute skills with the same filename. Rather than failing or logging ambiguity, the daemon resolves collisions by choosing the plugin activated first. This is predictable and admin-controllable: the admin can deactivate and reactivate a plugin to change its priority.

## Examples

Registry validation at startup — reject any entry that lacks a directory or required manifest fields:

```typescript
for (const entry of registry.plugins) {
  const dir = path.join(PLUGINS_DIR, entry.id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (!manifest.id || !manifest.name || !manifest.version || !manifest.description) {
    throw new Error(`Plugin ${entry.id}: manifest missing required fields`);
  }
}
```

Token-budget guard — truncate skills from last-activated plugins first, preserving prompt-injection:

```typescript
while (tokenCount(ctx) > TOKEN_BUDGET) {
  const dropped = ctx.skills.pop(); // last-activated skill first
  if (!dropped) break;
  log.warn(`plugin budget exceeded — dropped skill: ${dropped.pluginId}/${dropped.name}`);
}
```

## Gotchas

**Orphaned `repo_plugins` rows.** If a plugin directory is removed from the codebase after rows exist in the database, the daemon will encounter identifiers not in its registry at spawn time. These must be skipped with a warning — never crash the session. The `togglePlugin` Server Action also validates against the registry before writing, preventing new orphaned rows from being created.

**File reads during assembly add latency.** Skill and agent documents are read from disk at spawn time, not cached. For repos with many active plugins, this adds file I/O per session. If this becomes a bottleneck, skill content can be cached in the startup registry load — but measure first.

**Token counting is an estimate.** Exact token counts require a tokenizer call. Use a character-based heuristic (divide by 4) for the budget guard. The 20,000-token cap should be set conservatively enough that the heuristic never silently exceeds the true limit.
