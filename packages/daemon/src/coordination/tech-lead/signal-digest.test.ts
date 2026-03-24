// src/coordination/tech-lead/signal-digest.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { assembleSignalDigest, computeDriftIndicators, scanDeferredWork, type DigestDeps, type DigestConfig } from './signal-digest.js';

function makeDeps(overrides: Partial<DigestDeps> = {}): DigestDeps {
  return {
    getReviewFindings: vi.fn().mockResolvedValue([]),
    getRunOutcomes: vi.fn().mockResolvedValue([]),
    getTestHealth: vi.fn().mockResolvedValue([]),
    getActiveProposals: vi.fn().mockResolvedValue([]),
    getPriorRejections: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeConfig(tmpDir: string, overrides: Partial<DigestConfig> = {}): DigestConfig {
  return {
    lookbackWindowMs: 172800000,
    maxEntriesPerSection: 50,
    deferredWorkPaths: [],
    deferredWorkExclude: ['node_modules'],
    workspacePath: tmpDir,
    traceabilityPath: join(tmpDir, '.specify/traceability.yml'),
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tl-digest-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('assembleSignalDigest', () => {
  it('assembles digest with all sources available', async () => {
    const deps = makeDeps({
      getReviewFindings: vi.fn().mockResolvedValue([
        { recordId: 'r1', description: 'test', severity: 5, artifactPatterns: ['src/'] },
      ]),
    });
    const config = makeConfig(tmpDir);

    const digest = await assembleSignalDigest('scheduled', deps, config);

    expect(digest.trigger).toBe('scheduled');
    expect(digest.reviewFindings).toHaveLength(1);
    expect(digest.missingSources).toEqual([]);
    expect(digest.id).toBeTruthy();
    expect(digest.assembledAt).toBeTruthy();
  });

  it('includes missing sources when a dep fails', async () => {
    const deps = makeDeps({
      getReviewFindings: vi.fn().mockRejectedValue(new Error('unavailable')),
      getRunOutcomes: vi.fn().mockRejectedValue(new Error('unavailable')),
    });
    const config = makeConfig(tmpDir);

    const digest = await assembleSignalDigest('scheduled', deps, config);

    expect(digest.missingSources).toContain('review_findings');
    expect(digest.missingSources).toContain('run_outcomes');
    expect(digest.reviewFindings).toEqual([]);
  });

  it('caps entries per section', async () => {
    const findings = Array.from({ length: 60 }, (_, i) => ({
      recordId: `r${i}`,
      description: `finding ${i}`,
      severity: 5,
      artifactPatterns: ['src/'],
    }));
    const deps = makeDeps({
      getReviewFindings: vi.fn().mockResolvedValue(findings),
    });
    const config = makeConfig(tmpDir, { maxEntriesPerSection: 10 });

    const digest = await assembleSignalDigest('scheduled', deps, config);

    expect(digest.reviewFindings).toHaveLength(10);
  });
});

describe('computeDriftIndicators', () => {
  it('detects missing files referenced in traceability', async () => {
    await mkdir(join(tmpDir, '.specify'), { recursive: true });
    await writeFile(join(tmpDir, '.specify/traceability.yml'), `
STACK-AC-FOO:
  parent: ARCH-AC-FOO
  code_paths:
    - src/foo.ts
    - src/bar.ts
`);
    // Create only one of the two files
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src/foo.ts'), 'export const foo = 1;');

    const indicators = await computeDriftIndicators(
      join(tmpDir, '.specify/traceability.yml'),
      tmpDir,
    );

    expect(indicators).toHaveLength(1);
    expect(indicators[0]!.codePath).toBe('src/bar.ts');
    expect(indicators[0]!.issue).toBe('missing_file');
  });

  it('returns empty for non-existent traceability file', async () => {
    const indicators = await computeDriftIndicators(
      join(tmpDir, 'nonexistent.yml'),
      tmpDir,
    );
    expect(indicators).toEqual([]);
  });
});

describe('scanDeferredWork', () => {
  it('counts TODO, FIXME, HACK markers', async () => {
    const srcDir = join(tmpDir, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'a.ts'), 'const x = 1; // TODO: fix this\n// FIXME: broken\n');
    await writeFile(join(srcDir, 'b.ts'), '// HACK: temporary workaround\n');

    const results = await scanDeferredWork([srcDir], ['node_modules']);

    const total = results.reduce((sum, e) => sum + e.count, 0);
    expect(total).toBe(3);
  });

  it('excludes specified directories', async () => {
    const srcDir = join(tmpDir, 'src');
    const nmDir = join(srcDir, 'node_modules');
    await mkdir(nmDir, { recursive: true });
    await writeFile(join(nmDir, 'lib.ts'), '// TODO: not counted\n');

    const results = await scanDeferredWork([srcDir], ['node_modules']);
    const total = results.reduce((sum, e) => sum + e.count, 0);
    expect(total).toBe(0);
  });

  it('returns empty for non-existent paths', async () => {
    const results = await scanDeferredWork([join(tmpDir, 'nope')], []);
    expect(results).toEqual([]);
  });
});
