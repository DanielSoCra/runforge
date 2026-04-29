---
id: STACK-AC-CONTAINMENT
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-CONTAINMENT
code_paths:
  - packages/daemon/src/session-runtime/scope-registry.ts
  - packages/daemon/src/session-runtime/scope-audit.ts
  - packages/daemon/src/session-runtime/scope-enforcement.ts
test_paths:
  - packages/daemon/src/session-runtime/scope-registry.test.ts
  - packages/daemon/src/session-runtime/scope-audit.test.ts
  - packages/daemon/src/session-runtime/scope-enforcement.test.ts
---

# STACK-AC-CONTAINMENT — Directory-Level Permission Sandboxing (TypeScript)

## Pattern

**ScopeRegistry as an immutable Map built at startup.** Loaded from `config.agentScopes` (a plain object keyed by agent type name) and merged with built-in defaults. The Map is frozen after construction and never mutated — on explicit reload, a new Map replaces the old one atomically. Synchronous lookup, no async path resolution needed.

**Scope resolution as a pure function.** `resolveScope(agentType, policy)` returns a merged `DirectoryScope` without side effects. Per-agent deny paths are unioned with `ContainmentPolicy.prohibitedPaths`; system-wide denials always take precedence. If no registry entry exists for the agent type, the built-in default is used and a warning is logged — the session is not blocked.

**Reviewer pattern matching via linear scan.** Exact Map lookups fail for `reviewer-quality` against a `reviewer-*` key. `resolveScope` first attempts an exact lookup, then falls back to a linear scan using `micromatch.isMatch(agentType, key)` over registry keys. Built-in defaults include a `reviewer-*` entry with an empty `writePaths` array.

**CLI enforcement via injected workspace settings.** Before spawning, `applyCliScope` writes a `.claude/settings.json` fragment into the workspace encoding `permissions.deny` entries for denied paths. If a project-level settings file already exists, the deny entries are merged into it rather than overwriting. The file lives inside the Docker container and is destroyed with it after the session.

**SDK enforcement via pre-tool-use hook.** `makeSdkScopeHook(scope)` returns a `BeforeToolUseHook` callback registered on the SDK session. For write tools (`Write`, `Edit`, `Bash` with file-mutating commands), the hook checks the target path against `writePaths` and `denyPaths`. Rejections return an explicit `{ block: true, reason: 'scope-violation: ...' }` — never silent.

**Post-session audit via git diff against base commit.** Before spawning, capture `git rev-parse HEAD` in the workspace as the base commit. After session completion, `auditScope` runs `git diff --name-only <baseCommit>..HEAD` to enumerate all files modified or added during the session. Each path is evaluated against the resolved `DirectoryScope`. Violations produce `ViolationRecord` entries; the function returns a `ScopeAuditResult` (Result type, consistent with STACK-AC-CONVENTIONS).

## Key Decisions

**Path matching: micromatch.** Consistent with the existing containment hook shell scripts (which use glob patterns). `micromatch.isMatch(filePath, patterns)` handles `src/**`, `**/*.lock`, and glob negations uniformly. Chosen over minimatch (less active maintenance) and manual prefix checks (breaks on dotfiles and relative paths).

**ViolationRecord and ScopeAuditResult are plain objects.** No class hierarchy. `ViolationRecord` carries: `sessionId`, `agentType`, `path`, `violationType: 'write-outside-permitted' | 'access-to-denied' | 'audit-unavailable'`, `detectionLayer: 'pre-execution' | 'post-session'`, and `timestamp`. `ScopeAuditResult` is `Result<void, ViolationRecord[]>` using the project's Result type.

**Built-in default scopes declared as a frozen `const` in scope-registry.ts.** Three entries: `worker-implement` (writePaths: `['src/**', 'packages/**', 'tests/**']`, denyPaths: `['.specify/scenarios/**', '.specify/methodology/**']`), `reviewer-*` (writePaths: `[]`, denyPaths: `[]`), `merge-agent` (writePaths: `['.github/**', 'package.json', '**/*.lock']`, denyPaths: `['src/**', '.specify/**']`).

**Scope violation signal: extend `SessionError` with `scopeViolation` flag.** Consistent with how STACK-AC-OPERATIONAL-SAFETY handles `containmentBreach` and `rateLimited` — a typed flag on `SessionError` read by the Daemon Control Plane. The run transitions to `stuck` with a `scope-violation` note. Implementation of `session-runtime/runtime.ts` must wire `ScopeAuditResult` failures into this signal path.

**Workspace settings merge: shallow merge of `permissions.deny` array.** Read existing `.claude/settings.json` (if present), append new deny entries, write back atomically using `writeJsonSafe`. If the file is malformed, log a warning and write a fresh settings file — do not abort the session for a malformed settings file.

## Examples

```typescript
// DirectoryScope type and ScopeRegistry construction
interface DirectoryScope { readPaths: string[]; writePaths: string[]; denyPaths: string[] }
type ScopeRegistry = ReadonlyMap<string, DirectoryScope>;
function buildRegistry(config: AgentScopesConfig): ScopeRegistry {
  const entries = Object.entries({ ...DEFAULT_SCOPES, ...config });
  return new Map(entries) as ScopeRegistry;
}
```

```typescript
// Scope resolution — exact lookup, then glob scan, then warn + empty
function resolveScope(type: string, policy: ContainmentPolicy): DirectoryScope {
  const base = registry.get(type) ?? scanByGlob(registry, type) ?? warnAndEmpty(type);
  return { ...base, denyPaths: [...base.denyPaths, ...policy.prohibitedPaths] };
}
```

```typescript
// CLI enforcement — merge deny rules into workspace settings
async function applyCliScope(workspacePath: string, scope: DirectoryScope): Promise<void> {
  const settingsPath = path.join(workspacePath, '.claude/settings.json');
  const existing = await readJsonSafe<ClaudeSettings>(settingsPath) ?? {};
  const merged = { ...existing, permissions: { deny: [...(existing.permissions?.deny ?? []), ...scope.denyPaths] } };
  await writeJsonSafe(settingsPath, merged);
}
```

```typescript
// SDK enforcement — pre-tool-use hook rejects writes outside scope
function makeSdkScopeHook(scope: DirectoryScope): BeforeToolUseHook {
  return ({ toolName, input }) => {
    if (!WRITE_TOOLS.has(toolName)) return { block: false };
    return checkWriteScope(input.file_path ?? '', scope) ?? { block: false };
  };
}
```

```typescript
// Post-session audit — git diff → ViolationRecord list
async function auditScope(workspace: Workspace, scope: DirectoryScope): Promise<ScopeAuditResult> {
  const diff = await git(['diff', '--name-only', `${workspace.baseCommit}..HEAD`], workspace.path);
  if (!diff.ok) return { ok: false, error: [auditUnavailableRecord(workspace)] };
  const violations = diff.value.split('\n').filter(Boolean).flatMap(p => checkFilePath(p, scope));
  return violations.length === 0 ? { ok: true, value: undefined } : { ok: false, error: violations };
}
```

## Gotchas

- `micromatch` patterns must include `**/` prefix to match nested paths. `src/**` matches `src/components/foo.ts` but not an absolute path starting with `/workspace/src/`. Normalize all paths to be relative to the workspace root before matching.
- `git diff --name-only <base>..HEAD` requires at least one commit in the session. If the agent made no commits (only staged changes), use `git diff --name-only HEAD` for unstaged changes and `git diff --name-only --cached HEAD` for staged ones. Combine both sets before evaluating.
- The `.claude/settings.json` written into the workspace must survive the session's own file writes. If the agent happens to overwrite `.claude/settings.json`, the deny rules are lost for the remainder of the session. This is acceptable — the post-session audit (detective layer) catches violations regardless. Do not attempt to re-apply settings mid-session.
- The `reviewer-*` glob key in `DEFAULT_SCOPES` is not a valid Map key for exact lookup. `scanByGlob` must iterate over Map keys and test each with `micromatch.isMatch(agentType, key)`. Iteration order matters: more specific keys (exact matches) must be checked before glob keys to avoid a broad glob shadowing a specific override.
- `workspace.baseCommit` must be captured before spawning the session, not after. If captured after a crash and restart, the base may have advanced, causing the audit to miss pre-restart writes. Persist `baseCommit` alongside the run state in `state/runs/<id>.json`.
- When merging into an existing `.claude/settings.json`, avoid duplicating deny entries across sessions on the same workspace (unlikely given single-use containers, but defensive). Deduplicate the `permissions.deny` array before writing.
