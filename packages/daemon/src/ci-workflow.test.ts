import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/auto-claude.yml');

describe('auto-claude CI workflow', () => {
  const raw = readFileSync(WORKFLOW_PATH, 'utf-8');

  it('should reference existing .ts file paths in run commands', () => {
    // Extract all .ts file paths referenced in tsx/node run commands
    const tsFileRefs = raw.matchAll(/(?:npx\s+tsx|node)\s+(\S+\.ts)/g);

    let found = false;
    for (const match of tsFileRefs) {
      found = true;
      const filePath = match[1]!;
      const absPath = resolve(REPO_ROOT, filePath);
      expect(
        existsSync(absPath),
        `Workflow references ${filePath} which does not exist at ${absPath}`,
      ).toBe(true);
    }
    expect(found, 'Expected at least one .ts file reference in the workflow').toBe(true);
  });
});
