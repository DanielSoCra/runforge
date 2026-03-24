import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/auto-claude.yml');

describe('auto-claude CI workflow', () => {
  const raw = readFileSync(WORKFLOW_PATH, 'utf-8');

  it('uses --frozen-lockfile for reproducible installs (#185)', () => {
    expect(raw).toContain('pnpm install --frozen-lockfile');
  });

  it('has concurrency control to prevent parallel runs on shared runner (#187)', () => {
    expect(raw).toContain('concurrency:');
    expect(raw).toContain('group: auto-claude-processor');
    expect(raw).toContain('cancel-in-progress: false');
  });

  it('should reference existing .ts file paths in run commands', () => {
    // Extract all .ts file paths referenced in tsx/node run commands
    const tsFileRefs = raw.matchAll(/(?:exec\s+tsx|npx\s+tsx|node)\s+(\S+\.ts)/g);

    let found = false;
    for (const match of tsFileRefs) {
      found = true;
      const filePath = match[1]!;
      // For pnpm --filter commands, resolve relative to the package dir
      const filterMatch = raw.match(
        new RegExp(`pnpm\\s+--filter\\s+(\\S+)\\s+exec\\s+tsx\\s+${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
      let absPath: string;
      if (filterMatch) {
        // Resolve relative to the matched package directory
        const pkgName = filterMatch[1]!;
        const pkgDir = pkgName.startsWith('@')
          ? resolve(REPO_ROOT, 'packages', pkgName.split('/')[1]!)
          : resolve(REPO_ROOT, 'packages', pkgName);
        absPath = resolve(pkgDir, filePath);
      } else {
        absPath = resolve(REPO_ROOT, filePath);
      }
      expect(
        existsSync(absPath),
        `Workflow references ${filePath} which does not exist at ${absPath}`,
      ).toBe(true);
    }
    expect(found, 'Expected at least one .ts file reference in the workflow').toBe(true);
  });

  it('uses pnpm --filter for tsx instead of npx to pin version via lockfile (#381)', () => {
    // npx tsx at repo root downloads an unpinned version — must use pnpm --filter
    expect(raw).not.toMatch(/npx\s+tsx/);
    expect(raw).toMatch(/pnpm\s+--filter\s+\S+\s+exec\s+tsx/);
  });
});
