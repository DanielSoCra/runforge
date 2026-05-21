---
id: STACK-AC-KNOWLEDGE-SYNC
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-KNOWLEDGE-SYNC
code_paths: []  # planned: packages/daemon/src/knowledge-sync/
test_paths: []  # planned: packages/daemon/src/knowledge-sync/**/*.test.ts
---

# STACK-AC-KNOWLEDGE-SYNC — Knowledge Sync Service (TypeScript)

## Pattern

**Manifest-driven read-only import.** On each cycle, read a YAML frontmatter file at a fixed vault-relative path, validate with Zod, and drive the entire import from its declared `importSources`. No vault structure is hardcoded in source — the manifest is the only source of structural knowledge.

**Content-hash deduplication via append-only JSONL registry.** Before importing a document, compute a deterministic SHA-256 hash of its normalized content (sorted artifact patterns + description). Check against `state/knowledge-sync-registry.jsonl`. Skip on hit; append entry on miss.

**Single-active-cycle guard via module-level flag.** A module-level `let syncInProgress = false` prevents concurrent cycles. Trigger arrivals during an active cycle are dropped with a warning log. The flag is always reset in a `finally` block.

**Config-optional, opt-in by default.** If `config.knowledgeSync` is absent or `enabled: false`, `triggerSync()` returns a no-op `SyncRun` immediately. Sync is never on by default — operators must explicitly enable it.

## Key Decisions

**Manifest file: `00-Meta/auto-claude-sync.md` within the vault root.** Chosen as a Markdown file to be a first-class vault note (discoverable and editable in Obsidian). The YAML frontmatter carries the structured `importSources` array; the body may contain human-readable notes and is ignored by the sync service.

**Frontmatter parsing: `gray-matter`.** Chosen over manual regex (fragile on multi-line YAML values) and `js-yaml` alone (doesn't strip the Markdown body). The manifest is parsed once per cycle; parsing cost is negligible.

**VaultAccessManifest Zod schema.** The manifest frontmatter is validated with Zod immediately after parsing. Invalid manifests abort the cycle with `status: 'failed'` — the service never falls back to assumed structure.

```typescript
// Key fields — confidence and artifact_patterns are optional (manifest-level defaults)
const ImportSource = z.object({
  name: z.string(), relativePath: z.string(),
  recordType: RecordType, recursion: z.enum(['top-level-only', 'recursive']),
  confidence: z.number().min(0).max(1).optional(),
});
```

**File enumeration: `fs.readdir` with `{ recursive: true }` (Node 22+).** No `glob` library needed — Node 22 native recursive readdir returns all descendants. Filter by `.md` extension after enumeration. `top-level-only` uses non-recursive `readdir`.

```typescript
const entries = await readdir(absPath, { recursive: policy === 'recursive' });
const files = entries.filter(e => e.endsWith('.md'));
```

**Content hash: SHA-256 of sorted artifact patterns + description.** Normalized input: `[...patterns].sort().join(',') + '|' + description.trim()`. Sorting ensures `['a','b']` and `['b','a']` collide correctly.

```typescript
const input = [...artifactPatterns].sort().join(',') + '|' + description.trim();
return createHash('sha256').update(input, 'utf8').digest('hex');
```

**SyncHashRegistry: JSONL at `state/knowledge-sync-registry.jsonl`.** Append-only; each entry is a `SyncHashEntry` validated by Zod on read (malformed lines skipped per STACK-AC-CONVENTIONS). On read failure of the entire file, treat as empty — the Knowledge Service's own dedup handles true duplicates for that cycle.

```typescript
const SyncHashEntry = z.object({
  id: z.string(), contentHash: z.string(),
  sourceName: z.string(), vaultDocumentRef: z.string(), syncedAt: z.string(),
});
```

**SyncRun history: JSONL at `state/knowledge-sync-runs.jsonl`.** Append-only; one record per completed cycle. `getSyncHistory(limit = 10)` reads all lines, reverses (newest first), and returns up to `limit` entries.

**Config extension (owned by STACK-AC-CONVENTIONS `config.ts`).** Add optional `knowledgeSync` section to the root Zod config schema. `enabled` defaults to `false` — sync is opt-in:

```typescript
knowledgeSync: z.object({
  enabled: z.boolean().default(false),
  vaultPath: z.string(),
  syncIntervalMinutes: z.number().int().positive().default(60),
}).optional(),
```

**Schedule wiring (owned by STACK-AC-CONTROL-PLANE).** On daemon startup, if `config.knowledgeSync?.enabled`, the Control Plane calls `setInterval(() => triggerSync(), intervalMs)` and stores the handle for `clearInterval` on graceful shutdown. The sync service only exports `triggerSync()` and `getSyncHistory()` — schedule ownership stays with the Control Plane.

**`relativePath` isolation check.** Before enumerating, resolve `path.resolve(vaultRoot, importSource.relativePath)` and verify it starts with `path.resolve(vaultRoot)`. Paths containing `..` traversal sequences that escape the vault root are rejected as a manifest error (increment error count, skip source, log).

**VaultDocument reference: vault-root-relative path.** The stable identifier for a document is its path relative to the vault root (e.g., `20-Areas/Engineering/Mistakes/my-note.md`). Built from the resolved absolute path stripped of the vault root prefix.

**L3 defaults for missing frontmatter fields.** When a vault document's frontmatter omits `confidence` and the manifest ImportSource also omits it, the L3 default is `0.5`. When `artifact_patterns` is absent from both, the L3 default is `[]` (empty array) — the record is stored but never injected (matches no artifact paths). The `document-mapper.ts` applies these fallbacks after consulting the manifest-level defaults.

## Examples

```typescript
// Manifest read + validate — abort cycle on failure
const raw = await readFile(manifestPath, 'utf-8');
const { data } = matter(raw);
const manifest = VaultAccessManifest.safeParse(data);
if (!manifest.success) return failedRun('Manifest parse error: ' + manifest.error.message);
```

```typescript
// Concurrency guard — always release in finally
if (syncInProgress) { log.warn('sync already in progress, skipping'); return; }
syncInProgress = true;
try { return await runCycle(config); } finally { syncInProgress = false; }
```

```typescript
// SyncRun status derivation from counters
const status = result.storeErrors > 0 && result.created === 0 ? 'failed'
  : result.storeErrors > 0 ? 'partial' : 'success';
```

```typescript
// Document reference — vault-root-relative path
const vaultDocumentRef = absFilePath.slice(path.resolve(vaultPath).length + 1);
```

## Gotchas

- `gray-matter` returns `data: {}` when the file has no frontmatter — always run Zod validation, never assume structure.
- `fs.readdir` with `{ recursive: true }` returns paths relative to the scanned directory in Node 22 — join with the base path to get absolute paths.
- SHA-256 normalization: use `.trim()` on the description to avoid hash mismatches caused by trailing whitespace in vault documents.
- `syncInProgress` must be reset in a `finally` block — an uncaught error would leave it permanently true, silently dropping all future sync triggers.
- `getSyncHistory` reverse order: JSONL is append-only so oldest entries are first. Reverse the parsed array before slicing to `limit`.
- Path traversal: always check the resolved path starts with the resolved vault root before opening any file. Never trust `relativePath` values from the manifest without this check.
- JSONL registry read: skip malformed lines silently (consistent with STACK-AC-CONVENTIONS). A partially corrupted registry is acceptable — worst case is one extra import cycle for affected documents; the Knowledge Service dedup prevents true duplicates in the knowledge store.
- On `VaultAccessManifest` missing (file not found): return `status: 'failed'` with a descriptive error. Do NOT fall back to any assumed vault layout — this is intentional loud failure per ARCH-AC-KNOWLEDGE-SYNC.
- `syncIntervalMinutes` schedule: multiply by `60_000` for `setInterval`. Store the `NodeJS.Timeout` handle so `clearInterval` can stop it during graceful shutdown (`SIGTERM`/`SIGINT`).
- Manifest `importSources` may reference the same `name` more than once — validate uniqueness of `name` field in the Zod schema (`.refine`) or at the caller. Duplicate names would produce ambiguous `sourceName` values in the registry.
