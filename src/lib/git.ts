import { spawn } from 'child_process';
import { ok, err, type Result } from './result.js';

export async function git(args: string[], cwd?: string): Promise<Result<string>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const proc = spawn('git', args, { cwd });
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
    proc.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString().trim();
      const stderr = Buffer.concat(errChunks).toString().trim();
      if (code === 0) resolve(ok(stdout));
      else resolve(err(new Error(`git ${args[0]} failed (${code}): ${stderr}`)));
    });
    proc.on('error', (e) => resolve(err(e)));
  });
}

export function parseDiffStatTotal(stat: string): number {
  const insertions = stat.match(/(\d+) insertion/);
  const deletions = stat.match(/(\d+) deletion/);
  return (insertions ? Number(insertions[1]) : 0) + (deletions ? Number(deletions[1]) : 0);
}
