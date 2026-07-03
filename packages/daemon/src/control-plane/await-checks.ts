// packages/daemon/src/control-plane/await-checks.ts
//
// Bounded polling of a ref's check-runs + legacy combined status against an
// EXPLICIT required-check-names list. Green only when every named check has
// concluded success; red on any named failure; timeout on budget exhaustion.
// An empty required-checks list returns `no-required-checks` so the caller can
// escalate — it is NEVER treated as a silent green.

export type AwaitRequiredChecksStatus =
  | { status: 'green'; reason?: string }
  | { status: 'red'; reason: string }
  | { status: 'timeout'; reason: string }
  | { status: 'no-required-checks'; reason: string };

export interface AwaitRequiredChecksArgs {
  octokit: unknown;
  owner: string;
  repo: string;
  ref: string;
  requiredChecks: string[];
  budgetMs?: number;
  pollMs?: number;
}

const DEFAULT_BUDGET_MS = 60_000;
const DEFAULT_POLL_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isFailureConclusion(
  conclusion: string | null,
): conclusion is 'failure' | 'timed_out' | 'cancelled' {
  return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled';
}

function isFailureStatus(state: string): boolean {
  return state === 'failure' || state === 'error';
}

/**
 * Poll until every named required check has concluded success, a named check
 * fails, or the budget expires. Empty `requiredChecks` is a dedicated
 * `no-required-checks` result so callers fail-closed rather than bypassing.
 */
export async function awaitRequiredChecks({
  octokit,
  owner,
  repo,
  ref,
  requiredChecks,
  budgetMs = DEFAULT_BUDGET_MS,
  pollMs = DEFAULT_POLL_MS,
}: AwaitRequiredChecksArgs): Promise<AwaitRequiredChecksStatus> {
  if (requiredChecks.length === 0) {
    return {
      status: 'no-required-checks',
      reason: 'requiredChecks list is empty — cannot determine which checks are required',
    };
  }

  const o = octokit as {
    checks: {
      listForRef: (params: { owner: string; repo: string; ref: string }) => Promise<{
        data: {
          total_count: number;
          check_runs: Array<{
            name: string;
            status: string;
            conclusion: string | null;
          }>;
        };
      }>;
    };
    repos: {
      getCombinedStatusForRef: (params: {
        owner: string;
        repo: string;
        ref: string;
      }) => Promise<{
        data: {
          state: string;
          statuses: Array<{ context: string; state: string }>;
        };
      }>;
    };
  };

  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    const [checksResult, statusResult] = await Promise.all([
      o.checks.listForRef({ owner, repo, ref }),
      o.repos.getCombinedStatusForRef({ owner, repo, ref }),
    ]);

    const checkRuns = checksResult.data.check_runs;
    const statuses = statusResult.data.statuses;
    const statusByContext = new Map(statuses.map((s) => [s.context, s.state]));

    const checkByName = new Map(checkRuns.map((c) => [c.name, c]));

    let allGreen = true;
    for (const name of requiredChecks) {
      const run = checkByName.get(name);
      if (run !== undefined) {
        if (run.status !== 'completed') {
          allGreen = false;
          continue;
        }
        if (run.conclusion === 'success') {
          continue;
        }
        if (isFailureConclusion(run.conclusion)) {
          return {
            status: 'red',
            reason: `required check "${name}" concluded ${run.conclusion}`,
          };
        }
        // neutral or other completed conclusion is not success
        allGreen = false;
        continue;
      }

      const legacyState = statusByContext.get(name);
      if (legacyState === 'success') {
        continue;
      }
      if (legacyState !== undefined && isFailureStatus(legacyState)) {
        return {
          status: 'red',
          reason: `required status "${name}" is ${legacyState}`,
        };
      }

      // Required check not observed yet
      allGreen = false;
    }

    if (allGreen) {
      return { status: 'green' };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(pollMs, remaining));
  }

  return {
    status: 'timeout',
    reason: `required checks did not all conclude success within ${budgetMs}ms`,
  };
}
