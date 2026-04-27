// src/control-plane/integration.ts
import { git } from '../lib/git.js';
import { ok, err, type Result } from '../lib/result.js';

export interface IntegrationResult {
  success: boolean;
  conflicted: boolean;
  pushed?: boolean;
  pushError?: string;
  error?: string;
}

let integrationLock = false;

export function acquireIntegrationLock(): boolean {
  if (integrationLock) return false;
  integrationLock = true;
  return true;
}

export function releaseIntegrationLock(): void {
  integrationLock = false;
}

export function isIntegrationLocked(): boolean {
  return integrationLock;
}

export async function integrateToStaging(
  featureBranch: string,
  stagingBranch: string,
  repoRoot?: string,
): Promise<Result<IntegrationResult>> {
  // 0. Acquire integration lock — only one run integrates at a time
  if (!acquireIntegrationLock()) {
    return err(new Error('Integration lock is held by another run'));
  }

  try {
    // 1. Checkout staging
    const checkout = await git(['checkout', stagingBranch], repoRoot);
    if (!checkout.ok) return err(checkout.error);

    // 2. Merge feature branch with --no-ff
    const merge = await git(
      ['merge', '--no-ff', featureBranch, '-m', `integrate: ${featureBranch}`],
      repoRoot,
    );
    if (!merge.ok) {
      // Check if it's a merge conflict (AA = both added, UU = both modified, DD = both deleted, etc.)
      const status = await git(['status', '--short'], repoRoot);
      const hasConflicts =
        status.ok &&
        /^(AA|UU|DD|AU|UA|DU|UD) /m.test(status.value);
      if (hasConflicts) {
        // Abort the merge
        const abort = await git(['merge', '--abort'], repoRoot);
        if (!abort.ok) {
          return err(new Error(`Merge conflict detected and abort failed: ${abort.error.message}`));
        }
        return ok({ success: false, conflicted: true, error: 'Merge conflicts detected' });
      }
      // No conflict markers — the merge failed for another reason (e.g. branch not found)
      return err(merge.error);
    }

    // 3. Push the feature branch first so its commit history is preserved as
    // a reviewable unit on the remote (otherwise it only appears as part of
    // the integrate merge into staging). Best-effort — non-fatal on failure.
    await git(['push', 'origin', featureBranch], repoRoot);

    // 4. Push the staging branch to origin so the autonomous loop's output is
    // visible to the Operator without manual intervention. Per L0-AC-VISION
    // and FUNC-AC-PIPELINE: pre-production delivery is autonomous; only
    // production releases need Operator approval. A push failure does NOT
    // fail the integration — the local merge already happened and is
    // recoverable; we just record it on the result for downstream logging.
    const push = await git(['push', 'origin', stagingBranch], repoRoot);
    if (!push.ok) {
      return ok({ success: true, conflicted: false, pushed: false, pushError: push.error.message });
    }

    return ok({ success: true, conflicted: false, pushed: true });
  } finally {
    releaseIntegrationLock();
  }
}
