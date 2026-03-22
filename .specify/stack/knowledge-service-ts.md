---
id: STACK-AC-KNOWLEDGE
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-KNOWLEDGE
code_paths:
  - packages/daemon/src/knowledge/
test_paths:
  - packages/daemon/src/knowledge/**/*.test.ts
---

# STACK-AC-KNOWLEDGE — Knowledge Service (TypeScript)

## Pattern

**Append-only log for gotchas.** JSONL file where each line is a self-contained gotcha record. Reads scan the entire file and filter in memory. Writes append a single line. This is simple, crash-safe (a partial last line is skipped on read), and supports concurrent reads without locking.

**File-based exemplar references.** Exemplars point to a branch + commit SHA + file paths — not copies of the code. The reference is stable (SHAs are immutable). If the branch is deleted, the exemplar becomes stale and is cleared on next access.

**Glob matching for gotcha injection.** Artifact patterns in gotchas use glob syntax (e.g., `src/session-runtime/**/*.ts`). Matching uses `minimatch` against the unit's expected artifact locations. This is the same glob library used throughout the project for consistency.

## Key Decisions

**Gotcha store: JSONL file at `state/gotchas.jsonl`.** Each line is a JSON object with: `id`, `artifactPatterns`, `description`, `sourceIssue`, `confidence`, `createdAt`, `hitCount`, `promoted`, `archived`, `originType` ('autonomous' | 'operator'), `priorityTier` ('normal' | 'elevated'). Append-only — updates (hit count increment, promotion, archival) append a new version of the record with the same ID. On read, the last version of each ID wins (log compaction).

**Log compaction: Periodic rewrite.** When the JSONL file exceeds a configured size (default: 10MB), compact it by reading all entries, keeping only the latest version of each ID, removing archived entries, and writing a fresh file via atomic write. Run during idle periods (no active sessions).

**Gotcha matching: `minimatch` glob library.** Chosen over `micromatch` (minimatch is simpler, sufficient for our patterns) and regex (globs are more readable for file patterns). Matching is case-sensitive and uses forward slashes regardless of OS.

**Exemplar store: JSON file at `state/exemplars.json`.** A `Record<string, Exemplar>` mapping deliverable type to exemplar reference. Each exemplar contains: `deliverableType`, `branch`, `commitSha`, `filePaths`, `qualityScore`, `createdAt`. Updated via atomic write when a superior implementation is identified.

**Prompt templates: Markdown files in `prompts/`.** Each session type has a `.md` file with `{{variable}}` placeholders rendered via `String.replaceAll()` (simple single-pass replacement — no template engine library, no conditionals or loops needed). The Knowledge Service owns the mutable templates (worker, reviewer, diagnostician). Protected templates (methodology, layer contracts) are in `.specify/methodology/` and are structurally excluded from the optimization flow. Session Runtime calls `renderPrompt()` to assemble the final prompt (see STACK-AC-SESSION-RUNTIME).

**Prompt optimization: Session with diff output.** The optimizer session receives current templates, accumulated gotchas, and error patterns. It returns proposed changes as unified diffs (standard `diff -u` format). Parse diffs using a simple line-by-line parser (no library needed — unified diff format is straightforward). Each parsed diff becomes a `PromptProposal` stored as a JSON file in `state/proposals/{id}.json` containing: template name, current content, proposed content, reasoning, and status (pending/approved/rejected). Version history is an array of `{ content, timestamp, status }` entries in `state/prompt-versions/{template-name}.json`. On approval, apply the diff and archive the previous version. On rollback, restore from version history.

**Pattern extraction: Tokenize + overlap.** Extract keywords from gotcha descriptions by splitting on whitespace, lowercasing, and removing common stopwords (a hardcoded ~50-word list). For each pair of gotchas with overlapping artifact patterns, compute keyword overlap as `intersection.size / union.size` (Jaccard similarity). Pairs with >50% overlap are grouped. Groups with 3+ members become candidate patterns stored in `state/patterns.json`. No NLP library — simple tokenization is sufficient for this domain.

**Gotcha deduplication: Artifact pattern + description similarity.** On store, check existing gotchas for matching artifact patterns. If a gotcha with identical `artifactPatterns` and a similar description exists (Jaccard similarity > 0.7 on tokenized words), increment its hit count instead of creating a duplicate. Otherwise, create a new entry with hit count 1. This prevents the store from growing unboundedly when sessions repeatedly discover the same pitfall.

**Promotion thresholds: Configurable per priority tier.** Normal-priority gotchas require 5 hits for promotion eligibility. Elevated-priority gotchas (operator corrections) require 2 hits. Both thresholds are configurable via `config.promotionThresholds: { normal: number, elevated: number }`. Age ceiling for promotion: 90 days (configurable). Rejected promotions enter a cooldown period (default: 30 days) tracked via a `reviewedAt` timestamp on the gotcha — the gotcha is not re-proposed until cooldown expires.

**Proposal cooldown: Timestamp-based.** Rejected prompt proposals store a `rejectedAt` timestamp. The optimization flow skips re-proposing changes to the same template until the cooldown period (default: 30 days, configurable) has elapsed. Cooldown is checked by comparing `rejectedAt + cooldownMs` against `Date.now()`.

**Archival: Age + hit count filter.** During periodic maintenance (triggered by the Control Plane on a configurable schedule), scan all gotchas. Archive any gotcha where age exceeds the configured maximum (default: 90 days) AND hit count is below a configured minimum (default: 2). Archived gotchas are moved to `state/gotchas-archive.jsonl` — retained for historical reference but excluded from active matching and injection.

## Examples

```typescript
// JSONL append
async function storeGotcha(gotcha: Gotcha): Promise<void> {
  await appendJsonl('state/gotchas.jsonl', gotcha);
}
```

```typescript
// Gotcha matching with glob
function matchGotchas(artifactPaths: string[], gotchas: Gotcha[]): Gotcha[] {
  return gotchas
    .filter(g => !g.promoted)
    .filter(g => g.artifactPatterns.some(pattern =>
      artifactPaths.some(path => minimatch(path, pattern))
    ))
    .sort((a, b) => tierOrder(b.priorityTier) - tierOrder(a.priorityTier)
                  || b.hitCount - a.hitCount);
}
```

```typescript
// Template rendering
function renderPrompt(templatePath: string, vars: Record<string, string>): string {
  let content = readFileSync(templatePath, 'utf-8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}
```

```typescript
// Log compaction
async function compactGotchaStore(): Promise<void> {
  const entries = await readJsonl<Gotcha>('state/gotchas.jsonl');
  const latest = new Map<string, Gotcha>();
  for (const entry of entries) latest.set(entry.id, entry);
  const active = [...latest.values()].filter(g => !g.archived);
  await writeTextSafe('state/gotchas.jsonl',
    active.map(g => JSON.stringify(g)).join('\n') + '\n');
}
```

## Gotchas

- JSONL read: always use `line.trim()` before `JSON.parse()`. Trailing newlines produce empty strings that fail parsing.
- JSONL crash safety: if the daemon crashes mid-append, the last line may be truncated. On read, wrap `JSON.parse()` in try/catch per line and skip malformed lines with a warning.
- Log compaction must not run while a session is actively writing gotchas. Use a simple busy flag — compaction is rare and sessions are short enough that a brief wait is acceptable.
- `minimatch` patterns: use `{ dot: true }` option to match dotfiles (e.g., `.claude/hooks/`). The default ignores dot-prefixed paths.
- Exemplar branch deletion: when `git rev-parse <commitSha>` fails, the exemplar is stale. Return "no exemplar" and log a warning. The next successful implementation of that type becomes the new exemplar.
- Prompt template `{{variable}}` syntax: if a variable value contains `{{`, it could cause recursive replacement. Sanitize or use a single-pass replacement (replace left-to-right, don't re-scan replaced text). The `replaceAll` approach shown above is single-pass and safe.
- The mutable/protected boundary is enforced by the optimization flow's context assembly: only files in `prompts/` are loaded as mutable input. Files in `.specify/methodology/` are never passed to the optimizer session.
- Archival is distinct from compaction. Compaction removes duplicate versions of the same gotcha. Archival removes stale gotchas (old + low hit count) from the active store. Both run during maintenance, but serve different purposes.
- Unified diff parsing: split on lines starting with `---`, `+++`, `@@`. No library needed — the format is well-defined. If the optimizer produces malformed diffs, reject the proposal and log a warning.
- Dedup similarity: the 0.7 Jaccard threshold is intentionally high to avoid false merges. Two gotchas about different issues in the same files should remain separate. When in doubt, store as new — the operator can deduplicate manually during promotion review.
- Cooldown timestamps: store `reviewedAt` on the gotcha record itself (not in a separate structure). This keeps all gotcha state in the JSONL log and avoids needing a secondary index.
