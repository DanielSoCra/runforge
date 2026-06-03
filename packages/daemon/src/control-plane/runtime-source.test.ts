import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../lib/git.js';
import { buildRuntimeSourcePolicy, validateRuntimeSource } from './runtime-source.js';
import type { Config } from '../config.js';

async function makeRepo(): Promise<{ repoRoot: string; cleanup: () => Promise<void> }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'runtime-source-'));
  await git(['init', '-q', '-b', 'dev'], repoRoot);
  await git(['config', 'user.email', 'test@test'], repoRoot);
  await git(['config', 'user.name', 'test'], repoRoot);
  await writeFile(join(repoRoot, 'README.md'), 'init\n');
  await git(['add', '.'], repoRoot);
  await git(['commit', '-q', '-m', 'init'], repoRoot);
  const remoteDir = await mkdtemp(join(tmpdir(), 'runtime-source-remote-'));
  await git(['init', '-q', '--bare', '-b', 'dev'], remoteDir);
  await git(['remote', 'add', 'origin', remoteDir], repoRoot);
  await git(['push', '-q', '-u', 'origin', 'dev'], repoRoot);
  return {
    repoRoot,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(remoteDir, { recursive: true, force: true });
    },
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: { owner: 'test', name: 'repo' },
    controlPort: 3847,
    controlHost: '127.0.0.1',
    pollIntervalMs: 30000,
    maxConcurrentRuns: 1,
    classifierBatchSize: 10,
    dailyBudget: 50,
    perRunBudget: 10,
    adapter: 'cli',
    autonomous: false,
    remoteControl: { enabled: false },
    providers: undefined,
    roleModels: {},
    runtimeSource: {
      enabled: true,
      requireClean: true,
      requireExpectedRef: true,
      allowSelfRepair: false,
      onUnhealthy: 'pause',
      ignoredDirtyPaths: ['state/'],
    },
    branches: { staging: 'dev', production: 'main' },
    webhooks: [],
    validation: {
      gate1Commands: [],
      maxFixCycles: 3,
      staticAnalysis: {
        maxComplexity: 15,
        maxFunctionLength: 50,
        maxFileSize: 500,
      },
      diminishingReturns: { minCycles: 2, improvementThreshold: 0.2 },
      healthCheckIntervalMs: 5000,
      deployTimeoutMs: 120000,
      maxDeployAttempts: 2,
      testCommands: [],
      maxTestFixAttempts: 3,
      failureExcerptLines: 50,
      proactiveIntervalMs: 1200000,
      proactiveMaxConcurrent: 1,
      proactiveThrottleThreshold: 0.8,
      proactiveRecentCommits: 20,
    },
    diagnosis: { confidenceThreshold: 0.7 },
    warmup: {
      threshold: 10,
      regressionThreshold: 3,
      samplingRate: 0.1,
      minSamplingRate: 0.01,
    },
    maxConsecutiveStuck: 3,
    gracePeriodMs: 30000,
    maxRunsPerIssue: 3,
    retryBackoffBaseMs: 60000,
    retryBackoffMaxMs: 1800000,
    governance: { documentPath: 'FACTORY_RULES.md', maxPrLinesChanged: 2000 },
    agentScopes: {},
    activePlugins: [],
    knowledge: {
      systemicProposalThreshold: 3,
      systemicProposalCooldownDays: 30,
      candidateTimeoutDays: 14,
      prospectiveSeverityThreshold: 5,
    },
    coordination: {
      useCoordinator: false,
      tickInterval: 5000,
      maxAgents: 10,
      reviewerInterval: 3600000,
      poInterval: 3600000,
      poIdeaDebounce: 300000,
      poFindingDailyCap: 5,
      plannerTimeout: 60000,
      maxAttemptsPerIssue: 3,
      diskSpaceThreshold: 2_000_000_000,
      gcInterval: 600000,
      conflictFileThreshold: 3,
      conflictLineThreshold: 100,
      mergeDependencyTimeout: 1800000,
      mergeValidationTimeout: 600000,
      mergePollInterval: 5000,
      mergePollMaxInterval: 60000,
      techLeadInterval: 7200000,
      techLeadEventDebounce: 300000,
      techLeadProposalExpiryMs: 604800000,
      techLeadLookbackWindowMs: 172800000,
      techLeadMaxEntriesPerSection: 50,
      maxConsecutiveTickErrors: 5,
    },
    ...overrides,
  };
}

describe('runtime source preflight', () => {
  let repo: Awaited<ReturnType<typeof makeRepo>>;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('derives the default expected ref from the staging branch', () => {
    const policy = buildRuntimeSourcePolicy(makeConfig(), repo.repoRoot);
    expect(policy.expectedRef).toBe('origin/dev');
    expect(policy.onUnhealthy).toBe('pause');
  });

  it('reports a clean source at the expected ref as healthy', async () => {
    const status = await validateRuntimeSource(
      buildRuntimeSourcePolicy(makeConfig(), repo.repoRoot),
    );
    expect(status.healthy).toBe(true);
    expect(status.clean).toBe(true);
    expect(status.synchronized).toBe(true);
    expect(status.expectedRef).toBe('origin/dev');
    expect(status.head).toMatch(/[a-f0-9]{40}/);
  });

  it('ignores configured daemon-owned dirty paths', async () => {
    await mkdir(join(repo.repoRoot, 'state'), { recursive: true });
    await writeFile(join(repo.repoRoot, 'state', 'daemon.json'), '{}\n');

    const status = await validateRuntimeSource(
      buildRuntimeSourcePolicy(makeConfig(), repo.repoRoot),
    );
    expect(status.healthy).toBe(true);
    expect(status.dirtyPaths).toEqual([]);
  });

  it('reports non-ignored dirty paths as unhealthy', async () => {
    await writeFile(join(repo.repoRoot, 'src.txt'), 'dirty\n');

    const status = await validateRuntimeSource(
      buildRuntimeSourcePolicy(makeConfig(), repo.repoRoot),
    );
    expect(status.healthy).toBe(false);
    expect(status.failureKind).toBe('dirty-runtime-source');
    expect(status.dirtyPaths).toEqual(['src.txt']);
    expect(status.action).toBe('pause');
  });

  it('reports a missing expected ref as unhealthy', async () => {
    const config = makeConfig({
      runtimeSource: {
        ...makeConfig().runtimeSource,
        expectedRef: 'origin/missing',
      },
    });

    const status = await validateRuntimeSource(
      buildRuntimeSourcePolicy(config, repo.repoRoot),
    );
    expect(status.healthy).toBe(false);
    expect(status.failureKind).toBe('missing-expected-ref');
    expect(status.expectedRef).toBe('origin/missing');
  });
});
