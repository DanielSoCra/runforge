---
id: STACK-AC-CONVENTIONS
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: L0-AC-VISION
code_paths:
  - packages/daemon/src/types.ts
  - packages/daemon/src/main.ts
  - packages/daemon/src/config.ts
  - packages/daemon/src/lib/
test_paths:
  - packages/daemon/src/**/*.test.ts
---

# STACK-AC-CONVENTIONS — Cross-Cutting TypeScript Patterns

## Pattern

All services share a common runtime, persistence strategy, error handling pattern, and project structure. This spec defines those conventions so individual service specs can focus on domain-specific patterns.

## Key Decisions

**Runtime: tsx (no build step).** Run directly via `tsx src/main.ts`. Chosen over tsc+node (slow build cycle), ts-node (slower startup), and Bun (less mature worker_threads support). tsx uses esbuild under the hood — instant startup, zero config.

**Boot env loading: dotenv with no-override semantics.** `.env` is loaded at boot inside the `start` and `process` command actions (not at module top, so importing `main.ts` in tests does not mutate env). dotenv's default behavior preserves already-set `process.env` values, so deployment environment wins over `.env`. Required boot variables (`GITHUB_TOKEN`, `AUTO_CLAUDE_DATABASE_URL`, `ENCRYPTION_KEY`) are validated once, up front, by `validateRequiredBootEnv`, reporting all missing vars in a single error. `DAEMON_DATA_BACKEND` is NOT required — it defaults to `postgres` when undefined or empty.

**Testing: Vitest.** TypeScript-native, fast watch mode. Vitest uses its own esbuild transform pipeline — it does NOT run through tsx. Path aliases and loader hooks configured for tsx must also be configured in `vitest.config.ts`. Chosen over Jest (slower, needs transform config) and node:test (no TypeScript support without build).

**Persistence: JSON files with atomic writes.** Write to a temp file in the same directory, then `rename()` (atomic on POSIX). No database dependency. Chosen over SQLite (overkill for config/state), LevelDB (unnecessary complexity). JSONL (one object per line) for append-only stores (gotchas, results ledger).

**Error handling: Result type.** Expected failures return `{ ok: true, value } | { ok: false, error }`. Thrown exceptions are for unexpected/programmer errors only. Chosen over thrown errors everywhere (lose type safety on error paths) and Effect-TS (too heavy for this scope).

**Package manager: pnpm.** Strict dependency resolution, fast installs, disk-efficient. Chosen over npm (phantom dependencies) and yarn (no meaningful advantage).

**Node.js: 22+ LTS.** Native fetch, native AbortController for timeouts. Note: `worker_threads` are intentionally NOT used in this stack — all session execution is external (API calls or CLI processes), so threading is unnecessary.

**Linting: ESLint with strict TypeScript rules.** No `any` (use `unknown` + narrowing), strict null checks, no non-null assertions without comment justification. These rules are enforced as a hard gate (see ARCH-AC-VALIDATION StaticAnalysisPolicy).

**Formatting: Prettier.** Single config, no debates. Enforced as a hard gate.

**Git operations: Direct CLI via child_process.** Chosen over simple-git (adds dependency for something the CLI does perfectly). Wrap in a thin `git()` helper that returns Result types.

**Structured output schemas: Zod as single source of truth.** All session types that require structured output define their schema using Zod. Convert to JSON Schema via `zod-to-json-schema` for the CLI Adapter's `--json-schema` flag. The SDK Adapter uses the Zod schema directly via `outputSchema`. One schema definition produces: TypeScript types (via `z.infer`), runtime validation, and CLI-compatible JSON Schema.

## Examples

```typescript
// Atomic JSON write (randomized temp name to prevent races)
async function writeJsonSafe<T>(path: string, data: T): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}
```

```typescript
// Result type
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

```typescript
// Git helper returning Result
async function git(args: string[], cwd?: string): Promise<Result<string>> {
  const proc = spawn('git', args, { cwd });
  // ... collect stdout/stderr, return Result
}
```

```typescript
// JSONL append (append-only stores)
async function appendJsonl<T>(path: string, entry: T): Promise<void> {
  await appendFile(path, JSON.stringify(entry) + '\n');
}
```

```typescript
// Atomic text write (for JSONL compaction and other raw text)
async function writeTextSafe(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}
```

## Gotchas

- `rename()` is atomic only within the same filesystem. Always write the temp file in the same directory as the target.
- tsx does NOT support `worker_threads` with TypeScript files directly. This is not a concern — `worker_threads` are intentionally unused in this stack (see Key Decisions).
- JSONL files need a recovery strategy: on read, skip malformed lines rather than failing on the entire file.
- `child_process.spawn` with git: always set `maxBuffer` high enough for large diffs, or stream stdout instead of buffering.
- pnpm uses a content-addressable store. In Docker containers, mount the store as a volume to speed up installs across workspace provisions.

## Project Structure

```
src/
  main.ts                    # daemon entry point
  types.ts                   # shared type definitions
  config.ts                  # configuration loading + validation
  control-plane/             # STACK-AC-CONTROL-PLANE
  session-runtime/           # STACK-AC-SESSION-RUNTIME
  implementation/            # STACK-AC-IMPLEMENTATION
  validation/                # STACK-AC-VALIDATION
  diagnosis/                 # STACK-AC-DIAGNOSIS
  knowledge/                 # STACK-AC-KNOWLEDGE
  lib/                       # shared utilities
    json-store.ts            # atomic JSON + JSONL + text persistence
    git.ts                   # git CLI wrapper
    result.ts                # Result type + helpers
    process.ts               # child process helpers with timeouts
state/                       # runtime state (gitignored)
  daemon.json                # DaemonState
  warmup.json                # WarmupState
  runs/                      # RunState per issue
  results.jsonl              # results ledger (append-only)
  gotchas.jsonl              # gotcha store (append-only)
  exemplars.json             # exemplar references
  proposals/                 # pending prompt proposals
prompts/                     # mutable prompt templates (owned by Knowledge Service)
fitness/                     # architecture fitness check scripts
```
