import { Octokit } from '@octokit/rest';
import type { WorkRequest, DetectedWorkType } from '../types.js';
import { ok, err, type Result } from '../lib/result.js';

/** Work types produced by feature-pipeline tier detection — derived from DetectedWorkType to prevent drift. */
export type FeaturePipelineWorkType = Extract<DetectedWorkType, 'implementation' | 'l3-generate' | 'l2-brainstorm'>;

export interface WorkDetector {
  detectReadyWork(): Promise<Result<WorkRequest[]>>;
  detectBugFixWork(): Promise<Result<WorkRequest | null>>;
  detectFeaturePipelineWork(): Promise<Result<WorkRequest | null>>;
  claimWork(issueNumber: number): Promise<Result<void>>;
  claimBugFixWork(issueNumber: number): Promise<Result<void>>;
  claimFeaturePipelineWork(issueNumber: number, workType: FeaturePipelineWorkType): Promise<Result<void>>;
  completeWork(issueNumber: number, comment: string): Promise<Result<void>>;
  completeBugFixWork(issueNumber: number, commitSha: string): Promise<Result<void>>;
  markStuck(issueNumber: number, comment: string): Promise<Result<void>>;
}

/** Extracts label name strings from the mixed GitHub label format. */
function getLabelNames(labels: Array<string | { name?: string }>): string[] {
  return labels.map((l) => typeof l === 'string' ? l : l.name ?? '');
}

export function createWorkDetector(octokit: Octokit, owner: string, repo: string): WorkDetector {
  return {
    async detectReadyWork(): Promise<Result<WorkRequest[]>> {
      try {
        const { data } = await octokit.issues.listForRepo({
          owner, repo, labels: 'ready', state: 'open', per_page: 100,
        });
        const requests: WorkRequest[] = data
          .filter((issue) => !('pull_request' in issue && issue.pull_request))
          .map((issue) => ({
            issueNumber: issue.number,
            title: issue.title,
            body: issue.body ?? '',
            labels: getLabelNames(issue.labels),
            specRefs: extractSpecRefs(issue.body ?? ''),
            scopeDescription: extractScopeDescription(issue.body ?? ''),
          }));
        return ok(requests);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async detectBugFixWork(): Promise<Result<WorkRequest | null>> {
      try {
        const { data } = await octokit.issues.listForRepo({
          owner, repo, labels: 'review-finding', state: 'open', per_page: 100,
        });
        const candidates = data
          .filter((issue) => !('pull_request' in issue && issue.pull_request))
          .filter((issue) => {
            const names = getLabelNames(issue.labels);
            return !names.includes('in-progress') && !names.includes('blocked') && !names.includes('stuck') && !names.includes('awaiting-l2-review');
          });

        // Severity-gated priority: P0 > P1 > P2 (with auto-fix-approved only), never P3
        const picked = pickHighestPriority(candidates);
        if (!picked) return ok(null);

        return ok({
          issueNumber: picked.number,
          title: picked.title,
          body: picked.body ?? '',
          labels: getLabelNames(picked.labels),
          specRefs: extractSpecRefs(picked.body ?? ''),
          scopeDescription: extractScopeDescription(picked.body ?? ''),
          workType: 'bug-fix' as const,
        });
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async detectFeaturePipelineWork(): Promise<Result<WorkRequest | null>> {
      try {
        // 4-tier priority scan matching pipeline.sh find_work()
        const tiers: Array<{ labels: string; exclude: string[]; workType: FeaturePipelineWorkType }> = [
          { labels: 'feature-pipeline,ready-to-implement', exclude: ['implementing', 'blocked', 'stuck', 'awaiting-l2-review'], workType: 'implementation' },
          { labels: 'feature-pipeline,l2-approved', exclude: ['l3-in-progress', 'blocked', 'stuck', 'awaiting-l2-review'], workType: 'l3-generate' },
          { labels: 'feature-pipeline,l2-in-progress', exclude: ['blocked', 'stuck', 'awaiting-l2-review'], workType: 'l2-brainstorm' },
          { labels: 'feature-pipeline,l1-approved', exclude: ['l2-in-progress', 'blocked', 'stuck', 'awaiting-l2-review'], workType: 'l2-brainstorm' },
        ];

        const tierResults = await Promise.all(tiers.map(async (tier) => {
          const { data } = await octokit.issues.listForRepo({
            owner, repo, labels: tier.labels, state: 'open', per_page: 100,
          });
          return { tier, data };
        }));

        for (const { tier, data } of tierResults) {
          const candidates = data
            .filter((issue) => !('pull_request' in issue && issue.pull_request))
            .filter((issue) => {
              const names = getLabelNames(issue.labels);
              return !tier.exclude.some((ex) => names.includes(ex));
            });

          if (candidates.length > 0) {
            const picked = candidates[0]!;
            return ok({
              issueNumber: picked.number,
              title: picked.title,
              body: picked.body ?? '',
              labels: getLabelNames(picked.labels),
              specRefs: extractSpecRefs(picked.body ?? ''),
              scopeDescription: extractScopeDescription(picked.body ?? ''),
              workType: tier.workType,
            });
          }
        }

        return ok(null);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async claimFeaturePipelineWork(issueNumber: number, workType: FeaturePipelineWorkType): Promise<Result<void>> {
      try {
        switch (workType) {
          case 'implementation':
            await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: 'ready-to-implement' }).catch(() => {});
            await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['implementing'] });
            break;
          case 'l3-generate':
            await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['l3-in-progress'] });
            break;
          case 'l2-brainstorm':
            await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['l2-in-progress'] });
            break;
        }
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async claimBugFixWork(issueNumber: number): Promise<Result<void>> {
      try {
        // Add in-progress but preserve review-finding label
        await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['in-progress'] });
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async completeBugFixWork(issueNumber: number, commitSha: string): Promise<Result<void>> {
      try {
        await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: 'in-progress' }).catch(() => {});
        await octokit.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
        await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body: `Fixed in commit ${commitSha}` }).catch(() => {});
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async claimWork(issueNumber: number): Promise<Result<void>> {
      try {
        await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: 'ready' });
        await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['in-progress'] });
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async completeWork(issueNumber: number, comment: string): Promise<Result<void>> {
      try {
        await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: 'in-progress' }).catch(() => {});
        await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['complete'] });
        await octokit.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
        await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body: comment }).catch(() => {});
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async markStuck(issueNumber: number, comment: string): Promise<Result<void>> {
      try {
        await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: 'in-progress' }).catch(() => {});
        await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['stuck'] });
        await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body: comment });
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
}

// ── Operator-retry: work-type → entry-label restoration ──────────────────────
//
// A `stuck` work request has LOST its entry label (consumed at CLAIM:
// `ready` removed at claimWork, `ready-to-implement` removed at
// claimFeaturePipelineWork). To re-admit it from scratch the operator-retry
// handler must RESTORE the correct entry label for the issue's work type and
// strip the now-stale active/claim labels so the restored tier re-detects it.
// This helper keeps that mapping co-located with the detection tiers above so
// the two never drift (the `removeActiveLabels` set is exactly each tier's
// dynamic exclude — the tier exclude minus the static `blocked`/`stuck`/
// `awaiting-l2-review` guards).

/** The entry label a stuck issue is re-admitted at, by work type. */
export type RetryEntryLabel =
  | 'ready'
  | 'review-finding'
  | 'ready-to-implement'
  | 'l2-approved'
  | 'l2-in-progress'
  | 'l1-approved';

export interface RetryRestorationPlan {
  /** Human-readable work type for the audit trail. */
  workType: string;
  /** The entry label to ADD/ensure so the restored tier re-detects the issue. */
  entryLabel: RetryEntryLabel;
  /** Stale active/claim labels to strip so the restored tier's exclude passes. */
  removeActiveLabels: string[];
}

export type RetryRestorationResult =
  | { ok: true; plan: RetryRestorationPlan }
  | { ok: false; reason: string };

function planFromFeaturePipelineWorkType(
  workType: string | undefined,
): RetryRestorationPlan | null {
  // Run-history fallback when no tier label survives. `l2-brainstorm` is
  // deliberately NOT resolvable here: it spans both the `l2-in-progress` and
  // `l1-approved` tiers, which only the labels disambiguate — so a bare
  // `l2-brainstorm` history with no tier label stays indeterminate (→ 409)
  // rather than guessing the wrong tier.
  switch (workType) {
    case 'implementation':
      return {
        workType: 'feature-impl',
        entryLabel: 'ready-to-implement',
        removeActiveLabels: ['implementing'],
      };
    case 'l3-generate':
      return {
        workType: 'l3-generate',
        entryLabel: 'l2-approved',
        removeActiveLabels: ['l3-in-progress', 'l3-review'],
      };
    default:
      return null;
  }
}

/**
 * Infer the from-scratch restoration plan for a `stuck` issue from its CURRENT
 * labels (the authoritative signal — detection is label-driven), with the last
 * run's `workType` as a fallback only when no tier label survives. Returns
 * `{ ok: false }` (→ the handler maps to 409) when the work type is
 * indeterminate, so a wrong-tier re-admit never happens.
 */
export function inferRetryRestoration(
  labels: string[],
  lastWorkType?: string,
): RetryRestorationResult {
  const has = (label: string): boolean => labels.includes(label);

  // Bug-fix: `review-finding` is PRESERVED across claim (claimBugFixWork only
  // adds `in-progress`), so it is still present when stuck. Not a feature
  // pipeline item.
  if (has('review-finding') && !has('feature-pipeline')) {
    return {
      ok: true,
      plan: {
        workType: 'bug',
        entryLabel: 'review-finding',
        removeActiveLabels: ['in-progress'],
      },
    };
  }

  if (has('feature-pipeline')) {
    // feature-impl: claim swapped `ready-to-implement` → `implementing`.
    if (has('implementing') || has('ready-to-implement')) {
      return {
        ok: true,
        plan: {
          workType: 'feature-impl',
          entryLabel: 'ready-to-implement',
          removeActiveLabels: ['implementing'],
        },
      };
    }
    // l3-generate: claim added `l3-in-progress` (kept `l2-approved`).
    if (has('l3-in-progress') || has('l3-review')) {
      return {
        ok: true,
        plan: {
          workType: 'l3-generate',
          entryLabel: 'l2-approved',
          removeActiveLabels: ['l3-in-progress', 'l3-review'],
        },
      };
    }
    // l1-approved tier: claim added `l2-in-progress` ON TOP of `l1-approved`.
    // Check before the bare `l2-in-progress` tier so the entry label is the
    // ORIGINAL `l1-approved` (and the claim `l2-in-progress` is stripped, since
    // the l1-approved tier excludes it).
    if (has('l1-approved')) {
      return {
        ok: true,
        plan: {
          workType: 'l2-brainstorm (l1-approved)',
          entryLabel: 'l1-approved',
          removeActiveLabels: ['l2-in-progress'],
        },
      };
    }
    // l2-in-progress tier: the entry label IS the claim label (idempotent).
    if (has('l2-in-progress')) {
      return {
        ok: true,
        plan: {
          workType: 'l2-brainstorm (l2-in-progress)',
          entryLabel: 'l2-in-progress',
          removeActiveLabels: [],
        },
      };
    }
    // l3-generate not yet started (only `l2-approved` survives).
    if (has('l2-approved')) {
      return {
        ok: true,
        plan: {
          workType: 'l3-generate',
          entryLabel: 'l2-approved',
          removeActiveLabels: ['l3-in-progress', 'l3-review'],
        },
      };
    }
    // feature-pipeline with no surviving tier label — last resort: run history.
    const fromHistory = planFromFeaturePipelineWorkType(lastWorkType);
    if (fromHistory !== null) return { ok: true, plan: fromHistory };
    return {
      ok: false,
      reason:
        'indeterminate feature-pipeline work type (no surviving tier label and no usable run-history work type)',
    };
  }

  // No feature-pipeline and no review-finding: a standard ready-work item whose
  // `ready` entry label was consumed at claim. Restore it.
  return {
    ok: true,
    plan: {
      workType: 'standard',
      entryLabel: 'ready',
      removeActiveLabels: ['in-progress'],
    },
  };
}

/**
 * Picks the highest-priority review-finding issue by severity label.
 * P0 > P1 > P2 (only with auto-fix-approved). P3 is never returned.
 */
interface IssueWithLabels {
  labels: Array<string | { name?: string }>;
  [key: string]: unknown;
}

function pickHighestPriority<T extends IssueWithLabels>(issues: T[]): T | null {
  const priorities: Array<{ priority: string; requiresApproval: boolean }> = [
    { priority: 'P0', requiresApproval: false },
    { priority: 'P1', requiresApproval: false },
    { priority: 'P2', requiresApproval: true },
  ];

  for (const { priority, requiresApproval } of priorities) {
    for (const issue of issues) {
      const labelNames = getLabelNames(issue.labels);
      if (!labelNames.includes(priority)) continue;
      if (requiresApproval && !labelNames.includes('auto-fix-approved')) continue;
      return issue;
    }
  }

  return null;
}

function extractSpecRefs(body: string): string[] {
  // Match spec IDs like FUNC-AC-PIPELINE, ARCH-AC-CONTROL-PLANE, STACK-AC-CONVENTIONS
  const matches = body.match(/[A-Z]+-[A-Z]+-[A-Z0-9-]+/g);
  return [...new Set(matches ?? [])];
}

/**
 * Extracts a scope description from the issue body.
 * Looks for an explicit "## Scope" section first, then falls back to the first
 * non-empty paragraph. Returns undefined if the body is empty or whitespace-only.
 */
function extractScopeDescription(body: string): string | undefined {
  if (!body.trim()) return undefined;

  // Look for an explicit scope section (## Scope, ### Scope, etc.)
  // Try to stop at the next heading; if none, capture everything after the Scope header.
  const scopeMatch = body.match(/^#{1,4}\s+Scope\s*\n([\s\S]*?)(?=\n#{1,4}\s)/im)
    ?? body.match(/^#{1,4}\s+Scope\s*\n([\s\S]*)/im);
  if (scopeMatch?.[1]?.trim()) {
    return scopeMatch[1].trim().slice(0, 500);
  }

  // Fall back to first non-empty paragraph (split on double newline)
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim());
  const first = paragraphs[0]?.trim();
  if (first) {
    return first.slice(0, 500);
  }

  return undefined;
}
