// src/knowledge-sync/types.ts
import { z } from 'zod';
import { RecordType } from '../knowledge/record-types.js';

export const ImportSourceSchema = z.object({
  name: z.string().min(1),
  relativePath: z.string().min(1),
  recordType: RecordType,
  recursion: z.enum(['top-level-only', 'recursive']),
  confidence: z.number().min(0).max(1).optional(),
  artifact_patterns: z.array(z.string()).optional(),
});
export type ImportSource = z.infer<typeof ImportSourceSchema>;

export const VaultAccessManifestSchema = z.object({
  importSources: z.array(ImportSourceSchema).refine(
    sources => new Set(sources.map(s => s.name)).size === sources.length,
    { message: 'Duplicate import source names are not allowed' },
  ),
});
export type VaultAccessManifest = z.infer<typeof VaultAccessManifestSchema>;

export const SyncHashEntrySchema = z.object({
  id: z.string().min(1),
  contentHash: z.string().min(1),
  sourceName: z.string().min(1),
  vaultDocumentRef: z.string().min(1),
  syncedAt: z.string().min(1),
});
export type SyncHashEntry = z.infer<typeof SyncHashEntrySchema>;

export interface SyncImportResult {
  created: number;
  deduplicated: number;
  parseFailures: number;
  storeErrors: number;
  errors: string[];
}

export const SyncRunSchema = z.object({
  id: z.string().min(1),
  triggeredAt: z.string().min(1),
  importResult: z.object({
    created: z.number().int().min(0),
    deduplicated: z.number().int().min(0),
    parseFailures: z.number().int().min(0),
    storeErrors: z.number().int().min(0),
    errors: z.array(z.string()),
  }),
  status: z.enum(['success', 'partial', 'failed']),
});
export type SyncRun = z.infer<typeof SyncRunSchema>;

export interface VaultDocument {
  ref: string;
  sourceName: string;
  confidence: number;
  artifactPatterns: string[];
  bodyText: string;
}
