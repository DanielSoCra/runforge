import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from '../lib/result.js';
import type { Result } from '../lib/result.js';
import {
  detectConflicts,
  isSmallConflict,
  resolveConflicts,
  type ConflictInfo,
  type ConflictResolverConfig,
} from './conflict-resolver.js';

vi.mock('../lib/git.js', () => ({
  git: vi.fn(),
}));

vi.mock('../lib/process.js', () => ({
  runCommand: vi.fn(),
}));

import { git } from '../lib/git.js';
import { runCommand } from '../lib/process.js';

const mockedGit = vi.mocked(git);
const mockedRunCommand = vi.mocked(runCommand);

const defaultConfig: ConflictResolverConfig = {
  conflictFileThreshold: 3,
  conflictLineThreshold: 100,
};

describe('conflict-resolver', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('detectConflicts', () => {
    it('parses file list from git output', async () => {
      mockedGit.mockResolvedValue(ok('src/a.ts\nsrc/b.ts'));
      mockedRunCommand
        .mockResolvedValueOnce(ok('5'))
        .mockResolvedValueOnce(ok('3'));

      const result = await detectConflicts('/repo');

      expect(mockedGit).toHaveBeenCalledWith(
        ['diff', '--name-only', '--diff-filter=U'],
        '/repo',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.files).toEqual(['src/a.ts', 'src/b.ts']);
      expect(result.value.fileCount).toBe(2);
      expect(result.value.totalConflictMarkers).toBe(8);
    });

    it('returns err when git fails', async () => {
      mockedGit.mockResolvedValue(err(new Error('git broke')));

      const result = await detectConflicts('/repo');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/git broke/);
    });
  });

  describe('isSmallConflict', () => {
    it('returns true when under thresholds', () => {
      const info: ConflictInfo = { files: ['a.ts', 'b.ts'], fileCount: 2, totalConflictMarkers: 50 };
      expect(isSmallConflict(info, defaultConfig)).toBe(true);
    });

    it('returns false when over file threshold', () => {
      const info: ConflictInfo = {
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
        fileCount: 4,
        totalConflictMarkers: 10,
      };
      expect(isSmallConflict(info, defaultConfig)).toBe(false);
    });

    it('returns false when over line threshold', () => {
      const info: ConflictInfo = {
        files: ['a.ts'],
        fileCount: 1,
        totalConflictMarkers: 150,
      };
      expect(isSmallConflict(info, defaultConfig)).toBe(false);
    });
  });

  describe('resolveConflicts', () => {
    it('returns needs_human for large conflicts', async () => {
      // 4 files -> exceeds threshold of 3
      mockedGit.mockResolvedValue(ok('a.ts\nb.ts\nc.ts\nd.ts'));
      mockedRunCommand.mockResolvedValue(ok('1'));

      const resolveSession = vi.fn();
      const result = await resolveConflicts('/repo', defaultConfig, resolveSession);

      expect(result.needsHuman).toBe(true);
      expect(result.resolved).toBe(false);
      expect(resolveSession).not.toHaveBeenCalled();
    });

    it('calls resolveSession for small conflicts', async () => {
      mockedGit.mockResolvedValue(ok('a.ts\nb.ts'));
      mockedRunCommand.mockResolvedValue(ok('2'));
      const resolveSession = vi.fn().mockResolvedValue(ok(undefined));

      const result = await resolveConflicts('/repo', defaultConfig, resolveSession);

      expect(resolveSession).toHaveBeenCalledWith(['a.ts', 'b.ts'], '/repo');
      expect(result.resolved).toBe(true);
      expect(result.needsHuman).toBe(false);
    });

    it('returns needs_human when resolveSession fails', async () => {
      mockedGit.mockResolvedValue(ok('a.ts'));
      mockedRunCommand.mockResolvedValue(ok('2'));
      const resolveSession = vi.fn().mockResolvedValue(err(new Error('LLM failed')));

      const result = await resolveConflicts('/repo', defaultConfig, resolveSession);

      expect(result.needsHuman).toBe(true);
      expect(result.resolved).toBe(false);
      expect(result.reason).toMatch(/LLM failed/);
    });

    it('returns resolved:true when session succeeds', async () => {
      mockedGit.mockResolvedValue(ok('a.ts'));
      mockedRunCommand.mockResolvedValue(ok('1'));
      const resolveSession = vi.fn().mockResolvedValue(ok(undefined));

      const result = await resolveConflicts('/repo', defaultConfig, resolveSession);

      expect(result.resolved).toBe(true);
      expect(result.needsHuman).toBe(false);
    });
  });
});
