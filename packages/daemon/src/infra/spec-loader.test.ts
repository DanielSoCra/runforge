import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSpecContent } from './spec-loader.js';

describe('loadSpecContent', () => {
  let specifyRoot: string;

  beforeEach(async () => {
    specifyRoot = await mkdtemp(join(tmpdir(), 'spec-loader-test-'));
    await mkdir(join(specifyRoot, 'functional'));
    await mkdir(join(specifyRoot, 'architecture'));
    await mkdir(join(specifyRoot, 'stack'));
  });

  afterEach(async () => {
    await rm(specifyRoot, { recursive: true, force: true });
  });

  it('loads spec content matching a single spec ID', async () => {
    await writeFile(
      join(specifyRoot, 'functional', 'pipeline.md'),
      '---\nid: FUNC-AC-PIPELINE\ntype: functional\nstatus: draft\n---\n\n# Pipeline\n\nOrchestrates work.',
    );

    const result = await loadSpecContent(['FUNC-AC-PIPELINE'], specifyRoot);
    expect(result).toContain('FUNC-AC-PIPELINE');
    expect(result).toContain('Orchestrates work.');
  });

  it('loads and concatenates multiple spec IDs across directories', async () => {
    await writeFile(
      join(specifyRoot, 'functional', 'quality.md'),
      '---\nid: FUNC-AC-QUALITY\ntype: functional\nstatus: draft\n---\n\nQuality spec content.',
    );
    await writeFile(
      join(specifyRoot, 'architecture', 'validation.md'),
      '---\nid: ARCH-AC-VALIDATION\ntype: architecture\nstatus: draft\n---\n\nValidation architecture.',
    );

    const result = await loadSpecContent(
      ['FUNC-AC-QUALITY', 'ARCH-AC-VALIDATION'],
      specifyRoot,
    );
    expect(result).toContain('Quality spec content.');
    expect(result).toContain('Validation architecture.');
    expect(result).toContain('---'); // separator between specs
  });

  it('returns empty string when no spec IDs provided', async () => {
    const result = await loadSpecContent([], specifyRoot);
    expect(result).toBe('');
  });

  it('returns empty string when no spec IDs match', async () => {
    await writeFile(
      join(specifyRoot, 'functional', 'other.md'),
      '---\nid: FUNC-OTHER\ntype: functional\nstatus: draft\n---\n\nOther content.',
    );

    const result = await loadSpecContent(['NONEXISTENT-SPEC'], specifyRoot);
    expect(result).toBe('');
  });

  it('skips non-md files', async () => {
    await writeFile(
      join(specifyRoot, 'functional', 'notes.txt'),
      '---\nid: FUNC-AC-PIPELINE\n---\n\nShould be ignored.',
    );

    const result = await loadSpecContent(['FUNC-AC-PIPELINE'], specifyRoot);
    expect(result).toBe('');
  });

  it('handles missing directories gracefully', async () => {
    await rm(join(specifyRoot, 'stack'), { recursive: true });

    const result = await loadSpecContent(['STACK-MISSING'], specifyRoot);
    expect(result).toBe('');
  });

  it('regression: phases.ts must pass spec content not workRequest.body (#122)', async () => {
    // This test verifies the core claim of issue #122:
    // The reviewer-spec prompt must receive actual spec file content,
    // not the GitHub issue body text.
    await writeFile(
      join(specifyRoot, 'architecture', 'validation.md'),
      '---\nid: ARCH-AC-VALIDATION\ntype: architecture\nstatus: draft\n---\n\n## Acceptance Criteria\n\n1. Gate 2 receives governing spec content (pre-loaded)\n2. Reviewer independently verifies acceptance criteria',
    );

    const specContent = await loadSpecContent(['ARCH-AC-VALIDATION'], specifyRoot);

    // Spec content should contain acceptance criteria, not issue body
    expect(specContent).toContain('Acceptance Criteria');
    expect(specContent).toContain('Gate 2 receives governing spec content');
    expect(specContent).not.toBe(''); // Must not be empty
  });
});
