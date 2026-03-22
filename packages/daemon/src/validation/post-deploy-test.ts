// src/validation/post-deploy-test.ts
import { runCommand } from '../lib/process.js';
import { validateGate1Command } from './gates.js';

export interface PostDeployTestConfig {
  testCommands: string[];
  testCommandTimeoutMs?: number;
  maxFixAttempts: number;
  failureExcerptLines: number;
  cwd: string;
  fixHandler?: (failureExcerpt: string) => Promise<boolean>;
}

export interface PostDeployTestResult {
  passed: boolean;
  fixAttempts: number;
  escalated: boolean;
  failedCommand?: string;
  failureExcerpt?: string;
  error?: string;
}

/**
 * Truncates verbose test output to the relevant failure excerpt.
 * Scans backwards for failure markers (FAIL, Error),
 * then takes surrounding context.
 */
export function truncateFailureOutput(output: string, maxLines: number): string {
  const lines = output.split('\n');
  if (lines.length <= maxLines) return output;

  let failIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/FAIL|Error/.test(lines[i]!)) {
      failIdx = i;
      break;
    }
  }
  if (failIdx === -1) {
    // No marker found — take last N lines
    return lines.slice(-maxLines).join('\n');
  }

  const half = Math.floor(maxLines / 2);
  const start = Math.max(0, failIdx - half);
  const end = Math.min(lines.length, start + maxLines);
  return lines.slice(start, end).join('\n');
}

export async function runPostDeployTests(config: PostDeployTestConfig): Promise<PostDeployTestResult> {
  // Validate all commands first
  for (const cmd of config.testCommands) {
    const validationError = validateGate1Command(cmd);
    if (validationError) {
      return { passed: false, fixAttempts: 0, escalated: false, error: validationError };
    }
  }

  let fixAttempts = 0;

  while (true) {
    // Run all test commands sequentially
    let allPassed = true;
    let failedCommand: string | undefined;
    let failureExcerpt: string | undefined;

    for (const cmd of config.testCommands) {
      const result = await runCommand('sh', ['-c', cmd], {
        cwd: config.cwd,
        timeoutMs: config.testCommandTimeoutMs ?? 300_000,
      });

      if (!result.ok) {
        allPassed = false;
        failedCommand = cmd;
        failureExcerpt = truncateFailureOutput(
          result.error.message,
          config.failureExcerptLines,
        );
        break;
      }
    }

    if (allPassed) {
      return { passed: true, fixAttempts, escalated: false };
    }

    if (!config.fixHandler) {
      return { passed: false, fixAttempts, escalated: false, failedCommand, failureExcerpt };
    }

    fixAttempts++;
    if (fixAttempts > config.maxFixAttempts) {
      return { passed: false, fixAttempts: fixAttempts - 1, escalated: true, failedCommand, failureExcerpt };
    }

    const fixed = await config.fixHandler(failureExcerpt!);
    if (!fixed) {
      return { passed: false, fixAttempts, escalated: true, failedCommand, failureExcerpt };
    }
    // Re-run all tests
  }
}
