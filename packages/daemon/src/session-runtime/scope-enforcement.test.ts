import { describe, it, expect } from 'vitest';
import type { DirectoryScope } from '../types.js';
import {
  checkToolCallScope,
  checkWriteScope,
  makeCliPermissionDenyEntries,
} from './scope-enforcement.js';

const scope: DirectoryScope = {
  readPaths: ['**/*'],
  writePaths: ['src/**', 'tests/**'],
  denyPaths: ['secret/**'],
};

describe('scope enforcement', () => {
  it('allows writes inside permitted paths', () => {
    const violation = checkWriteScope('src/app.ts', scope, {
      sessionId: 's1',
      agentType: 'worker',
      detectionLayer: 'pre-execution',
    });

    expect(violation).toBeNull();
  });

  it('rejects writes outside permitted paths', () => {
    const violation = checkWriteScope('docs/readme.md', scope, {
      sessionId: 's1',
      agentType: 'worker',
      detectionLayer: 'pre-execution',
    });

    expect(violation).toMatchObject({
      sessionId: 's1',
      agentType: 'worker',
      path: 'docs/readme.md',
      violationType: 'write-outside-permitted',
      detectionLayer: 'pre-execution',
    });
  });

  it('denied paths override write permissions', () => {
    const violation = checkWriteScope('secret/value.txt', {
      ...scope,
      writePaths: ['**/*'],
    }, {
      sessionId: 's1',
      agentType: 'worker',
      detectionLayer: 'pre-execution',
    });

    expect(violation).toMatchObject({
      path: 'secret/value.txt',
      violationType: 'access-to-denied',
    });
  });

  it('normalizes relative path traversal before matching', () => {
    const violation = checkWriteScope('src/../docs/readme.md', scope, {
      sessionId: 's1',
      agentType: 'worker',
      detectionLayer: 'pre-execution',
    });

    expect(violation?.path).toBe('docs/readme.md');
    expect(violation?.violationType).toBe('write-outside-permitted');
  });

  it('rejects paths that traverse above the workspace before an allowed path', () => {
    const violation = checkWriteScope('../../src/app.ts', scope, {
      sessionId: 's1',
      agentType: 'worker',
      detectionLayer: 'pre-execution',
    });

    expect(violation).toMatchObject({
      violationType: 'write-outside-permitted',
      path: '__outside_workspace__/src/app.ts',
    });
  });

  it('checks write tool calls against file path inputs', () => {
    const result = checkToolCallScope({
      tool: 'Write',
      input: { file_path: 'docs/readme.md' },
    }, scope, {
      sessionId: 's1',
      agentType: 'worker',
      detectionLayer: 'pre-execution',
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.violation.violationType).toBe('write-outside-permitted');
  });

  it('checks denied paths for read tool calls', () => {
    const result = checkToolCallScope({
      tool: 'Read',
      input: { file_path: 'secret/value.txt' },
    }, scope, {
      sessionId: 's1',
      agentType: 'reviewer-spec',
      detectionLayer: 'pre-execution',
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.violation.violationType).toBe('access-to-denied');
  });

  it('checks Bash write redirections against write scope', () => {
    const result = checkToolCallScope({
      tool: 'Bash',
      input: { command: 'printf changed > docs/readme.md' },
    }, scope, {
      sessionId: 's1',
      agentType: 'worker',
      detectionLayer: 'pre-execution',
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.violation.path).toBe('docs/readme.md');
  });

  it('converts deny paths to CLI permission deny entries', () => {
    expect(makeCliPermissionDenyEntries(scope)).toEqual(['secret/**']);
  });
});
