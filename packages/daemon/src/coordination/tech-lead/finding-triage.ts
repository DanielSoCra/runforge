// packages/daemon/src/coordination/tech-lead/finding-triage.ts
//
// Tech Lead finding triage decisions and Octokit application.
// Decisions are produced by the Tech Lead session; this module applies them.

import type { Octokit } from '@octokit/rest';
import { TriageDecisionSchema, type TriageDecision, type TriageApplyResult } from './schemas.js';

export { TriageDecisionSchema, type TriageDecision, type TriageApplyResult };

export const TRIAGE_VERDICTS = ['approve', 'reject', 'promote', 'defer'] as const;

export interface TriageApplyDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
  recordDecision?: (decision: TriageDecision) => Promise<void> | void;
  onCapConsumed?: () => void;
}

function formatAuditComment(decision: TriageDecision): string {
  const action = {
    approve: 'Tech Lead approved this finding for PO review.',
    reject: 'Tech Lead rejected this finding.',
    promote: `Tech Lead promoted severity and approved for PO review.`,
    defer: 'Tech Lead deferred this finding.',
  }[decision.verdict];
  return `**${action}**\n\n${decision.reason}`;
}

async function fetchIssueLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string[]> {
  try {
    const { data } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
    return (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

async function applyDecision(
  decision: TriageDecision,
  deps: TriageApplyDeps,
): Promise<void> {
  const { octokit, owner, repo, recordDecision } = deps;

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: decision.issueNumber,
    body: formatAuditComment(decision),
  });

  const labelsToAdd: string[] = ['tl-triaged'];
  const labelsToRemove: string[] = [];

  if (decision.verdict === 'approve' || decision.verdict === 'promote') {
    labelsToAdd.push('tl-approved');
  }

  if (decision.verdict === 'defer') {
    labelsToAdd.push('deferred');
  }

  if (decision.verdict === 'promote' && decision.newSeverity !== undefined) {
    labelsToAdd.push(decision.newSeverity);
    const currentLabels = await fetchIssueLabels(octokit, owner, repo, decision.issueNumber);
    const oldSeverity = currentLabels.find((l) => /^P\d$/.test(l));
    if (oldSeverity !== undefined && oldSeverity !== decision.newSeverity) {
      labelsToRemove.push(oldSeverity);
    }
  }

  // Apply `tl-triaged` (+ severity) FIRST, then record, then close a reject LAST.
  // There is no shared transaction across GitHub + the local store, so some
  // partial-failure window is irreducible — order to minimise the WORST outcome:
  //  - label first: a label failure leaves the issue open+untriaged, so it is
  //    re-surfaced next cycle (retryable, nothing lost).
  //  - close last + un-swallowed: a close failure leaves the issue
  //    open+labeled+recorded (visible, manually/idempotently recoverable) — it can
  //    NEVER be closed-but-unlabeled, a state fetchUntriagedIssues (open-only)
  //    could not re-surface (silently lost). Full idempotent GitHub+store
  //    reconciliation is a documented follow-up.
  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: decision.issueNumber,
    labels: labelsToAdd,
  });

  for (const label of labelsToRemove) {
    await octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: decision.issueNumber,
      name: label,
    }).catch(() => {});
  }

  if (recordDecision !== undefined) {
    await recordDecision(decision);
  }

  if (decision.verdict === 'reject') {
    await octokit.issues.update({
      owner,
      repo,
      issue_number: decision.issueNumber,
      state: 'closed',
      state_reason: 'not_planned',
    });
  }
}

export function consumesCap(decision: TriageDecision): boolean {
  return decision.verdict === 'approve' || decision.verdict === 'promote';
}

export async function applyTriageDecisions(
  decisions: TriageDecision[],
  deps: TriageApplyDeps,
  remainingCap: number,
): Promise<TriageApplyResult> {
  let applied = 0;
  let skipped = 0;
  let capRemaining = remainingCap;
  let capReached = false;

  // Apply non-cap decisions first, then cap-consuming ones up to remaining cap.
  const ordered = [
    ...decisions.filter((d) => !consumesCap(d)),
    ...decisions.filter((d) => consumesCap(d)),
  ];

  for (const decision of ordered) {
    if (consumesCap(decision)) {
      if (capRemaining <= 0) {
        skipped++;
        capReached = true;
        continue;
      }
      capRemaining--;
    }

    try {
      await applyDecision(decision, deps);
      applied++;
      if (consumesCap(decision)) {
        deps.onCapConsumed?.();
      }
    } catch (e) {
      console.warn(
        `[finding-triage] failed to apply triage for #${decision.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
      );
      skipped++;
    }
  }

  return { applied, skipped, capReached };
}
