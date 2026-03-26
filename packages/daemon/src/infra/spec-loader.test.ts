import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSpecContent,
  loadImplementationContent,
  extractCodePaths,
  resolveCurrentSpecRefs,
} from './spec-loader.js';

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

  it('regression: phases.ts must pass spec content not workRequest.body (#122, #263)', async () => {
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

describe('extractCodePaths', () => {
  it('extracts multi-line code_paths for matching spec IDs', () => {
    const traceContent = `
STACK-AC-DIAGNOSIS:
  parent: ARCH-AC-DIAGNOSIS
  code_paths:
    - packages/daemon/src/diagnosis/
  test_paths:
    - packages/daemon/src/diagnosis/**/*.test.ts
  status: draft

STACK-AC-CONTROL-PLANE:
  parent: ARCH-AC-CONTROL-PLANE
  code_paths:
    - packages/daemon/src/control-plane/
    - packages/daemon/src/control-plane/classifier.ts
  test_paths:
    - packages/daemon/src/control-plane/**/*.test.ts
  status: draft
`;
    const paths = extractCodePaths(traceContent, new Set(['STACK-AC-DIAGNOSIS']));
    expect(paths).toEqual(['packages/daemon/src/diagnosis/']);
  });

  it('extracts inline code_paths', () => {
    const traceContent = `
STACK-AC-DIAGNOSIS:
  parent: ARCH-AC-DIAGNOSIS
  code_paths: [packages/daemon/src/diagnosis/]
  status: draft
`;
    const paths = extractCodePaths(traceContent, new Set(['STACK-AC-DIAGNOSIS']));
    expect(paths).toEqual(['packages/daemon/src/diagnosis/']);
  });

  it('returns empty array for non-matching specs', () => {
    const traceContent = `
STACK-AC-DIAGNOSIS:
  code_paths:
    - packages/daemon/src/diagnosis/
`;
    const paths = extractCodePaths(traceContent, new Set(['NO-MATCH']));
    expect(paths).toEqual([]);
  });
});

describe('loadImplementationContent', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'impl-loader-test-'));
    await mkdir(join(repoRoot, '.specify'));
    await mkdir(join(repoRoot, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('loads implementation files from code_paths in traceability.yml (#263)', async () => {
    await writeFile(
      join(repoRoot, '.specify', 'traceability.yml'),
      `STACK-AC-DIAGNOSIS:\n  parent: ARCH-AC-DIAGNOSIS\n  code_paths:\n    - src/fix.ts\n  status: draft\n`,
    );
    await writeFile(join(repoRoot, 'src', 'fix.ts'), 'export function fix() { return true; }');

    const content = await loadImplementationContent(['STACK-AC-DIAGNOSIS'], repoRoot);
    expect(content).toContain('src/fix.ts');
    expect(content).toContain('export function fix()');
  });

  it('expands directory code_paths into .ts files (#263)', async () => {
    await writeFile(
      join(repoRoot, '.specify', 'traceability.yml'),
      `STACK-AC-DIAGNOSIS:\n  code_paths: [src/]\n`,
    );
    await writeFile(join(repoRoot, 'src', 'router.ts'), 'export function route() {}');
    await writeFile(join(repoRoot, 'src', 'schema.ts'), 'export const schema = {};');
    await writeFile(join(repoRoot, 'src', 'router.test.ts'), 'test("skip me", () => {});');

    const content = await loadImplementationContent(['STACK-AC-DIAGNOSIS'], repoRoot);
    expect(content).toContain('router.ts');
    expect(content).toContain('schema.ts');
    expect(content).not.toContain('router.test.ts'); // test files excluded
  });

  it('returns empty string when no spec refs match', async () => {
    await writeFile(
      join(repoRoot, '.specify', 'traceability.yml'),
      `STACK-OTHER:\n  code_paths:\n    - src/other.ts\n`,
    );

    const content = await loadImplementationContent(['NO-MATCH'], repoRoot);
    expect(content).toBe('');
  });

  it('skips glob patterns and missing files', async () => {
    await writeFile(
      join(repoRoot, '.specify', 'traceability.yml'),
      `STACK-AC-DIAGNOSIS:\n  code_paths:\n    - src/**/*.test.ts\n    - src/missing.ts\n    - src/exists.ts\n`,
    );
    await writeFile(join(repoRoot, 'src', 'exists.ts'), 'const x = 1;');

    const content = await loadImplementationContent(['STACK-AC-DIAGNOSIS'], repoRoot);
    expect(content).toContain('exists.ts');
    expect(content).not.toContain('missing.ts');
    expect(content).not.toContain('**/*.test.ts');
  });

  it('truncates when content exceeds budget', async () => {
    await writeFile(
      join(repoRoot, '.specify', 'traceability.yml'),
      `STACK-AC-DIAGNOSIS:\n  code_paths:\n    - src/big.ts\n`,
    );
    await writeFile(join(repoRoot, 'src', 'big.ts'), 'x'.repeat(5000));

    const content = await loadImplementationContent(['STACK-AC-DIAGNOSIS'], repoRoot, 500);
    expect(content.length).toBeLessThanOrEqual(600); // header + truncated content
    expect(content).toContain('[truncated]');
  });

  it('regression: diagnose phase must not pass empty implementation content (#263)', async () => {
    // This test verifies the core claim of issue #263:
    // The diagnostician must receive implementation code, not an empty string,
    // so it can classify Type A bugs (spec-vs-implementation mismatch).
    await writeFile(
      join(repoRoot, '.specify', 'traceability.yml'),
      `STACK-AC-DIAGNOSIS:\n  parent: ARCH-AC-DIAGNOSIS\n  code_paths:\n    - src/diagnostician.ts\n  status: draft\n`,
    );
    await writeFile(
      join(repoRoot, 'src', 'diagnostician.ts'),
      'export async function diagnose(impl: string) { return impl !== ""; }',
    );

    const content = await loadImplementationContent(['STACK-AC-DIAGNOSIS'], repoRoot);
    expect(content).not.toBe('');
    expect(content).toContain('diagnose');
  });
});

describe('resolveCurrentSpecRefs', () => {
  let specifyRoot: string;

  beforeEach(async () => {
    specifyRoot = await mkdtemp(join(tmpdir(), 'spec-chain-test-'));
    await mkdir(join(specifyRoot, '.specify'));
  });

  afterEach(async () => {
    await rm(specifyRoot, { recursive: true, force: true });
  });

  it('walks children downward to resolve full spec chain', async () => {
    const traceability = [
      'FUNC-AC-FOO:',
      '  children: [ARCH-AC-FOO]',
      '  status: approved',
      '',
      'ARCH-AC-FOO:',
      '  parent: FUNC-AC-FOO',
      '  children: [STACK-AC-FOO]',
      '  status: approved',
      '',
      'STACK-AC-FOO:',
      '  parent: ARCH-AC-FOO',
      '  code_paths:',
      '    - src/foo.ts',
      '  status: approved',
    ].join('\n');

    await writeFile(join(specifyRoot, '.specify', 'traceability.yml'), traceability);

    const result = await resolveCurrentSpecRefs(specifyRoot, ['FUNC-AC-FOO']);
    expect(result).toContain('FUNC-AC-FOO');
    expect(result).toContain('ARCH-AC-FOO');
    expect(result).toContain('STACK-AC-FOO');
  });

  it('also picks up specs whose parent field points into the base set', async () => {
    // ARCH-AC-BAR declares parent: FUNC-AC-BAR but FUNC-AC-BAR has no children list
    const traceability = [
      'FUNC-AC-BAR:',
      '  status: approved',
      '',
      'ARCH-AC-BAR:',
      '  parent: FUNC-AC-BAR',
      '  status: approved',
    ].join('\n');

    await writeFile(join(specifyRoot, '.specify', 'traceability.yml'), traceability);

    const result = await resolveCurrentSpecRefs(specifyRoot, ['FUNC-AC-BAR']);
    expect(result).toContain('FUNC-AC-BAR');
    expect(result).toContain('ARCH-AC-BAR');
  });

  it('returns original refs when traceability.yml does not exist', async () => {
    const result = await resolveCurrentSpecRefs(specifyRoot, ['FUNC-AC-MISSING']);
    expect(result).toEqual(['FUNC-AC-MISSING']);
  });

  it('returns original refs unchanged when base refs have no children or parents pointing to them', async () => {
    const traceability = [
      'FUNC-AC-ISOLATED:',
      '  status: approved',
    ].join('\n');

    await writeFile(join(specifyRoot, '.specify', 'traceability.yml'), traceability);

    const result = await resolveCurrentSpecRefs(specifyRoot, ['FUNC-AC-ISOLATED']);
    expect(result).toEqual(['FUNC-AC-ISOLATED']);
  });

  it('deduplicates refs that appear via both children and parent traversal', async () => {
    const traceability = [
      'FUNC-AC-DUP:',
      '  children: [ARCH-AC-DUP]',
      '  status: approved',
      '',
      'ARCH-AC-DUP:',
      '  parent: FUNC-AC-DUP',
      '  status: approved',
    ].join('\n');

    await writeFile(join(specifyRoot, '.specify', 'traceability.yml'), traceability);

    const result = await resolveCurrentSpecRefs(specifyRoot, ['FUNC-AC-DUP']);
    const archCount = result.filter(r => r === 'ARCH-AC-DUP').length;
    expect(archCount).toBe(1);
  });
});
