import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = resolve(import.meta.dirname, '../../../..');

describe('.gitignore worktree coverage', () => {
  it('ignores .claude/worktrees/ so git-add cannot stage multi-GB worktree data', () => {
    const result = execSync('git check-ignore .claude/worktrees/', {
      cwd: ROOT,
      encoding: 'utf-8',
    }).trim();
    expect(result).toBe('.claude/worktrees/');
  });

  it('ignores top-level .worktrees/', () => {
    const result = execSync('git check-ignore .worktrees/', {
      cwd: ROOT,
      encoding: 'utf-8',
    }).trim();
    expect(result).toBe('.worktrees/');
  });

  it('does not duplicate .worktrees/ entry in .gitignore', () => {
    const gitignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/^\.worktrees\/$/gm) ?? [];
    expect(matches.length).toBe(1);
  });
});
