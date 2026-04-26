// src/knowledge-sync/document-mapper.ts
import type { RecordType } from '../knowledge/record-types.js';
import type { RecordMarker } from '../knowledge/knowledge-store.js';
import type { VaultDocument } from './types.js';

const DEFAULT_CONFIDENCE = 0.5;

export interface MappedRecord {
  marker: RecordMarker;
  confidence: number;
  recordType: RecordType;
  sourceId: string;
}

export function mapDocumentToRecord(
  doc: VaultDocument,
  recordType: RecordType,
  _importSourceName: string,
  vaultName: string,
): MappedRecord {
  const description = doc.bodyText.trim();
  const sourceId = `${vaultName}:${doc.sourceName}:${doc.ref}`;

  return {
    marker: {
      artifactPatterns: doc.artifactPatterns,
      description,
    },
    confidence: doc.confidence ?? DEFAULT_CONFIDENCE,
    recordType,
    sourceId,
  };
}

export function applyFrontmatterDefaults(
  frontmatter: { confidence?: number; artifact_patterns?: string[] },
  manifestDefaults: { confidence?: number; artifact_patterns?: string[] },
): { confidence: number; artifactPatterns: string[] } {
  return {
    confidence:
      frontmatter.confidence ??
      manifestDefaults.confidence ??
      DEFAULT_CONFIDENCE,
    artifactPatterns:
      frontmatter.artifact_patterns ?? manifestDefaults.artifact_patterns ?? [],
  };
}
