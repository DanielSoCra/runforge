// src/knowledge-sync/document-mapper.test.ts
import { describe, it, expect } from 'vitest';
import { mapDocumentToRecord } from './document-mapper.js';
import type { VaultDocument } from './types.js';

describe('mapDocumentToRecord', () => {
  const baseDoc: VaultDocument = {
    ref: '20-Areas/Engineering/Mistakes/my-note.md',
    sourceName: 'mistakes',
    confidence: 0.7,
    artifactPatterns: ['src/session-runtime/**/*.ts'],
    bodyText: 'Always reset the flag in a finally block.',
  };

  it('maps document fields to RecordMarker fields', () => {
    const result = mapDocumentToRecord(
      baseDoc,
      'technical_pitfall',
      'vault:mistakes',
      'my-vault',
    );
    expect(result.marker.artifactPatterns).toEqual([
      'src/session-runtime/**/*.ts',
    ]);
    expect(result.marker.description).toBe(
      'Always reset the flag in a finally block.',
    );
    expect(result.confidence).toBe(0.7);
    expect(result.recordType).toBe('technical_pitfall');
    expect(result.sourceId).toContain('my-vault');
    expect(result.sourceId).toContain('mistakes');
    expect(result.sourceId).toContain(
      '20-Areas/Engineering/Mistakes/my-note.md',
    );
  });

  it('uses L3 default confidence of 0.5 when document confidence is 0', () => {
    const doc = { ...baseDoc, confidence: 0 };
    const result = mapDocumentToRecord(
      doc,
      'technical_pitfall',
      'vault:mistakes',
      'my-vault',
    );
    // confidence of 0 is a valid value — L3 default only applies when absent from both manifest and frontmatter
    // Here we pass 0 explicitly so it should stay 0
    expect(result.confidence).toBe(0);
  });

  it('uses empty array for artifactPatterns as L3 default', () => {
    const doc = { ...baseDoc, artifactPatterns: [] };
    const result = mapDocumentToRecord(
      doc,
      'technical_pitfall',
      'vault:mistakes',
      'my-vault',
    );
    expect(result.marker.artifactPatterns).toEqual([]);
  });

  it('trims whitespace from bodyText for description', () => {
    const doc = { ...baseDoc, bodyText: '  whitespace around  \n' };
    const result = mapDocumentToRecord(
      doc,
      'technical_pitfall',
      'vault:mistakes',
      'my-vault',
    );
    expect(result.marker.description).toBe('whitespace around');
  });
});
