import { runCommand } from './process.js';
import type { Result } from './result.js';

export async function git(args: string[], cwd?: string): Promise<Result<string>> {
  return runCommand('git', args, { cwd });
}

export function parseDiffStatTotal(stat: string): number {
  const insertions = stat.match(/(\d+) insertion/);
  const deletions = stat.match(/(\d+) deletion/);
  return (insertions ? Number(insertions[1]) : 0) + (deletions ? Number(deletions[1]) : 0);
}
