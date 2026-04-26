// src/knowledge-sync/sync-service.ts
import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import matter from 'gray-matter';
import { appendJsonl, readJsonl } from '../lib/json-store.js';
import type { KnowledgeStore } from '../knowledge/knowledge-store.js';
import { getManifestPath, readVaultManifest } from './manifest.js';
import { HashRegistry, computeContentHash } from './hash-registry.js';
import {
  applyFrontmatterDefaults,
  mapDocumentToRecord,
} from './document-mapper.js';
import {
  SyncRunSchema,
  type SyncRun,
  type SyncImportResult,
  type VaultDocument,
} from './types.js';
import type { ImportSource } from './types.js';

export interface SyncConfig {
  enabled: boolean;
  vaultPath: string;
  syncIntervalMinutes: number;
}

export interface KnowledgeSyncService {
  triggerSync(): Promise<SyncRun>;
  getSyncHistory(limit?: number): Promise<SyncRun[]>;
}

export function createKnowledgeSyncService(
  config: SyncConfig,
  store: KnowledgeStore,
  stateDir: string,
): KnowledgeSyncService {
  const registryPath = join(stateDir, 'knowledge-sync-registry.jsonl');
  const runsPath = join(stateDir, 'knowledge-sync-runs.jsonl');
  const registry = new HashRegistry(registryPath);
  let syncInProgress = false;

  function buildNoOpRun(reason?: string): SyncRun {
    return {
      id: randomUUID(),
      triggeredAt: new Date().toISOString(),
      importResult: {
        created: 0,
        deduplicated: 0,
        parseFailures: 0,
        storeErrors: 0,
        errors: reason !== undefined ? [reason] : [],
      },
      status: 'success',
    };
  }

  function deriveStatus(result: SyncImportResult): SyncRun['status'] {
    if (result.storeErrors > 0 && result.created === 0) return 'failed';
    if (result.storeErrors > 0) return 'partial';
    return 'success';
  }

  async function enumerateSource(
    vaultRoot: string,
    source: ImportSource,
  ): Promise<string[]> {
    const absPath = resolve(vaultRoot, source.relativePath);
    if (
      !absPath.startsWith(resolve(vaultRoot) + '/') &&
      absPath !== resolve(vaultRoot)
    ) {
      throw new Error(
        `Path traversal detected in relativePath: ${source.relativePath}`,
      );
    }

    try {
      const entries = await readdir(absPath, {
        recursive: source.recursion === 'recursive',
      });
      return (entries as string[])
        .filter((e) => e.endsWith('.md'))
        .map((e) => join(absPath, e));
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      throw e;
    }
  }

  async function processFile(
    absFilePath: string,
    source: ImportSource,
    vaultRoot: string,
    result: SyncImportResult,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(absFilePath, 'utf-8');
    } catch {
      result.parseFailures++;
      result.errors.push(`Failed to read: ${absFilePath}`);
      return;
    }

    const { data: frontmatter, content: body } = matter(raw);
    const bodyText = body.trim();
    if (!bodyText) {
      result.parseFailures++;
      return;
    }

    const { confidence, artifactPatterns } = applyFrontmatterDefaults(
      {
        confidence:
          typeof frontmatter.confidence === 'number'
            ? frontmatter.confidence
            : undefined,
        artifact_patterns: Array.isArray(frontmatter.artifact_patterns)
          ? frontmatter.artifact_patterns
          : undefined,
      },
      {
        confidence: source.confidence,
        artifact_patterns: source.artifact_patterns,
      },
    );

    const vaultDocumentRef = absFilePath.slice(resolve(vaultRoot).length + 1);

    const doc: VaultDocument = {
      ref: vaultDocumentRef,
      sourceName: source.name,
      confidence,
      artifactPatterns,
      bodyText,
    };

    const contentHash = computeContentHash(doc.artifactPatterns, doc.bodyText);

    if (await registry.has(contentHash)) {
      result.deduplicated++;
      return;
    }

    const mapped = mapDocumentToRecord(
      doc,
      source.recordType,
      source.name,
      vaultRoot,
    );

    try {
      await store.storeRecord(
        [{ ...mapped.marker, reasoning: undefined }],
        mapped.sourceId,
        'autonomous',
        mapped.recordType,
      );

      await registry.record({
        id: randomUUID(),
        contentHash,
        sourceName: source.name,
        vaultDocumentRef,
        syncedAt: new Date().toISOString(),
      });
      result.created++;
    } catch (e: unknown) {
      result.storeErrors++;
      result.errors.push(
        `Store error for ${vaultDocumentRef}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function runCycle(): Promise<SyncRun> {
    const triggeredAt = new Date().toISOString();
    const result: SyncImportResult = {
      created: 0,
      deduplicated: 0,
      parseFailures: 0,
      storeErrors: 0,
      errors: [],
    };

    const manifestPath = getManifestPath(config.vaultPath);
    let manifest;
    try {
      manifest = await readVaultManifest(manifestPath);
    } catch (e: unknown) {
      const msg = `Manifest parse error: ${e instanceof Error ? e.message : String(e)}`;
      const run: SyncRun = {
        id: randomUUID(),
        triggeredAt,
        importResult: { ...result, errors: [msg] },
        status: 'failed',
      };
      await appendJsonl(runsPath, run);
      return run;
    }

    if (!manifest) {
      const msg = `VaultAccessManifest not found at ${manifestPath}`;
      const run: SyncRun = {
        id: randomUUID(),
        triggeredAt,
        importResult: { ...result, errors: [msg] },
        status: 'failed',
      };
      await appendJsonl(runsPath, run);
      return run;
    }

    for (const source of manifest.importSources) {
      let files: string[];
      try {
        files = await enumerateSource(config.vaultPath, source);
      } catch (e: unknown) {
        result.parseFailures++;
        result.errors.push(
          `Source '${source.name}' unreachable: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      for (const filePath of files) {
        await processFile(filePath, source, config.vaultPath, result);
      }
    }

    const status = deriveStatus(result);
    const run: SyncRun = {
      id: randomUUID(),
      triggeredAt,
      importResult: result,
      status,
    };
    await appendJsonl(runsPath, run);
    return run;
  }

  return {
    async triggerSync(): Promise<SyncRun> {
      if (!config.enabled) return buildNoOpRun();

      if (syncInProgress) {
        console.warn('[knowledge-sync] sync already in progress, skipping');
        return buildNoOpRun('sync already in progress');
      }

      syncInProgress = true;
      try {
        return await runCycle();
      } finally {
        syncInProgress = false;
      }
    },

    async getSyncHistory(limit = 10): Promise<SyncRun[]> {
      const raw = await readJsonl<Record<string, unknown>>(runsPath);
      const runs = raw.flatMap((line) => {
        const result = SyncRunSchema.safeParse(line);
        return result.success ? [result.data] : [];
      });
      return runs.reverse().slice(0, limit);
    },
  };
}
