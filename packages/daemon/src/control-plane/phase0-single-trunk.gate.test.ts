import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// packages/daemon/src/control-plane/ -> repo root is four levels up.
const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

function readRootConfig(): { branches: { staging: string; production: string } } {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'auto-claude.config.json'), 'utf8'),
  ) as { branches: { staging: string; production: string } };
}

describe('phase 0 gate G3: single-trunk release config', () => {
  it('uses main/main and does not reference the retired dev branch', () => {
    const config = readRootConfig();

    expect(config.branches).toEqual({
      staging: 'main',
      production: 'main',
    });
    expect(Object.values(config.branches)).not.toContain('dev');
  });

  // The former "does not create a release PR when staging==production" case
  // asserted the VESTIGIAL `control-plane/release.ts` `createReleaseProposal`
  // (the staging→production PR model) returned `single-trunk-not-applicable`.
  // P5 (FUNC-AC-RELEASE v2) REPLACES that module with the per-deployment release
  // lane, which has no staging→production-PR concept at all — the release lane
  // structurally cannot open such a PR (it carries out a declared 3-shape path:
  // platform-performs / trigger-automated / record-only). That guarantee is now
  // architectural, so the module-coupled assertion is removed as obsolete rather
  // than repointed at a concept the new lane does not have. The single-trunk
  // CONFIG guarantee above (the load-bearing part of this gate) is unchanged.
});
