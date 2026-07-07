import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { resolveControlToken } from './resolve-control-token.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..', '..');
const envMacPath = resolve(repoRoot, '.env.mac');

describe('resolveControlToken', () => {
  let originalCwd: string;
  let savedEnvMac: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    delete process.env.RUNFORGE_CONTROL_TOKEN;
    if (existsSync(envMacPath)) {
      savedEnvMac = readFileSync(envMacPath, 'utf-8');
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.RUNFORGE_CONTROL_TOKEN;
    if (savedEnvMac !== undefined) {
      writeFileSync(envMacPath, savedEnvMac);
    } else if (existsSync(envMacPath)) {
      unlinkSync(envMacPath);
    }
  });

  it('returns undefined when neither env nor .env.mac is set', () => {
    expect(resolveControlToken()).toBeUndefined();
  });

  it('prefers the env variable over .env.mac', () => {
    process.env.RUNFORGE_CONTROL_TOKEN = 'env-token';
    writeFileSync(envMacPath, 'RUNFORGE_CONTROL_TOKEN=env-mac-token\n');
    expect(resolveControlToken()).toBe('env-token');
  });

  it('reads the token from repo-root .env.mac regardless of cwd', () => {
    writeFileSync(envMacPath, 'RUNFORGE_CONTROL_TOKEN=repo-root-token\n');
    // Simulate running the CLI from a subdirectory (e.g. pnpm --filter).
    process.chdir(resolve(repoRoot, 'packages', 'daemon'));
    expect(resolveControlToken()).toBe('repo-root-token');
  });

  it('ignores empty values in .env.mac', () => {
    writeFileSync(envMacPath, 'RUNFORGE_CONTROL_TOKEN=\n');
    expect(resolveControlToken()).toBeUndefined();
  });

  it('returns the first non-empty RUNFORGE_CONTROL_TOKEN line', () => {
    writeFileSync(
      envMacPath,
      '# comment\nRUNFORGE_CONTROL_TOKEN=first\nRUNFORGE_CONTROL_TOKEN=second\n',
    );
    expect(resolveControlToken()).toBe('first');
  });
});
