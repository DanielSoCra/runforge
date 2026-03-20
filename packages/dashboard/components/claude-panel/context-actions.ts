export interface ContextAction {
  label: string;
  /** Returns clipboard text, or null to just open the URL */
  buildClipboardText: ((sessionUrl: string) => string) | null;
}

/** Returns page-aware quick actions for the Claude panel */
export function getContextActions(pathname: string): ContextAction[] {
  const actions: ContextAction[] = [];

  if (/^\/runs\/[^/]+/.test(pathname)) {
    actions.push({
      label: 'Share this run with Claude',
      buildClipboardText: null, // caller fills in run context via buildRunContext
    });
    actions.push({
      label: 'Create follow-up issue from this run',
      buildClipboardText: null,
    });
  } else if (/^\/repos\/[^/]+/.test(pathname)) {
    actions.push({ label: 'Create issue for this repo', buildClipboardText: null });
    actions.push({ label: 'Review workflow matrix with Claude', buildClipboardText: null });
  } else if (pathname === '/cost') {
    actions.push({ label: 'Analyze cost trends with Claude', buildClipboardText: null });
  }

  // Always available (shown when no page-specific actions are present)
  if (actions.length === 0) {
    actions.push({ label: 'Open in new tab', buildClipboardText: null });
    actions.push({ label: 'Show QR code', buildClipboardText: null });
  }

  return actions;
}

export interface RunSummary {
  id: string;
  repo_owner: string;
  repo_name: string;
  issue_number: number;
  issue_title: string;
  outcome: string;
  total_cost: number;
  current_phase: string | null;
}

export function buildRunContext(run: RunSummary): string {
  return [
    `## Run Context`,
    `**Repo:** ${run.repo_owner}/${run.repo_name}`,
    `**Issue:** #${run.issue_number} — ${run.issue_title}`,
    `**Phase:** ${run.current_phase ?? 'unknown'}`,
    `**Outcome:** ${run.outcome}`,
    `**Cost:** $${run.total_cost.toFixed(2)}`,
    `**Run ID:** ${run.id}`,
  ].join('\n');
}
