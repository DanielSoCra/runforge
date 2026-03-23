// src/control-plane/integration.ts
import { git } from '../lib/git.js';
import { ok, err, type Result } from '../lib/result.js';

export interface IntegrationResult {
  success: boolean;
  conflicted: boolean;
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

    return ok({ success: true, conflicted: false });
  } finally {
    releaseIntegrationLock();
  }
}
