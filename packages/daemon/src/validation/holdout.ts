// src/validation/holdout.ts
import { runCommand } from '../lib/process.js';
import { ok, err, type Result } from '../lib/result.js';
import { validateGate1Command } from './gates.js';

export interface HoldoutScenarioResult {
  id: string;
  passed: boolean;
}

export interface HoldoutResult {
  passed: boolean;
  skipped: boolean;
  failures: HoldoutScenarioResult[];
}

export async function runHoldout(
  command: string | undefined,
  branchRef: string,
  cwd: string,
): Promise<Result<HoldoutResult>> {
  if (!command) {
    return ok({ passed: true, skipped: true, failures: [] });
  }

  const validationError = validateGate1Command(command);
  if (validationError) {
    return err(new Error(validationError));
  }

  const result = await runCommand('sh', ['-c', command], {
    cwd,
    env: { BRANCH_REF: branchRef },
    timeoutMs: 300_000, // 5 min
  });

  if (!result.ok) {
    return err(new Error(`Holdout runner failed: ${result.error.message}`));
  }

  try {
    const output = JSON.parse(result.value) as { scenarios: HoldoutScenarioResult[] };
    if (!Array.isArray(output.scenarios)) {
      return err(new Error('Holdout output missing scenarios array'));
    }
    const failures = output.scenarios.filter((s) => !s.passed);
    return ok({
      passed: failures.length === 0,
      skipped: false,
      failures,
    });
  } catch (e) {
    return err(new Error(`Failed to parse holdout output as JSON: ${e instanceof Error ? e.message : String(e)}`));
  }
}
