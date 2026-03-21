import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../../..');

function readFile(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

describe('pnpm version consistency', () => {
  it('CI workflow and cloud-init use the same pnpm version as package.json', () => {
    const pkg = JSON.parse(readFile('package.json'));
    const pinnedVersion = pkg.packageManager?.replace('pnpm@', '');
    expect(pinnedVersion).toBeTruthy();

    // CI workflow should NOT specify an explicit version (relies on packageManager field)
    const ciWorkflow = readFile('.github/workflows/auto-claude.yml');
    expect(ciWorkflow).not.toMatch(/version:\s*latest/);

    // If CI specifies a version, it must match
    const ciVersionMatch = ciWorkflow.match(/version:\s*['"]?(\d+\.\d+\.\d+)/);
    if (ciVersionMatch) {
      expect(ciVersionMatch[1]).toBe(pinnedVersion);
    }

    // cloud-init must use the pinned version, not @latest
    const cloudInit = readFile('infra/cloud-init.yml');
    expect(cloudInit).not.toMatch(/pnpm@latest/);
    expect(cloudInit).toContain(`pnpm@${pinnedVersion}`);
  });
});
