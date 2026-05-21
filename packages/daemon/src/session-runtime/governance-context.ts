import { readFile } from 'fs/promises';
import { isAbsolute, join } from 'path';
import type { Config } from '../config.js';

export interface GovernanceValues {
  dailyBudget: string;
  perRunBudget: string;
  maxPrLinesChanged: string;
}

export interface ResolvedGovernanceContext {
  content: string;
  sourcePath: string;
  fingerprint: string;
}

const GOVERNANCE_TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const DEFAULT_DOCUMENT_PATH = 'FACTORY_RULES.md';
const DEFAULT_MAX_PR_LINES_CHANGED = 2000;
const governanceCache = new Map<string, ResolvedGovernanceContext>();

function isTestEnv(): boolean {
  return process.env['NODE_ENV'] === 'test' || process.env['VITEST'] === 'true';
}

function formatMoney(value: number): string {
  return `$${value}`;
}

function buildGovernanceValues(config: Config): GovernanceValues {
  return {
    dailyBudget: formatMoney(config.dailyBudget),
    perRunBudget: formatMoney(config.perRunBudget),
    maxPrLinesChanged: `${config.governance?.maxPrLinesChanged ?? DEFAULT_MAX_PR_LINES_CHANGED} lines`,
  };
}

function fingerprintFor(path: string, values: GovernanceValues): string {
  return `${path}:${values.dailyBudget}:${values.perRunBudget}:${values.maxPrLinesChanged}`;
}

function repoRoot(): string {
  return join(import.meta.dirname, '../../../../');
}

function resolveGovernancePaths(config: Config, cwd: string): string[] {
  const configuredPath = config.governance?.documentPath ?? DEFAULT_DOCUMENT_PATH;
  if (isAbsolute(configuredPath)) return [configuredPath];

  const paths = [join(cwd, configuredPath)];
  if (configuredPath === DEFAULT_DOCUMENT_PATH) {
    const rootPath = join(repoRoot(), configuredPath);
    if (rootPath !== paths[0]) paths.push(rootPath);
  }
  return paths;
}

export function resolveGovernanceDocument(
  raw: string,
  values: GovernanceValues,
): string {
  const valueMap: Record<string, string> = { ...values };
  const unresolved = new Set<string>();
  const rendered = raw.replace(GOVERNANCE_TOKEN_RE, (match, key: string) => {
    const value = valueMap[key];
    if (value === undefined) {
      unresolved.add(key);
      return match;
    }
    return value;
  });

  if (unresolved.size > 0) {
    throw new Error(`unresolved governance parameter(s): ${[...unresolved].sort().join(', ')}`);
  }
  return rendered;
}

export async function loadGovernanceContext(
  config: Config,
  cwd = process.cwd(),
): Promise<ResolvedGovernanceContext> {
  const candidatePaths = resolveGovernancePaths(config, cwd);
  const values = buildGovernanceValues(config);
  const fingerprint = fingerprintFor(candidatePaths.join('|'), values);
  const cached = governanceCache.get(fingerprint);
  if (cached && !isTestEnv()) return cached;

  let raw: string | undefined;
  let sourcePath = candidatePaths[0]!;
  let lastError: unknown;
  for (const candidate of candidatePaths) {
    try {
      raw = await readFile(candidate, 'utf-8');
      sourcePath = candidate;
      lastError = undefined;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (raw === undefined && lastError !== undefined) {
    if (
      lastError instanceof Error &&
      'code' in lastError &&
      (lastError as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      throw new Error(`governance document not found at ${candidatePaths.join(' or ')}`);
    }
    throw lastError;
  }
  if (raw === undefined) {
    throw new Error(`governance document not found at ${candidatePaths.join(' or ')}`);
  }

  if (raw.trim().length === 0) {
    throw new Error(`governance document is empty at ${sourcePath}`);
  }

  const content = resolveGovernanceDocument(raw, values);
  const context = { content, sourcePath, fingerprint };
  if (!isTestEnv()) governanceCache.set(fingerprint, context);
  return context;
}

export async function preloadGovernanceContext(
  config: Config,
  cwd = process.cwd(),
): Promise<ResolvedGovernanceContext> {
  return loadGovernanceContext(config, cwd);
}

export function __clearGovernanceCacheForTests(): void {
  governanceCache.clear();
}
