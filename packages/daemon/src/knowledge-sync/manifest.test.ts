// src/knowledge-sync/manifest.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readVaultManifest } from './manifest.js';

const tmp = () =>
  join(
    tmpdir(),
    `manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );

describe('readVaultManifest', () => {
  let filePath: string;

  afterEach(async () => {
    try {
      await rm(filePath);
    } catch {
      /* ignore */
    }
  });

  it('parses a valid manifest with one import source', async () => {
    filePath = tmp();
    await writeFile(
      filePath,
      [
        '---',
        'importSources:',
        '  - name: mistakes',
        '    relativePath: 20-Areas/Engineering/Mistakes',
        '    recordType: technical_pitfall',
        '    recursion: recursive',
        '---',
        'Human-readable notes here.',
      ].join('\n'),
    );

    const manifest = await readVaultManifest(filePath);
    expect(manifest).not.toBeNull();
    expect(manifest!.importSources).toHaveLength(1);
    const src = manifest!.importSources[0]!;
    expect(src.name).toBe('mistakes');
    expect(src.relativePath).toBe('20-Areas/Engineering/Mistakes');
    expect(src.recordType).toBe('technical_pitfall');
    expect(src.recursion).toBe('recursive');
  });

  it('parses manifest with optional confidence and artifact_patterns', async () => {
    filePath = tmp();
    await writeFile(
      filePath,
      [
        '---',
        'importSources:',
        '  - name: patterns',
        '    relativePath: 20-Areas/Patterns',
        '    recordType: technical_pitfall',
        '    recursion: top-level-only',
        '    confidence: 0.8',
        '    artifact_patterns:',
        '      - src/**/*.ts',
        '---',
      ].join('\n'),
    );

    const manifest = await readVaultManifest(filePath);
    const src = manifest!.importSources[0]!;
    expect(src.confidence).toBe(0.8);
    expect(src.artifact_patterns).toEqual(['src/**/*.ts']);
  });

  it('returns null when file does not exist', async () => {
    filePath = '/nonexistent/path/manifest.md';
    const result = await readVaultManifest(filePath);
    expect(result).toBeNull();
  });

  it('throws on invalid manifest schema (missing recordType)', async () => {
    filePath = tmp();
    await writeFile(
      filePath,
      [
        '---',
        'importSources:',
        '  - name: mistakes',
        '    relativePath: 20-Areas/Engineering/Mistakes',
        '    recursion: recursive',
        '---',
      ].join('\n'),
    );

    await expect(readVaultManifest(filePath)).rejects.toThrow(
      'Manifest parse error',
    );
  });

  it('throws on duplicate import source names', async () => {
    filePath = tmp();
    await writeFile(
      filePath,
      [
        '---',
        'importSources:',
        '  - name: mistakes',
        '    relativePath: path/a',
        '    recordType: technical_pitfall',
        '    recursion: top-level-only',
        '  - name: mistakes',
        '    relativePath: path/b',
        '    recordType: technical_pitfall',
        '    recursion: top-level-only',
        '---',
      ].join('\n'),
    );

    await expect(readVaultManifest(filePath)).rejects.toThrow(
      'Manifest parse error',
    );
  });

  it('throws when file has no frontmatter (empty data)', async () => {
    filePath = tmp();
    await writeFile(filePath, 'Just body text, no frontmatter.');

    await expect(readVaultManifest(filePath)).rejects.toThrow(
      'Manifest parse error',
    );
  });
});
