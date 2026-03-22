// fallback.ts — Direct CLI invocation fallback when Session Runtime is unreachable
// Governed by: STACK-AC-PIPELINE-DISPATCH

import { execFile } from 'child_process';
import type { DispatchRequest, DispatchResult, PipelineWorkType } from './session-types.js';
import { mapWorkTypeToSessionType } from './session-types.js';

// Skill references for each session type — maps to the Phase 1 Claude Code skills
const SKILL_REFS: Record<PipelineWorkType, string> = {
  'l2-brainstorm': 'spec-brainstorm-l2',
  'l3-generate': 'spec-generate-l3',
  'compliance-review': 'spec-review-compliance',
  'implementation': 'spec-implement',
};

/**
 * Checks whether an error is a connection error (ECONNREFUSED, ENOTFOUND, timeout).
 * Application-level errors (budget-exceeded, rate-limited) are NOT connection errors.
 */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return true;
  }
  if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
    return true;
  }
  return false;
}

/**
 * Falls back to direct `claude` CLI invocation when Session Runtime is unreachable.
 * Skips containment and cost tracking — logs a prominent warning.
 *
 * This fallback is temporary and will be removed when Phase 2 (ARCH-AC-SPEC-PIPELINE)
 * replaces the orchestration script.
 */
export async function directInvoke(req: DispatchRequest): Promise<DispatchResult> {
  const sessionType = mapWorkTypeToSessionType(req.sessionType);
  const skill = SKILL_REFS[req.sessionType];

  console.warn(
    `[pipeline-dispatch] WARNING: Session Runtime unreachable — falling back to direct CLI invocation ` +
    `for ${sessionType} (issue #${req.context.issueNumber}). Containment is DEGRADED.`,
  );

  const prompt = buildFallbackPrompt(req, skill);
  const startMs = Date.now();

  try {
    const output = await spawnClaude(prompt);
    const durationMs = Date.now() - startMs;

    return {
      status: 'completed',
      costIncurred: 0, // cannot track cost without Session Runtime
      durationMs,
      summary: output.slice(0, 500),
    };
  } catch (error) {
    const durationMs = Date.now() - startMs;
    const message = error instanceof Error ? error.message : String(error);

    return {
      status: 'failed',
      costIncurred: 0,
      durationMs,
      summary: `Direct invocation failed: ${message.slice(0, 400)}`,
    };
  }
}

function buildFallbackPrompt(req: DispatchRequest, skill: string): string {
  const feedbackClause = req.context.feedback
    ? ` Read the issue comments for feedback context.`
    : '';

  return (
    `Use the ${skill} skill to work on issue #${req.context.issueNumber} ` +
    `in repo ${req.context.repo}.${feedbackClause} Read the issue body for context and spec references.`
  );
}

function spawnClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['--dangerously-skip-permissions', '-p', '--max-budget-usd', '10', prompt],
      { timeout: 900_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`claude exited with error: ${error.message}${stderr ? `\nstderr: ${stderr}` : ''}`));
          return;
        }
        resolve(stdout);
      },
    );
    child.unref();
  });
}
