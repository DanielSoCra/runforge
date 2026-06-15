import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ok, err, type Result } from '../../lib/result.js';
import type {
  AgentDefinition,
  ExitStatus,
  ProviderDefinition,
  SessionResult,
} from '../../types.js';
import { SessionError } from '../session-error.js';
import type {
  ProviderAdapter,
  SessionHandle,
  ContainmentCapabilityProfile,
} from './types.js';
import {
  registerManagedProcess,
  unregisterManagedProcess,
  killProcessGroup,
} from '../managed-processes.js';

export class PiCliAdapter implements ProviderAdapter {
  buildArgs(
    def: AgentDefinition,
    prompt: string,
    provider?: ProviderDefinition,
  ): string[] {
    const args = [...(provider?.executionFlags ?? ['run'])];
    const model = provider?.model ?? def.modelOverride;
    if (model !== undefined) args.push('--model', model);
    args.push(prompt);
    return args;
  }

  buildEnv(provider?: ProviderDefinition): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TERM: 'dumb',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      ...(provider?.env ?? {}),
    };
  }

  parseOutput(stdout: string): Result<SessionResult> {
    const output = stdout.trim();
    // pi CLI does not emit exact usage cost; record a conservative,
    // clearly-marked estimate rather than a silent zero.
    const estimatedCost = output.length > 0 ? Math.max(0.001, output.length * 0.0001) : 0.001;
    return ok({
      output,
      structuredData: { provider: 'pi-cli', raw: stdout },
      cost: estimatedCost,
      costEstimated: true,
      pitfallMarkers: [],
      exitStatus: this.parseExitStatusFromOutput(output),
    });
  }

  async spawn(
    def: AgentDefinition,
    prompt: string,
    options?: Parameters<ProviderAdapter['spawn']>[2],
  ): Promise<Result<SessionResult>> {
    const provider = options?.provider;
    const command = provider?.binaryPath ?? provider?.cliTool ?? 'pi';
    const args = this.buildArgs(def, prompt, provider);
    const env = this.buildEnv(provider);
    const tempCwd = options?.cwd !== undefined ? undefined : mkdtempSync(join(tmpdir(), 'pi-session-cwd-'));
    const cwd = options?.cwd ?? tempCwd;

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const proc = spawn(command, args, { cwd, env, detached: true });
      registerManagedProcess(proc);

      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const SIGTERM_GRACE_MS = 5_000;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(proc, 'SIGTERM');
        killTimer = setTimeout(() => {
          killProcessGroup(proc, 'SIGKILL');
        }, SIGTERM_GRACE_MS);
      }, def.timeoutMs);

      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d));

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        unregisterManagedProcess(proc);
        if (tempCwd !== undefined) {
          try {
            rmSync(tempCwd, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        }

        const stdout = Buffer.concat(chunks).toString();
        const stderr = Buffer.concat(errChunks).toString();
        if (this.isRateLimitError(stdout) || this.isRateLimitError(stderr)) {
          resolve(err(new SessionError('Rate limited by upstream provider', 0, true)));
          return;
        }

        const parsed = this.parseOutput(stdout);
        if (timedOut) {
          if (parsed.ok) {
            resolve(ok({ ...parsed.value, exitStatus: 'timed-out' }));
          } else {
            resolve(parsed);
          }
          return;
        }

        if (code === 0) {
          resolve(parsed);
          return;
        }

        const message =
          stderr.trim() ||
          stdout.trim() ||
          `${command} exited with code ${String(code)}`;
        resolve(err(new SessionError(message, 0)));
      });

      proc.on('error', (e) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        unregisterManagedProcess(proc);
        if (tempCwd !== undefined) {
          try {
            rmSync(tempCwd, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        }
        resolve(err(new SessionError(e.message, 0)));
      });
    });
  }

  async resume(
    def: AgentDefinition,
    prompt: string,
    continuationId: string,
    options?: Parameters<ProviderAdapter['spawn']>[2],
  ): Promise<Result<SessionResult>> {
    // pi CLI does not expose a native continuation primitive in this adapter.
    // The capability profile declares sessionContinuation: false; resume degrades
    // to a fresh spawn so the caller never receives a missing-method error.
    // We still surface the continuation id on success so the runtime can keep
    // tracking the attempted resume state.
    const result = await this.spawn(def, prompt, options);
    if (result.ok) {
      return ok({ ...result.value, continuationId });
    }
    return result;
  }

  async abort(handle: SessionHandle): Promise<void> {
    const pid = handle.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // best-effort: process may already be gone
    }
  }

  capabilities(): ContainmentCapabilityProfile {
    return {
      nativeGuardHooks: false,
      structuredOutput: false,
      exactCostReporting: false,
      sessionContinuation: false,
    };
  }

  isRateLimitError(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes('rate limit') ||
      lower.includes('rate_limit') ||
      /\b429\b/.test(lower) ||
      lower.includes('too many requests')
    );
  }

  parseExitStatusFromOutput(output: string): ExitStatus {
    const upper = output.toUpperCase();
    if (upper.includes('DONE_WITH_CONCERNS')) return 'completed-with-concerns';
    if (upper.includes('NEEDS_CONTEXT')) return 'needs-context';
    if (/(?:^|\*\*|^-\s+)\s*BLOCKED\s*(?:\*\*|$|\s*—|\s*:)/.test(upper)) {
      return 'blocked';
    }
    return 'completed';
  }
}
