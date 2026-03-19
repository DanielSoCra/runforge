// src/lib/process.ts
import { spawn } from 'child_process';
import { ok, err, type Result } from './result.js';

export interface RunCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export function buildSafeEnv(extra?: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    TERM: 'dumb',
  };
  if (extra) Object.assign(safe, extra);
  return safe;
}

export async function runCommand(
  cmd: string,
  args: string[],
  options?: RunCommandOptions,
): Promise<Result<string>> {
  return new Promise((resolve) => {
    const env = options?.env
      ? buildSafeEnv(options.env)
      : buildSafeEnv();

    const proc = spawn(cmd, args, {
      cwd: options?.cwd,
      env,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => errChunks.push(d));

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, options.timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString().trim();
      const stderr = Buffer.concat(errChunks).toString().trim();
      if (timedOut) {
        resolve(err(new Error(`Command timed out after ${options?.timeoutMs}ms: ${cmd} ${args.join(' ')}`)));
      } else if (code === 0) {
        resolve(ok(stdout));
      } else {
        resolve(err(new Error(`${cmd} failed (${code}): ${stderr}`)));
      }
    });

    proc.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve(err(e));
    });
  });
}
