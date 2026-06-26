// src/coordination/tech-lead/signal-digest.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  assembleSignalDigest,
  computeDriftIndicators,
  scanDeferredWork,
  runDependencyAudit,
  type DigestDeps,
  type DigestConfig,
} from './signal-digest.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const execFileMock = vi.mocked(execFile) as unknown as {
  mockImplementationOnce: (fn: (...args: unknown[]) => unknown) => void;
  mockReset: () => void;
};

function mockNpmAuditCallback(stdout: string, error: Error | null = null) {
  const child = new EventEmitter();
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args[3] as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    queueMicrotask(() => callback(error, stdout, ''));
    return child;
  });
}

function mockNpmAuditSpawnError(error = new Error('spawn failed')) {
  const child = new EventEmitter();
  execFileMock.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit('error', error));
    return child;
  });
}

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
  execFileMock.mockReset();
  mockNpmAuditCallback(JSON.stringify({ vulnerabilities: {} }));
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

  it('includes npm_audit as missing when dependency audit fails (#554)', async () => {
    execFileMock.mockReset();
    mockNpmAuditSpawnError(new Error('npm missing'));
    const deps = makeDeps();
    const config = makeConfig(tmpDir);

    const digest = await assembleSignalDigest('scheduled', deps, config);

    expect(digest.missingSources).toContain('npm_audit');
    expect(digest.dependencyRisks).toEqual([]);
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

  it('includes triage context when provided', async () => {
    const deps = makeDeps();
    const config = makeConfig(tmpDir, {
      untriagedIssues: [
        { issueNumber: 1, title: 'A', body: null, labels: [], severity: 'P2' },
        { issueNumber: 2, title: 'B', body: null, labels: [], severity: 'P3' },
      ],
      triageRemainingCap: 3,
    });

    const digest = await assembleSignalDigest('scheduled', deps, config);

    expect(digest.untriagedIssues).toHaveLength(2);
    expect(digest.triageRemainingCap).toBe(3);
  });

  it('renders untriaged issues into the serialized digest the agent receives', async () => {
    const deps = makeDeps();
    const config = makeConfig(tmpDir, {
      untriagedIssues: [
        { issueNumber: 42, title: 'Flaky retry loop', body: 'details', labels: ['review-finding'], severity: 'P2' },
      ],
      triageRemainingCap: 4,
    });

    const digest = await assembleSignalDigest('scheduled', deps, config);

    // The scheduler injects JSON.stringify(digest) as the prompt's signal_digest
    // variable, so the agent only "sees" the triage context if it survives
    // serialization.
    const rendered = JSON.stringify(digest);
    expect(rendered).toContain('"untriagedIssues"');
    expect(rendered).toContain('Flaky retry loop');
    expect(rendered).toContain('42');
    expect(rendered).toContain('"triageRemainingCap":4');
  });
});

describe('tech-lead prompt contract', () => {
  const promptPath = `${import.meta.dirname}/../../../../../prompts/tech-lead.md`;

  it('documents the triageDecisions output contract', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync(promptPath, 'utf-8');

    expect(content).toContain('triageDecisions');
    // Output contract uses the exact TriageDecision field names.
    expect(content).toContain('issueNumber');
    expect(content).toContain('verdict');
    expect(content).toContain('newSeverity');
    // Presents the untriaged inbox + cap to the agent.
    expect(content).toContain('untriagedIssues');
    expect(content).toContain('triageRemainingCap');
    // All four verdicts are described.
    for (const verdict of ['approve', 'reject', 'promote', 'defer']) {
      expect(content).toContain(verdict);
    }
  });
});

describe('runDependencyAudit', () => {
  it('parses npm audit vulnerabilities even when npm exits non-zero (#554)', async () => {
    execFileMock.mockReset();
    mockNpmAuditCallback(
      JSON.stringify({
        vulnerabilities: {
          lodash: {
            severity: 'high',
            via: [{ url: 'https://github.com/advisories/GHSA-test' }],
          },
          malformed: {
            severity: 'unknown',
            via: [{ url: 'https://example.invalid/ignored' }],
          },
        },
      }),
      new Error('npm audit found vulnerabilities'),
    );

    const risks = await runDependencyAudit(tmpDir);

    expect(risks).toEqual([
      {
        packageName: 'lodash',
        currentVersion: 'unknown',
        severity: 'high',
        advisory: 'https://github.com/advisories/GHSA-test',
      },
    ]);
  });

  it('rejects malformed npm audit JSON (#554)', async () => {
    execFileMock.mockReset();
    mockNpmAuditCallback('not json');

    await expect(runDependencyAudit(tmpDir)).rejects.toThrow();
  });

  it('rejects npm spawn errors (#554)', async () => {
    execFileMock.mockReset();
    mockNpmAuditSpawnError(new Error('spawn failed'));

    await expect(runDependencyAudit(tmpDir)).rejects.toThrow('spawn failed');
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
