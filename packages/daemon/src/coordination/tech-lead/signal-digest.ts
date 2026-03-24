// src/coordination/tech-lead/signal-digest.ts — Deterministic assembly of SignalDigest from external sources
import { randomUUID } from 'crypto';
import { readFile, readdir, stat } from 'fs/promises';
import { join, relative } from 'path';
import { execFile } from 'child_process';
import type {
  CycleTrigger,
  SignalDigest,
  DeferredWorkEntry,
  DriftIndicatorEntry,
  DependencyRiskEntry,
} from './schemas.js';

// --- Dependency injection types ---

export interface DigestDeps {
  /** Query knowledge store for review findings relevant to tech lead */
  getReviewFindings: () => Promise<SignalDigest['reviewFindings']>;
  /** Query control plane for recent run outcomes */
  getRunOutcomes: (lookbackMs: number) => Promise<SignalDigest['runOutcomes']>;
  /** Get test health metrics */
  getTestHealth: () => Promise<SignalDigest['testHealth']>;
  /** Load active proposals for context */
  getActiveProposals: () => Promise<SignalDigest['activeProposals']>;
  /** Load prior rejections for context */
  getPriorRejections: () => Promise<SignalDigest['priorRejections']>;
}

export interface DigestConfig {
  lookbackWindowMs: number;
  maxEntriesPerSection: number;
  deferredWorkPaths: string[];
  deferredWorkExclude: string[];
  workspacePath: string;
  traceabilityPath: string;
}

const DEFAULT_DEFERRED_EXCLUDE = ['node_modules', 'dist', '.git', 'coverage', '.next'];
const DEFERRED_MARKER = /\b(TODO|FIXME|HACK)\b/;
const NPM_AUDIT_TIMEOUT_MS = 30_000;

export async function assembleSignalDigest(
  trigger: CycleTrigger,
  deps: DigestDeps,
  config: DigestConfig,
): Promise<SignalDigest> {
  const missingSources: string[] = [];

  const [reviewFindings, runOutcomes, testHealth, activeProposals, priorRejections] =
    await Promise.all([
      deps.getReviewFindings().catch(() => {
        missingSources.push('review_findings');
        return [] as SignalDigest['reviewFindings'];
      }),
      deps.getRunOutcomes(config.lookbackWindowMs).catch(() => {
        missingSources.push('run_outcomes');
        return [] as SignalDigest['runOutcomes'];
      }),
      deps.getTestHealth().catch(() => {
        missingSources.push('test_health');
        return [] as SignalDigest['testHealth'];
      }),
      deps.getActiveProposals().catch(() => []),
      deps.getPriorRejections().catch(() => []),
    ]);

  // These are local computations — run them in parallel but handle failures individually
  const [driftIndicators, deferredWork, dependencyRisks] = await Promise.all([
    computeDriftIndicators(config.traceabilityPath, config.workspacePath).catch(() => {
      missingSources.push('drift_indicators');
      return [] as DriftIndicatorEntry[];
    }),
    scanDeferredWork(
      config.deferredWorkPaths,
      config.deferredWorkExclude.length > 0 ? config.deferredWorkExclude : DEFAULT_DEFERRED_EXCLUDE,
    ).catch(() => {
      missingSources.push('deferred_work');
      return [] as DeferredWorkEntry[];
    }),
    runDependencyAudit(config.workspacePath).catch(() => {
      missingSources.push('npm_audit');
      return [] as DependencyRiskEntry[];
    }),
  ]);

  const cap = config.maxEntriesPerSection;

  return {
    id: randomUUID(),
    trigger,
    reviewFindings: reviewFindings.slice(0, cap),
    runOutcomes: runOutcomes.slice(0, cap),
    driftIndicators: driftIndicators.slice(0, cap),
    deferredWork: deferredWork.slice(0, cap),
    testHealth: testHealth.slice(0, cap),
    dependencyRisks: dependencyRisks.slice(0, cap),
    activeProposals,
    priorRejections,
    missingSources,
    assembledAt: new Date().toISOString(),
  };
}

// --- Drift detection ---

export async function computeDriftIndicators(
  traceabilityPath: string,
  workspacePath: string,
): Promise<DriftIndicatorEntry[]> {
  let raw: string;
  try {
    raw = await readFile(traceabilityPath, 'utf-8');
  } catch {
    return [];
  }

  const indicators: DriftIndicatorEntry[] = [];
  // Simple YAML parsing for code_paths — extract spec ID and paths
  const specBlocks = raw.split(/\n(?=\S)/);
  for (const block of specBlocks) {
    const idMatch = block.match(/^(STACK-[\w-]+):/);
    if (!idMatch) continue;
    const specId = idMatch[1]!;

    const pathsMatch = block.match(/code_paths:\s*\n((?:\s+-\s+.+\n?)+)/);
    if (!pathsMatch) continue;
    const paths = pathsMatch[1]!.match(/-\s+(.+)/g)?.map(m => m.replace(/^-\s+/, '').trim()) ?? [];

    for (const codePath of paths) {
      const fullPath = join(workspacePath, codePath);
      try {
        await stat(fullPath);
      } catch {
        indicators.push({ specId, codePath, issue: 'missing_file' });
      }
    }
  }

  return indicators;
}

// --- Deferred work scan ---

export async function scanDeferredWork(
  paths: string[],
  exclude: string[],
): Promise<DeferredWorkEntry[]> {
  const results = new Map<string, { count: number; markers: Set<string> }>();

  for (const basePath of paths) {
    await walkDir(basePath, exclude, async (filePath) => {
      try {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          const match = line.match(DEFERRED_MARKER);
          if (match) {
            const dir = relative(basePath, filePath).split('/').slice(0, -1).join('/') || '.';
            const key = `${basePath}/${dir}`;
            const entry = results.get(key) ?? { count: 0, markers: new Set<string>() };
            entry.count++;
            entry.markers.add(match[1]!);
            results.set(key, entry);
          }
        }
      } catch {
        // Skip unreadable files
      }
    });
  }

  return [...results.entries()].map(([directory, { count, markers }]) => ({
    directory,
    count,
    markers: [...markers],
  }));
}

async function walkDir(
  dir: string,
  exclude: string[],
  fn: (path: string) => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, exclude, fn);
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx|md)$/.test(entry.name)) {
      await fn(fullPath);
    }
  }
}

// --- Dependency audit ---

export async function runDependencyAudit(workspacePath: string): Promise<DependencyRiskEntry[]> {
  return new Promise((resolve) => {
    const child = execFile(
      'npm',
      ['audit', '--json', '--omit=dev'],
      { cwd: workspacePath, timeout: NPM_AUDIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, _stderr) => {
        // npm audit returns non-zero when vulnerabilities found — that's expected
        try {
          const parsed = JSON.parse(stdout);
          const risks: DependencyRiskEntry[] = [];
          const vulns = parsed.vulnerabilities ?? {};
          for (const [pkg, info] of Object.entries(vulns)) {
            const v = info as { severity?: string; via?: Array<{ url?: string }> };
            const severity = normalizeSeverity(v.severity);
            if (severity) {
              risks.push({
                packageName: pkg,
                currentVersion: 'unknown',
                severity,
                advisory: v.via?.[0]?.url ?? 'No advisory URL',
              });
            }
          }
          resolve(risks);
        } catch {
          resolve([]);
        }
      },
    );
    // Handle SIGTERM
    child.on('error', () => resolve([]));
  });
}

function normalizeSeverity(s?: string): DependencyRiskEntry['severity'] | null {
  if (s === 'low' || s === 'moderate' || s === 'high' || s === 'critical') return s;
  return null;
}
