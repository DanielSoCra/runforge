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
import type { ProviderAdapter } from './types.js';
import {
  registerManagedProcess,
  unregisterManagedProcess,
  killProcessGroup,
} from '../managed-processes.js';

export class CodexCliAdapter implements ProviderAdapter {
  buildArgs(
    def: AgentDefinition,
    prompt: string,
    provider?: ProviderDefinition,
  ): string[] {
    const args = [...(provider?.executionFlags ?? ['exec'])];
    const model = provider?.model ?? def.modelOverride;
    if (model) args.push('--model', model);
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
    return ok({
      output,
      structuredData: { provider: 'codex-cli', raw: stdout },
      cost: 0,
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
    const command = provider?.binaryPath ?? provider?.cliTool ?? 'codex';
    const args = this.buildArgs(def, prompt, provider);
    const env = this.buildEnv(provider);
    const tempCwd = options?.cwd ? undefined : mkdtempSync(join(tmpdir(), 'codex-session-cwd-'));
    const cwd = options?.cwd ?? tempCwd;

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      // detached: child leads its own process group so the timeout AND the
      // operator force-kill can group-signal (`kill -pid`) the codex CLI and its
      // tool subprocesses together.
      const proc = spawn(command, args, { cwd, env, detached: true });
      registerManagedProcess(proc);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(proc, 'SIGTERM');
      }, def.timeoutMs);

      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d));

      proc.on('close', (code) => {
        clearTimeout(timer);
        unregisterManagedProcess(proc);
        if (tempCwd) {
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
        unregisterManagedProcess(proc);
        if (tempCwd) {
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
