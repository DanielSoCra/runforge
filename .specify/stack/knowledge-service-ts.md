---
id: STACK-AC-KNOWLEDGE
type: stack-specific
domain: runforge
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-KNOWLEDGE
code_paths:
  - packages/daemon/src/knowledge/knowledge-store.ts
  - packages/daemon/src/knowledge/record-types.ts
  - packages/daemon/src/knowledge/policy-registry.ts
  - packages/daemon/src/knowledge/candidate-queue.ts
  - packages/daemon/src/knowledge/systemic-proposals.ts
  - packages/daemon/src/knowledge/prospective-check.ts
  - packages/daemon/src/knowledge/extractor.ts
  - packages/daemon/src/knowledge/promotion.ts
  - packages/daemon/src/knowledge/templates.ts
  - packages/daemon/src/knowledge/exemplar-store.ts
  - packages/daemon/src/knowledge/pattern-extractor.ts
  - packages/daemon/src/knowledge/proposal-store.ts
test_paths:
  - packages/daemon/src/knowledge/**/*.test.ts
---

# STACK-AC-KNOWLEDGE — Knowledge Service (TypeScript)

## Pattern

**Append-only JSONL log with record types.** The knowledge store is a JSONL file where each line is a self-contained `KnowledgeRecord`. Records are discriminated by a `recordType` field (`technical_pitfall`, `business_observation`, `operator_correction`, `review_finding`). Reads scan the file and filter in memory by record type and lifecycle status. Writes append a single line. Updates (hit count, status transitions) append a new version with the same ID — on read, the last version of each ID wins (log compaction).

**Lifecycle status as a state field.** Each record carries a `lifecycleStatus` field: `candidate`, `active`, `promoted`, or `archived`. Records from retrospective protocols enter as `candidate` (not available for injection until operator approval). Records from session output enter as `active`. Status transitions append a new record version to the JSONL log.

**PolicyRegistry as a typed map.** A `Record<RecordType, LifecyclePolicy>` maps each record type to its promotion thresholds, archival rules, injection targets, and sort order. Policies are defined as a constant — no configuration file for policies themselves (thresholds within policies are configurable via the project config).

**File-based exemplar references.** Exemplars point to a branch + commit SHA + file paths — not copies of the code. The reference is stable (SHAs are immutable). If the branch is deleted, the exemplar becomes stale and is cleared on next access.

**Glob matching for record injection.** Artifact patterns in records use glob syntax (e.g., `src/session-runtime/**/*.ts`). Matching uses `minimatch` against the unit's expected artifact locations. This is the same glob library used throughout the project for consistency.

### Prompt Contract Registry

`prompt-contracts.ts` declares per-prompt variable contracts (`variables`
set plus optional `defaults`). Three enforcement points consume the
registry:

1. **Contract test** asserts `templatePlaceholders === contract.variables`
   for every registered prompt at CI time.
2. **Per-render check** (`assertContract` called from `loadPromptTemplate`)
   applies defaults, rejects extras and missing-non-default keys. Throws
   in test mode (NODE_ENV=test or VITEST=true); warns in production.
3. **Startup validation** (`validatePromptContracts`) runs at daemon boot;
   the daemon refuses to start on mismatch — production gate against
   prompt-optimizer or operator drift that CI cannot see.

Registry is opt-in. Unregistered prompts retain legacy behavior (no
enforcement). Adding a new prompt to the registry is the single step
required to bring it under contract.

## Key Decisions

**Knowledge store: JSONL file at `state/knowledge.jsonl`.** Each line is a JSON object with: `id`, `recordType` (see RecordType), `artifactPatterns`, `description`, `sourceId`, `confidence`, `createdAt`, `hitCount`, `lifecycleStatus` (candidate | active | promoted | archived), `originType` (autonomous | operator | retrospective-tech-lead | retrospective-po), `priorityTier` (normal | elevated), `rootCauseTag` (optional string), `reasoning` (optional structured narrative). Append-only — updates append a new version with the same ID. On read, the last version of each ID wins. Migration from v1: the existing `state/gotchas.jsonl` is read on first access; entries are mapped to `recordType: 'technical_pitfall'`, `lifecycleStatus: 'active'`, and appended to `state/knowledge.jsonl`. The old file is renamed to `state/gotchas.jsonl.migrated`.

**RecordType as a Zod enum.** Defines the four record types as a Zod enum for runtime validation and TypeScript type inference:

```typescript
const RecordType = z.enum([
  'technical_pitfall',
  'business_observation',
  'operator_correction',
  'review_finding',
]);
```

**LifecycleStatus as a Zod enum.**

```typescript
const LifecycleStatus = z.enum([
  'candidate', 'active', 'promoted', 'archived',
]);
```

**KnowledgeRecord schema with Zod.** Single schema with all fields. The `recordType` field discriminates behavior, not shape — all record types share the same fields. This avoids a discriminated union (the fields are identical; only lifecycle policies differ).

Fields: `id`, `recordType`, `artifactPatterns`, `description`, `sourceId`, `confidence`, `createdAt`, `hitCount`, `lifecycleStatus`, `originType` (autonomous | operator | retrospective-tech-lead | retrospective-po), `priorityTier` (normal | elevated), `rootCauseTag` (optional), `reasoning` (optional). All validated via Zod at read time.

**PolicyRegistry as a constant map.** Default policies are defined inline. Thresholds are overridable via the project config (STACK-AC-CONVENTIONS `config.ts`).

```typescript
// One entry per RecordType — thresholds overridable via config
const DEFAULT_POLICIES: Record<RecordType, LifecyclePolicy> = {
  technical_pitfall: { promotionThreshold: 5, injectionTargets: ['implementation', 'review'], ... },
  business_observation: { promotionThreshold: 3, injectionTargets: ['product_ownership'], ... },
  // operator_correction: no archival, threshold 2; review_finding: threshold 5
};
```

**Candidate approval: Status transition via append.** When the operator approves a candidate, a new version of the record is appended with `lifecycleStatus: 'active'`. The approval API is exposed through the Daemon Control Plane. Rejection transitions to `archived`. Candidate records that are neither approved nor rejected within a configurable period (default: 14 days) are auto-archived during maintenance.

**Candidate approval timeout check.** During periodic maintenance, scan candidate records. If `Date.now() - createdAt > candidateTimeoutMs`, archive them. This prevents unbounded growth of the candidate queue.

**Retrospective record ingestion.** The `storeRecord` function accepts an `originType` parameter. When `originType` is `retrospective-tech-lead` or `retrospective-po`, the record is stored with `lifecycleStatus: 'candidate'`. When `originType` is `autonomous`, the record enters as `active`. When `originType` is `operator`, the record enters as `active` with `priorityTier: 'elevated'`.

**Root-cause tag: Optional string field.** Records sharing the same `rootCauseTag` are related. The tag is a short, human-readable identifier (e.g., `race-condition-worktree-cleanup`). Assigned by the extractor or by the Tech Lead during retrospective. The systemic proposal flow queries by this tag.

**Systemic proposal detection: Root-cause count threshold.** During periodic maintenance, group active records by `rootCauseTag`. When a tag appears on 3+ records (configurable), generate a `SystemicProposal`. Proposals are stored as JSON files in `state/systemic-proposals/{id}.json`.

Fields: `id`, `rootCauseTag`, `description`, `relatedRecordIds`, `remediation`, `status` (pending | approved | rejected), `createdAt`, `cooldownUntil` (optional). Validated via Zod.

**Systemic proposal cooldown.** Rejected proposals store a `cooldownUntil` timestamp. The detection flow skips root-cause tags with an active cooldown. Default cooldown: 30 days, configurable.

**Prospective risk query: Read-only match.** A separate function `queryProspectiveRisks(artifactPaths)` matches active records against planned work areas, returning only high-severity entries (elevated priority tier, or hit count above a configurable severity threshold). Does NOT increment hit counts — this is a read-only assessment. The Coordination Engine calls this before batch planning.

```typescript
// Read-only — does NOT increment hit counts
function queryProspectiveRisks(paths: string[], records: KnowledgeRecord[]): KnowledgeRecord[] {
  return records.filter(r => r.lifecycleStatus === 'active' && isHighSeverity(r))
    .filter(r => matchesAny(r.artifactPatterns, paths));
}
```

**Record matching with type filter.** The `matchRecords` function accepts an optional `recordTypeFilter` and a `sessionType` parameter. When no filter is provided, it uses the PolicyRegistry to determine which record types target the requesting session type. Only records with `lifecycleStatus: 'active'` are returned. Records are sorted per their type's `sortOrder` policy. Hit counts are incremented for matched records.

```typescript
// Uses PolicyRegistry to determine eligible types for the session
function matchRecords(paths: string[], sessionType: string, policies: PolicyRegistry): KnowledgeRecord[] {
  const eligible = Object.entries(policies)
    .filter(([, p]) => p.injectionTargets.includes(sessionType));
  // filter active, glob-match, sort per policy, increment hits
}
```

**Log compaction: Periodic rewrite.** When the JSONL file exceeds a configured size (default: 10MB), compact it by reading all entries, keeping only the latest version of each ID, removing archived entries older than a retention period, and writing a fresh file via atomic write. Run during idle periods (no active sessions).

**Gotcha matching: `minimatch` glob library.** Chosen over `micromatch` (minimatch is simpler, sufficient for our patterns) and regex (globs are more readable for file patterns). Matching is case-sensitive and uses forward slashes regardless of OS.

**Exemplar store: JSON file at `state/exemplars.json`.** A `Record<string, Exemplar>` mapping deliverable type to exemplar reference. Each exemplar contains: `deliverableType`, `branch`, `commitSha`, `filePaths`, `qualityScore`, `createdAt`. Updated via atomic write when a superior implementation is identified.

**Prompt templates: Markdown files in `prompts/`.** Each session type has a `.md` file with `{{variable}}` placeholders rendered via `String.replaceAll()` (simple single-pass replacement — no template engine library, no conditionals or loops needed). The Knowledge Service owns the mutable templates (worker, reviewer, diagnostician). Protected templates (methodology, layer contracts) are in `.specify/methodology/` and are structurally excluded from the optimization flow. Session Runtime calls `renderPrompt()` to assemble the final prompt (see STACK-AC-SESSION-RUNTIME).

**Prompt optimization: Session with diff output.** The optimizer session receives current templates, accumulated records, and error patterns. It returns proposed changes as unified diffs (standard `diff -u` format). Parse diffs using a simple line-by-line parser (no library needed — unified diff format is straightforward). Each parsed diff becomes a `PromptProposal` stored as a JSON file in `state/proposals/{id}.json` containing: template name, current content, proposed content, reasoning, and status (pending/approved/rejected). Version history is an array of `{ content, timestamp, status }` entries in `state/prompt-versions/{template-name}.json`. On approval, apply the diff and archive the previous version. On rollback, restore from version history.

**Pattern extraction: Tokenize + overlap.** Extract keywords from record descriptions by splitting on whitespace, lowercasing, and removing common stopwords (a hardcoded ~50-word list). For each pair of records with overlapping artifact patterns, compute keyword overlap as `intersection.size / union.size` (Jaccard similarity). Pairs with >50% overlap are grouped. Groups with 3+ members become candidate patterns stored in `state/patterns.json`. No NLP library — simple tokenization is sufficient for this domain.

**Record deduplication: Artifact pattern + description similarity.** On store, check existing active records of the same record type for matching artifact patterns. If a record with identical `artifactPatterns` and a similar description exists (Jaccard similarity > 0.7 on tokenized words), increment its hit count instead of creating a duplicate. Otherwise, create a new entry with hit count 1. This prevents the store from growing unboundedly when sessions repeatedly discover the same pitfall.

**Promotion thresholds: Configurable per record type via PolicyRegistry.** Each record type has its own promotion threshold, archival rules, and injection targets defined in the PolicyRegistry. Thresholds are overridable via `config.knowledgePolicies`. Age ceiling for promotion is type-specific. Rejected promotions enter a cooldown period (default: 30 days) tracked via a `reviewedAt` timestamp on the record.

**Proposal cooldown: Timestamp-based.** Rejected prompt proposals store a `rejectedAt` timestamp. The optimization flow skips re-proposing changes to the same template until the cooldown period (default: 30 days, configurable) has elapsed.

**Archival: Type-specific rules from PolicyRegistry.** During periodic maintenance, scan active records. Apply archival criteria from each record type's LifecyclePolicy (max age + min hits). Exception: `operator_correction` records are exempt from automatic archival per their policy (`archivalMaxAge: Infinity`). Archived records are moved to `state/knowledge-archive.jsonl`.

**Root-cause query: Tag-based scan.** `queryByRootCause(tag)` scans the knowledge store for all records with the given `rootCauseTag`, regardless of lifecycle status. Used by the systemic proposal detection flow and by technical leadership sessions.

**Config extension.** New knowledge settings added to the config schema (STACK-AC-CONVENTIONS `config.ts`): `knowledgePolicies` (optional overrides per record type), `systemicProposalThreshold` (default: 3), `systemicProposalCooldownDays` (default: 30), `candidateTimeoutDays` (default: 14), `prospectiveSeverityThreshold` (default: 5).

## Examples

```typescript
// JSONL append with record type and lifecycle
async function storeRecord(record: KnowledgeRecord): Promise<void> {
  await appendJsonl('state/knowledge.jsonl', record);
}
```

```typescript
// Candidate approval — status transition
async function approveCandidate(id: string): Promise<void> {
  const record = await findById(id);
  if (record.lifecycleStatus !== 'candidate') throw new Error('Not a candidate');
  await appendJsonl('state/knowledge.jsonl', {
    ...record, lifecycleStatus: 'active',
  });
}
```

```typescript
// Systemic proposal detection — group by root cause, threshold filter
const groups = groupBy(activeRecords.filter(r => r.rootCauseTag), r => r.rootCauseTag!);
const proposals = Object.entries(groups)
  .filter(([, rs]) => rs.length >= threshold)
  .map(([tag, rs]) => buildProposal(tag, rs));
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

## Gotchas

- JSONL read: always use `line.trim()` before `JSON.parse()`. Trailing newlines produce empty strings that fail parsing.
- JSONL crash safety: if the daemon crashes mid-append, the last line may be truncated. On read, wrap `JSON.parse()` in try/catch per line and skip malformed lines with a warning.
- Log compaction must not run while a session is actively writing records. Use a simple busy flag — compaction is rare and sessions are short enough that a brief wait is acceptable.
- `minimatch` patterns: use `{ dot: true }` option to match dotfiles (e.g., `.claude/hooks/`). The default ignores dot-prefixed paths.
- Exemplar branch deletion: when `git rev-parse <commitSha>` fails, the exemplar is stale. Return "no exemplar" and log a warning. The next successful implementation of that type becomes the new exemplar.
- Prompt template `{{variable}}` syntax: if a variable value contains `{{`, it could cause recursive replacement. Sanitize or use a single-pass replacement (replace left-to-right, don't re-scan replaced text). The `replaceAll` approach shown above is single-pass and safe.
- The mutable/protected boundary is enforced by the optimization flow's context assembly: only files in `prompts/` are loaded as mutable input. Files in `.specify/methodology/` are never passed to the optimizer session.
- Archival is distinct from compaction. Compaction removes duplicate versions of the same record. Archival removes stale records (old + low hit count) from the active store. Both run during maintenance, but serve different purposes.
- Unified diff parsing: split on lines starting with `---`, `+++`, `@@`. No library needed — the format is well-defined. If the optimizer produces malformed diffs, reject the proposal and log a warning.
- Dedup similarity: the 0.7 Jaccard threshold is intentionally high to avoid false merges. Two records about different issues in the same files should remain separate. When in doubt, store as new — the operator can deduplicate manually during promotion review.
- Cooldown timestamps: store `reviewedAt` on the record itself (not in a separate structure). This keeps all record state in the JSONL log and avoids needing a secondary index.
- Candidate → active transition: when approving a candidate, validate that the record's lifecycle status is still `candidate` before appending the transition. A race between approval and auto-archival (timeout) is resolved by the last-write-wins log semantics — if already archived, the approval appends an `active` version that supersedes the archive.
- Prospective risk queries must NOT increment hit counts. The function signature should make this clear — it returns a filtered copy, never mutates the store.
- Systemic proposal cooldown: check `cooldownUntil > Date.now()` before generating a proposal for a root-cause tag. If a previous proposal for the same tag was rejected, the cooldown prevents re-proposal spam.
- Record type filtering during injection: always check the PolicyRegistry's `injectionTargets` for the requesting session type. A product ownership session should never receive `technical_pitfall` records; an implementation session should never receive `business_observation` records.
- Migration from v1: on first read of `state/knowledge.jsonl`, if the file doesn't exist but `state/gotchas.jsonl` does, run the migration. Add `recordType: 'technical_pitfall'` and `lifecycleStatus: 'active'` to each entry. Write to the new path and rename the old file to `.migrated`.
