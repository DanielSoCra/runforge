// src/validation/deploy.ts
import { runCommand } from '../lib/process.js';
import { ok, err, type Result } from '../lib/result.js';
import { validateGate1Command } from './gates.js';

export interface DeployConfig {
  deployCommand: string;
  healthCheckUrl: string;
  healthCheckIntervalMs: number;
  deployTimeoutMs: number;
  maxAttempts: number;
  cwd: string;
}

export interface DeployResult {
  status: 'healthy' | 'timeout' | 'failed';
  attempts: number;
}

export async function runDeploy(config: DeployConfig): Promise<Result<DeployResult>> {
  const validationError = validateGate1Command(config.deployCommand);
  if (validationError) {
    return err(new Error(validationError));
  }

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const deployResult = await runCommand('sh', ['-c', config.deployCommand], {
      cwd: config.cwd,
      timeoutMs: config.deployTimeoutMs,
    });

    if (!deployResult.ok) {
      if (attempt === config.maxAttempts) {
        return ok({ status: 'failed', attempts: attempt });
      }
      continue;
    }

    // Poll health check
    const healthy = await pollHealth(
      config.healthCheckUrl,
      config.healthCheckIntervalMs,
      config.deployTimeoutMs,
    );

    if (healthy) {
      return ok({ status: 'healthy', attempts: attempt });
    }

    if (attempt === config.maxAttempts) {
      return ok({ status: 'timeout', attempts: attempt });
    }
    // Retry: re-deploy
  }

  return ok({ status: 'failed', attempts: config.maxAttempts });
}

async function pollHealth(
  url: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(intervalMs, deadline - Date.now())),
      });
      if (response.ok) return true;
    } catch {
      // Connection refused, timeout, etc. — keep polling
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  return false;
}
