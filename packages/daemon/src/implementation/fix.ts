// src/implementation/fix.ts
import { ok, err, type Result } from '../lib/result.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { ReviewFinding } from '../types.js';
import { SessionError } from '../session-runtime/session-error.js';
import { createWorktree, mergeWorktree, deleteUnitBranch } from './worktree.js';
import { git } from '../lib/git.js';

export interface FixResult {
  success: boolean;
  cost: number;
  output: string;
}

/**
 * Fix operation: creates a single-unit workspace, spawns a worker session
 * with regression-test-first protocol, and merges the fix.
 * Per L3 spec: called by Validation Service when review gates or tests fail.
 */
export async function fix(
  findings: ReviewFinding[],
  targetBranch: string,
  runtime: SessionRuntime,
  repoRoot: string,
  specContent?: string,
  verificationCommand?: string,
): Promise<Result<FixResult>> {
  const fixId = `fix-${Date.now()}`;

  // 1. Create worktree
  const worktreeResult = await createWorktree(fixId, targetBranch, repoRoot);
  if (!worktreeResult.ok) {
    return err(worktreeResult.error);
  }

  try {
    // 2. Assemble fix context with regression-test-first protocol
    const findingsText = findings
      .map((f) => `- [${f.severity}] ${f.location}: ${f.description}`)
      .join('\n');

    const taskContext = [
      '## Fix Protocol',
      '',
      'Address each finding below. Choose the approach that fits the finding:',
      '',
      '- **For code changes that affect runtime behavior**: regression-test-first.',
      '  Write a failing test that exercises the bug, fix the code, confirm the test passes.',
      '- **For spec, prompt, config, or documentation changes** (e.g., findings citing',
      '  `prompts/*.md`, `.specify/**`, `auto-claude.config.json`, `*.md` docs): edit the',
      '  file directly. No regression test is required for prose or template edits — rely',
      '  on the static checks (`tsc --noEmit`, `pnpm test`, `prettier --check`) to confirm',
      '  nothing else broke.',
      '- **For configuration or wiring**: make the wiring change, then confirm via static checks.',
      '',
      'Always run `pnpm -r typecheck && pnpm -r test` (or the verification command below)',
      'before finishing. If you cannot reproduce a finding or it requires changes far',
      'outside this fix\'s scope, report DONE_WITH_CONCERNS with the rationale rather than',
      'BLOCKED with no diff — that distinguishes "tried and could not" from "did nothing".',
      '',
      '## Findings',
      '',
      findingsText,
    ].join('\n');

    // 3. Spawn worker session
    // Note: findingsText is already embedded in taskContext above (## Findings
    // section); passing it as a separate `findings` variable would be a silent
    // drop under the worker prompt contract (Codex review of fix/silent-prompt-vars
    // follow-up — variables not referenced in the template are now rejected).
    const sessionResult = await runtime.spawnSession(
      'worker',
      {
        variables: {
          task: taskContext,
          specs: specContent ?? '',
          verification: verificationCommand ?? 'pnpm -r run test',
          pitfalls: '',
        },
        workspacePath: worktreeResult.value,
        baseBranch: targetBranch,
      },
      0,
    );

    if (!sessionResult.ok) {
      const cost = sessionResult.error instanceof SessionError ? sessionResult.error.cost : 0;
      return ok({ success: false, cost, output: sessionResult.error.message });
    }

    const result = sessionResult.value;

    if (result.exitStatus !== 'completed' && result.exitStatus !== 'completed-with-concerns') {
      return ok({ success: false, cost: result.cost, output: result.output });
    }

    // 4. Merge fix into target branch
    const checkoutResult = await git(['checkout', targetBranch], repoRoot);
    if (!checkoutResult.ok) {
      return ok({ success: false, cost: result.cost, output: `Checkout failed: ${checkoutResult.error.message}` });
    }
    const mergeResult = await mergeWorktree(fixId, targetBranch, repoRoot);
    if (!mergeResult.ok) {
      return ok({ success: false, cost: result.cost, output: `Merge failed: ${mergeResult.error.message}` });
    }

    return ok({ success: true, cost: result.cost, output: result.output });
  } catch (e) {
    return ok({
      success: false,
      cost: e instanceof SessionError ? e.cost : 0,
      output: e instanceof Error ? e.message : String(e),
    });
  } finally {
    // Always clean up worktree and branch
    await git(['worktree', 'remove', `workspaces/${fixId}`, '--force'], repoRoot).catch(() => {});
    await deleteUnitBranch(fixId, repoRoot).catch(() => {});
  }
}
