// packages/daemon/src/control-plane/merge-decision/touched-paths.ts
//
// computeTouchedPaths — the LIVE shim that resolves what a change ACTUALLY
// touched, as the merge-base diff between the feature branch and the staging
// branch. The pure decideMerge consumes the returned list as `touchedPaths`
// (the scope tripwire + risk-path floor both read it), so this is the single
// place the live git state enters the merge decision.
//
// STUB — Kimi fills the body. Implementation contract:
//   - Compute the diff against the MERGE BASE (e.g.
//     `git diff --name-only <mergeBase>...<featureBranch>` or
//     `git merge-base staging feature` then `git diff --name-only <base> <feature>`),
//     NOT a raw two-dot diff, so unrelated staging commits do not pollute the set.
//   - Run in `repoRoot` (where staging is checked out — mirror the integrate
//     handler's mainRepoRoot, NOT the worktree workspaceCwd).
//   - FAIL-CLOSED: on any git error / ambiguous output, the caller must treat the
//     change as out-of-scope rather than empty-and-eligible. Surface that via the
//     return contract (this stub's signature returns string[]; if the body cannot
//     determine the set it should signal failure to the caller — e.g. return a
//     sentinel the integrate handler maps to escalate, or throw and let the
//     handler's fail-closed wrapper escalate). Kimi + the integrate-handler wiring
//     decide the exact channel; an EMPTY array must NEVER be silently returned on
//     error (that would read as "touched nothing" → trivially in-scope).

import { git } from '../../lib/git.js';

/**
 * Resolve the merge-base touched paths for `featureBranch` relative to
 * `stagingBranch`, run from `repoRoot`. Returns the touched path list.
 */
export async function computeTouchedPaths(
  featureBranch: string,
  stagingBranch: string,
  repoRoot?: string,
): Promise<string[]> {
  const diffResult = await git(
    ['diff', '--name-only', '--no-renames', `${stagingBranch}...${featureBranch}`],
    repoRoot,
  );
  if (!diffResult.ok) {
    throw new Error(
      `failed to compute touched paths for ${featureBranch} vs ${stagingBranch}: ${diffResult.error.message}`,
    );
  }
  return diffResult.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
