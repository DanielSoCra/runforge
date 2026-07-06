// src/control-plane/deployment-budget.ts — Deployment-level spend cap + hard abort
//
// Enforces DeploymentProfile.budget (FUNC-AC-FLEET). The accumulator is a durable
// per-deployment spend store under state/metrics/deployment-spend.json; the guard
// lives in the control-plane because deploymentId, run.cost, and the registry are
// all in scope at run admission/resumption.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  DecisionRequestSchema,
  type DecisionRequest,
} from '@runforge/decision-protocol';
import type { RunState } from '../types.js';
import { readJsonSafe, writeJsonSafe } from '../lib/json-store.js';
import type { DeploymentRegistry } from './deployment-registry/registry.js';

export interface DeploymentSpendEntry {
  ts: string;
  deploymentId: string;
  cost: number;
}

export interface DeploymentSpendAccumulator {
  totalForDeployment(deploymentId: string): number;
  append(entry: DeploymentSpendEntry): void | Promise<void>;
}

export interface DeploymentBudgetLedger {
  raise(request: Record<string, unknown>): Promise<{ decision_id: string; outcome: string }>;
}

export interface DeploymentBudgetDeps {
  accumulator: DeploymentSpendAccumulator;
  registry: DeploymentRegistry;
  ledger: DeploymentBudgetLedger;
}

export interface DeploymentBudgetDecision {
  proceed: boolean;
  reason?: string;
  deploymentId?: string;
  projectedSpend?: number;
  budget?: number;
}

const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, matching dailyBudget semantics
const SPEND_FILE = 'deployment-spend.json';

/** The phase emitted by the budget escalation builder. */
export const DEPLOYMENT_BUDGET_PHASE = 'deployment-budget';

/** Default request lifetime when the caller does not pin `expiresAt`. */
export const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Resolve the durable deployment-spend path under a state directory. */
export function deploymentSpendPath(stateDir: string): string {
  return join(stateDir, 'metrics', SPEND_FILE);
}

/**
 * Return an ISO-week token (`YYYY-Www`) used as the budget-window segment of the
 * deterministic decision id. A fixed (deployment, issue, epoch) always maps to the
 * same id, so per-poll re-raises dedupe through the ledger instead of storming.
 */
export function budgetEpoch(now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + 4 - ((d.getUTCDay() + 6) % 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Deterministic decision id for a deployment-budget escalation.
 * `deployment-budget:<deployment>:issue-<n>:<epoch>` ensures re-raises for the same
 * issue inside the same budget window dedupe through the ledger.
 */
export function buildDeploymentBudgetDecisionId(
  deploymentId: string,
  issueNumber: number,
  epoch = budgetEpoch(),
): string {
  return `deployment-budget:${deploymentId}:issue-${issueNumber}:${epoch}`;
}

export interface BuildDeploymentBudgetRequestArgs {
  issueNumber: number;
  deploymentId: string;
  totalSpend?: number;
  projectedSpend?: number;
  budget?: number;
  owner?: string;
  repo?: string;
  runId?: string;
  /** Injectable clock for deterministic tests (ISO 8601). */
  now?: string;
  /** Override the expiry (ISO 8601). Defaults to `now + 7 days`. */
  expiresAt?: string;
}

/** Build the issue URL from the run's repo coordinates. */
function issueUrlFor(
  issueNumber: number,
  owner = 'unknown-owner',
  repo = 'unknown-repo',
): string {
  return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
}

/**
 * Build a REAL `DecisionRequest` for a deployment-budget escalation.
 *
 * Validated through `DecisionRequestSchema.parse` so the ledger receives a
 * readable, non-quarantined decision. The id is deterministic on
 * (deployment, issue, budget epoch) so repeated over-budget polls dedupe.
 */
export function buildDeploymentBudgetDecisionRequest(
  args: BuildDeploymentBudgetRequestArgs,
): DecisionRequest {
  const {
    issueNumber,
    deploymentId,
    totalSpend = 0,
    projectedSpend = 0,
    budget,
    owner,
    repo,
    runId = `issue-${issueNumber}`,
    now,
    expiresAt,
  } = args;

  const decisionId = buildDeploymentBudgetDecisionId(deploymentId, issueNumber);
  const nowIso = now ?? new Date().toISOString();
  const resolvedExpiresAt =
    expiresAt ?? new Date(new Date(nowIso).getTime() + DEFAULT_EXPIRY_MS).toISOString();

  const budgetLine =
    budget !== undefined
      ? `Declared deployment budget: ${budget}.`
      : 'Declared deployment budget is missing.';
  const spendLine =
    projectedSpend > totalSpend
      ? `Projected deployment spend ${projectedSpend} (accumulated ${totalSpend} + per-run ${projectedSpend - totalSpend}).`
      : `Projected deployment spend ${projectedSpend} (accumulated ${totalSpend}).`;

  const context = [
    `Run ${runId} hard-aborted because deployment "${deploymentId}" is at or over its budget.`,
    spendLine,
    budgetLine,
    'The run is aborted to stay within the declared deployment budget.',
  ].join(' ');

  const request = {
    decision_id: decisionId,
    source_url: issueUrlFor(issueNumber, owner, repo),
    deployment: deploymentId,
    run_id: runId,
    worker_session_id: `deployment-budget-${issueNumber}`,
    phase: DEPLOYMENT_BUDGET_PHASE,
    risk_class: 'P0' as const,
    question: `Deployment ${deploymentId} budget exceeded for issue #${issueNumber}?`,
    context,
    options: [{ id: 'ack', label: 'Acknowledge' }],
    consequence_of_no_answer:
      'The run stays hard-aborted to stay within the deployment budget.',
    reversibility: 'reversible' as const,
    expires_at: resolvedExpiresAt,
    answer_schema: { kind: 'option' as const },
    resume_mode: 'requeue' as const,
    idempotency_key: decisionId,
  };

  return DecisionRequestSchema.parse(request);
}

/**
 * Durable per-deployment spend accumulator.
 *
 * - Stores `{ ts, deploymentId, cost }` entries in a flat JSON array.
 * - Rolling retention (default 90 days) so the guard reflects recent spend, not
 *   the entire history.
 * - Safe for concurrent use within a single process; the daemon serializes
 *   runPipeline completions per-process.
 */
export async function createDeploymentSpendAccumulator(
  stateDir: string,
  retentionMs: number = DEFAULT_RETENTION_MS,
): Promise<DeploymentSpendAccumulator> {
  const path = deploymentSpendPath(stateDir);

  async function load(): Promise<DeploymentSpendEntry[]> {
    const result = await readJsonSafe<unknown>(path);
    if (!result.ok) return [];
    if (!Array.isArray(result.value)) return [];
    return result.value.filter(
      (e): e is DeploymentSpendEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { ts?: unknown }).ts === 'string' &&
        typeof (e as { deploymentId?: unknown }).deploymentId === 'string' &&
        typeof (e as { cost?: unknown }).cost === 'number',
    );
  }

  return {
    totalForDeployment(deploymentId: string): number {
      // Synchronous read is intentional: the file is small and the caller
      // (checkDeploymentBudget) needs a synchronous total. We load on every
      // call to avoid stale in-memory state across crash-resume boundaries.
      // A real implementation could cache with invalidation; this is the
      // fail-closed, simplest-correct starting point.
      const records = loadSync(path);
      return records
        .filter((e) => e.deploymentId === deploymentId)
        .reduce((sum, e) => sum + e.cost, 0);
    },
    async append(entry: DeploymentSpendEntry): Promise<void> {
      const records = await load();
      const cutoff = new Date(Date.now() - retentionMs).toISOString();
      const retained = records.filter((e) => e.ts >= cutoff);
      retained.push(entry);
      await writeJsonSafe(path, retained);
    },
  };
}

function loadSync(path: string): DeploymentSpendEntry[] {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is DeploymentSpendEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { ts?: unknown }).ts === 'string' &&
        typeof (e as { deploymentId?: unknown }).deploymentId === 'string' &&
        typeof (e as { cost?: unknown }).cost === 'number',
    );
  } catch {
    return [];
  }
}

/**
 * Build the budget-escalation payload raised through `ledger.raise`.
 *
 * The object carries `deploymentId` (gate contract) plus every field the
 * production ledger wrapper needs to assemble a real `DecisionRequest`.
 */
function buildBudgetEscalation(
  run: RunState,
  deploymentId: string,
  reason: string,
  totalSpend: number,
  projectedSpend: number,
  budget?: number,
): Record<string, unknown> {
  return {
    deploymentId,
    issueNumber: run.issueNumber,
    run_id: `issue-${run.issueNumber}`,
    decision_id: buildDeploymentBudgetDecisionId(deploymentId, run.issueNumber),
    question: `Deployment ${deploymentId} budget exceeded for issue #${run.issueNumber}?`,
    context: `Projected deployment spend ${projectedSpend} (accumulated ${totalSpend}${
      run.perRunBudget !== undefined ? ` + per-run ${run.perRunBudget}` : ''
    })${budget !== undefined ? ` exceeds the declared budget ${budget}` : ' and the declared deployment budget is missing'}.`,
    reason,
    totalSpend,
    projectedSpend,
    budget,
    owner: run.repoOwner,
    repo: run.repoName,
    options: [{ id: 'ack', label: 'Acknowledge' }],
    consequence_of_no_answer: 'The run is hard-aborted to stay within the deployment budget.',
  };
}

/**
 * Check whether a run may proceed under its deployment's declared budget.
 *
 * - Reads `registry.readDeclaredData(run.deploymentId, 'budget')`.
 * - If `accumulator.totalForDeployment(deploymentId) + run.perRunBudget > budget`,
 *   returns `{ proceed: false }` and raises a fail-closed escalation.
 * - If the deployment or its budget is not found, returns `{ proceed: false }` and
 *   raises a fail-closed escalation (floors stay fail-closed).
 * - Otherwise returns `{ proceed: true }`.
 *
 * `budget` is a required profile field; a `not-found` deployment is treated as
 * fail-closed.
 */
export async function checkDeploymentBudget(
  run: RunState,
  deps: DeploymentBudgetDeps,
): Promise<DeploymentBudgetDecision> {
  const deploymentId = run.deploymentId;
  if (deploymentId === undefined) {
    return { proceed: true };
  }

  const totalSpend = deps.accumulator.totalForDeployment(deploymentId);
  const projectedSpend = totalSpend + (run.perRunBudget ?? 0);

  const budgetResult = deps.registry.readDeclaredData(deploymentId, 'budget');
  if (budgetResult.kind === 'not-found') {
    // Governed run with missing deployment/budget → fail closed. This matches the
    // plan's "floors stay fail-closed" rule and the function's docstring.
    await deps.ledger.raise(
      buildBudgetEscalation(
        run,
        deploymentId,
        'deployment budget not found',
        totalSpend,
        projectedSpend,
        undefined,
      ),
    );
    return {
      proceed: false,
      reason: 'deployment budget not found',
      deploymentId,
      projectedSpend,
    };
  }

  const budget = budgetResult.value as number;

  if (projectedSpend > budget) {
    await deps.ledger.raise(
      buildBudgetEscalation(
        run,
        deploymentId,
        'deployment budget exceeded',
        totalSpend,
        projectedSpend,
        budget,
      ),
    );
    return { proceed: false, reason: 'deployment budget exceeded', deploymentId, projectedSpend, budget };
  }

  return { proceed: true, deploymentId, projectedSpend, budget };
}

/**
 * Record a run's actual cost against its deployment's durable spend accumulator.
 * Call this at every runPipeline completion seam (fresh, crash-resume, parked-resume).
 */
export async function recordDeploymentSpend(
  run: RunState,
  deps: Pick<DeploymentBudgetDeps, 'accumulator'>,
): Promise<void> {
  const deploymentId = run.deploymentId;
  if (deploymentId === undefined) return;

  await deps.accumulator.append({
    ts: new Date().toISOString(),
    deploymentId,
    cost: run.cost ?? 0,
  });
}
