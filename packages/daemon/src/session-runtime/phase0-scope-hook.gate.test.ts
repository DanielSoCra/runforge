import { execSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { DirectoryScope } from '../types.js';
import { generateScopeHookScript } from './scope-enforcement.js';

function runHookScript(
  script: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): { code: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'scope-hook-'));
  const scriptPath = join(dir, 'hook.mjs');
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  };
  const stdinJson = JSON.stringify({ tool_name: toolName, tool_input: toolInput });

  try {
    writeFileSync(scriptPath, script, { mode: 0o755 });
    execSync(`printf '%s' '${stdinJson.replace(/'/g, "'\\''")}' | node ${scriptPath}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (e: unknown) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? 1, stderr: String(err.stderr ?? '') };
  } finally {
    cleanup();
  }
}

describe('phase 0 gate G1: generated scope hook CLI contract', () => {
  const scope: DirectoryScope = {
    readPaths: ['**/*'],
    writePaths: ['allowed/**'],
    denyPaths: [],
  };

  const script = generateScopeHookScript(scope, {
    sessionId: 'phase0-g1',
    agentType: 'worker',
    detectionLayer: 'pre-execution',
  });

  it('denies an out-of-scope Write with exit 2 and stderr reason, and allows in-scope writes', () => {
    const denied = runHookScript(script, 'Write', {
      file_path: 'outside/file.ts',
      content: 'nope',
    });

    expect(denied.code).toBe(2);
    expect(denied.stderr).toContain('scope-violation');
    expect(denied.stderr).toContain('write-outside-permitted');
    expect(denied.stderr).toContain('outside/file.ts');

    const allowed = runHookScript(script, 'Write', {
      file_path: 'allowed/file.ts',
      content: 'ok',
    });

    expect(allowed).toEqual({ code: 0, stderr: '' });
  });
});
