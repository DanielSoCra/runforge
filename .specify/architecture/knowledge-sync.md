---
id: ARCH-AC-KNOWLEDGE-SYNC
type: architecture
domain: runforge
status: draft
version: 2
layer: 2
references: FUNC-AC-LEARNING
---

# ARCH-AC-KNOWLEDGE-SYNC — Read-Only Knowledge Import from Vault

## Overview

The Knowledge Sync Service imports insights from an external knowledge-vault vault (a directory of Markdown files) into runforge's internal Knowledge Service (ARCH-AC-KNOWLEDGE). Sync is **one-directional and read-only from runforge's perspective** — runforge never writes to the vault. The set of vault locations to read (e.g. Mistakes, Patterns, or others) is not hardcoded in runforge; instead, runforge reads a vault-local **access manifest** — a known-named instructions file maintained inside the vault itself — that declares which relative paths to ingest and how to map each into KnowledgeRecord types. When the vault's internal structure changes, the manifest inside the vault changes with it and runforge adapts on the next sync cycle without a code or config change. Sync runs on a configurable schedule (never real-time). A content-hash deduplication registry prevents the same insight from being re-imported across cycles.

## Data Model

**SyncConfig** holds the repo-side, operator-configurable sync parameters. It contains: `enabled` (boolean — when false, the sync process does not run), `vaultPath` (the root location of the knowledge-vault vault in File Storage), and `syncIntervalMinutes` (default 60). The repo config identifies WHICH vault to sync from; it does not describe the vault's internal layout.

**VaultAccessManifest** is the in-vault contract that tells runforge what to read. It is a structured document read from a well-known relative path within the vault root (the exact filename and path is fixed at the L3 pattern layer, not here). Its content declares a list of **ImportSource** entries, each with: a `name` (stable identifier used in source attribution, e.g. `mistakes`, `patterns`), a `relativePath` (directory within the vault root to enumerate), a `recordType` (how to map documents into KnowledgeRecord — e.g. `technical_pitfall`), and a `recursion` policy (either `top-level-only` or `recursive`). The manifest may also declare a default `confidence` and default `artifact_patterns` to apply when documents omit those frontmatter fields. The manifest is read fresh on every sync cycle — changes take effect at the next scheduled trigger.

**SyncHashRegistry** is the deduplication store. It is a structured append-only log; each entry contains: a unique identifier, a `contentHash` (deterministic hash of the normalized record content: artifact patterns sorted and concatenated with the description), the `sourceName` (which ImportSource the document came from), a `vaultDocumentReference` (stable identifier within the vault), and a `syncedAt` timestamp. Before importing, the sync process checks the registry for an existing entry with the same content hash. If found, the document is skipped. If not found, a new entry is appended after the import succeeds.

**SyncRun** records the outcome of a single import cycle. It contains: a unique identifier, a `triggeredAt` timestamp, an `importResult` (with: records created count, records deduplicated count, records skipped due to parse failure count, records failed due to store errors count, and an array of error messages), and an overall `status` (either `success` — zero errors, `partial` — one or more records failed but at least one succeeded, or `failed` — no records imported due to a manifest or vault-level error).

**VaultDocument** represents a single Markdown file read from an ImportSource's relative path. It contains: a document reference (a stable identifier for the document within the vault, used for source attribution), the `sourceName` it was found under (from the manifest), parsed frontmatter fields (`source`, `date`, `confidence`, `artifact_patterns` — all optional, default-filled from the manifest or L3 defaults if absent), and a `bodyText` (the Markdown body content below the frontmatter, used as the record description).

## API Contract

The Knowledge Sync Service does not expose an HTTP API. It is invoked procedurally by the Daemon Control Plane via an internal trigger call.

**Trigger sync** — Called by the Daemon Control Plane on the configured schedule. Effect: runs a single import cycle. Response: a SyncRun record summarizing the outcome. If `enabled` is false in SyncConfig, the call returns immediately with a `SyncRun` of status `success` and zero counts (no-op).

**Get sync history** — Called by the Daemon Control Plane when the operator queries sync status. Request: optional limit (default 10). Response: an array of recent SyncRun records in reverse chronological order.

## System Boundaries

- Knowledge Sync Service OWNS: SyncHashRegistry, SyncRun history, the SyncConfig reader, and the VaultAccessManifest parser.
- Knowledge Sync Service READS: File Storage (the vault's access manifest, and the Markdown files at relative paths declared in that manifest).
- Knowledge Sync Service WRITES: Knowledge Service only (records are submitted via the documented store-record API with origin type `autonomous` and lifecycle status `active`).
- Knowledge Sync Service NEVER writes to the vault. The vault is read-only from runforge's perspective.
- Knowledge Sync Service NEVER encodes vault-internal structure (directory names, layout conventions). All vault structure knowledge comes from the VaultAccessManifest read fresh on each cycle.
- Daemon Control Plane TRIGGERS the sync cycle on schedule and surfaces sync history to the operator.
- Knowledge Service OWNS the canonical knowledge store. The Knowledge Sync Service never reads or writes the knowledge store's underlying file directly — it uses only the Knowledge Service's documented API.
- Knowledge Sync Service NEVER modifies the Knowledge Service's lifecycle policies, promotion logic, or exemplar store — those remain entirely within Knowledge Service's boundary.

## Event Flows

**Import flow:**
1. Daemon Control Plane triggers a sync cycle.
2. Knowledge Sync Service reads SyncConfig from the repo config file. If `enabled` is false, return a no-op SyncRun.
3. Knowledge Sync Service reads the VaultAccessManifest from the configured vault root. If the manifest is missing or unparseable, return a SyncRun with status `failed` and log the error. Do not fall back to assumed directory layouts.
4. For each ImportSource declared in the manifest, enumerate Markdown files at the declared `relativePath` under the recursion policy specified.
5. For each Markdown file, parse the frontmatter and body. If parsing fails (malformed frontmatter, missing body, or non-Markdown content), skip the file and increment the parse-failure count — continue to the next file.
6. Construct a VaultDocument from the parsed file, tagged with the ImportSource's `sourceName`. Map the document to a KnowledgeRecord candidate using the ImportSource's `recordType`. Apply defaults from the manifest (or L3 defaults) for any missing frontmatter fields: `confidence` and `artifact_patterns`.
7. Compute the content hash from the mapped artifact patterns and description.
8. Check the SyncHashRegistry for an existing entry with the same content hash. If found, skip the document (increment the deduplicated count).
9. If not found, call the Knowledge Service's store-record API with the mapped record, origin type `autonomous`, and a source identifier that combines the vault name, the ImportSource's `sourceName`, and the document reference. On success, append a SyncHashRegistry entry. On failure, increment the error count and continue.
10. After processing all documents across all sources, write a SyncRun entry with the outcome.

**Scheduled trigger flow:**
1. On daemon startup, the Daemon Control Plane schedules a recurring sync trigger based on `syncIntervalMinutes` in SyncConfig.
2. Each trigger fires the Knowledge Sync Service's internal trigger call.
3. The SyncRun result is stored. If the cycle's status is `failed` or `partial`, the Daemon Control Plane logs a warning and surfaces the failure in the next operator status query.
4. The schedule continues regardless of the previous cycle's outcome — the next cycle is not skipped on failure.

## Error Handling

**SyncConfig missing or malformed:** If the `knowledgeSync` section is absent from the repo config, the sync service treats `enabled` as false and returns a no-op SyncRun. No error is raised — sync is opt-in.

**VaultAccessManifest missing or unparseable:** The entire sync cycle fails with an error recorded in the SyncRun (status `failed`, zero records processed). Loud failure is intentional — runforge does not assume vault layouts. The operator must place or repair the manifest inside the vault.

**Vault not found or not readable:** The sync cycle fails with status `failed` and a descriptive error. The next scheduled cycle will retry.

**ImportSource path missing or not readable:** That specific source is skipped; its parse-failure count is incremented with a "source unreachable" message. Other sources proceed normally. Overall status is `partial`.

**Knowledge Service unavailable during import store call:** The specific record fails (increment error count, log the error). Processing continues with the next file. The registry entry is NOT written for the failed record — the next sync cycle will retry it.

**Content hash collision (distinct records with identical hash):** The second record is treated as a duplicate and skipped. This is acceptable: identical normalized content carries the same knowledge value regardless of origin.

**SyncHashRegistry corruption:** On read failure, the sync service treats the registry as empty (all documents appear as new). This results in duplicate import attempts for that cycle, but duplicates are handled by the Knowledge Service's own deduplication logic (which increments hit count rather than creating new records). After the cycle, the registry is rebuilt from the records successfully processed.

**Concurrent sync triggers:** The sync service enforces a single active sync cycle per daemon instance. If a trigger arrives while a cycle is already running, the trigger is dropped and a warning is logged. The scheduled interval ensures the next trigger will arrive normally.
