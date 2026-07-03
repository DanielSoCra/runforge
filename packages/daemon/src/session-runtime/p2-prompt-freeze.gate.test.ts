// G3 — prompt-freeze + self-repair-removal acceptance gate.
//
// Self-hosting hardening: when the daemon runs against its OWN repo, HEAD moves
// under it. Two invariants must hold before that is safe:
//   (A) preloadPromptCache must freeze EVERY prompt template at boot — not just
//       the 5 PROMPT_CONTRACTS entries — so a mid-run checkout can never make
//       loadPromptTemplate read a mutated prompt off the moving working tree.
//   (B) the allowSelfRepair escape hatch must be gone from the config schema —
//       self-hosting forbids the daemon rewriting its own governance mid-flight.
//   (C) no prompt may be live-read off the working tree AFTER boot. Freezing the
//       runtime cache is insufficient while startInteractivePOSession still reads
//       product-owner-interactive.md directly off deps.promptsDir at session
//       start — that path must serve the boot-frozen copy, not a fresh disk read.
//
// RED at HEAD: preloadPromptCache loops only Object.keys(PROMPT_CONTRACTS) (5 of
// 18), config.ts still declares allowSelfRepair, and interactive-session-context
// still live-reads product-owner-interactive.md off disk.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __clearPromptCacheForTests, preloadPromptCache } from './runtime.js';

const PROMPTS_DIR = join(import.meta.dirname, '../../../../prompts');
const CONFIG_TS = join(import.meta.dirname, '../config.ts');
const INTERACTIVE_CTX = join(
  import.meta.dirname,
  '../coordination/product-owner/interactive-session-context.ts',
);

describe('G3 prompt-freeze + self-repair removal', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __clearPromptCacheForTests();
  });

  it('preloadPromptCache warms EVERY prompt template, not just the contract subset', async () => {
    const entries = await readdir(PROMPTS_DIR);
    const promptFiles = entries.filter((f) => f.endsWith('.md'));
    expect(
      promptFiles.length,
      'expected the repo prompts/ dir to hold more than the 5 contracted templates',
    ).toBeGreaterThan(5);

    __clearPromptCacheForTests();
    // Bypass the test-env short-circuit (preloadPromptCache returns 0 under
    // VITEST) so the REAL preload loop runs against the REAL prompts/ dir.
    // At HEAD this warms only the 5 PROMPT_CONTRACTS entries.
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PROMPTS_DIR', PROMPTS_DIR);

    const warmed = await preloadPromptCache();

    expect(
      warmed,
      `every prompt must be frozen at boot: warmed ${warmed} of ${promptFiles.length} templates`,
    ).toBe(promptFiles.length);
  });

  it('the config schema no longer carries the allowSelfRepair escape hatch', async () => {
    const source = await readFile(CONFIG_TS, 'utf-8');
    expect(
      source.includes('allowSelfRepair'),
      'allowSelfRepair must be removed from config.ts — a self-hosting daemon may not grant itself a self-repair bypass',
    ).toBe(false);
  });

  it('the interactive PO session serves its prompt from the frozen cache, not a post-boot disk read', async () => {
    const source = await readFile(INTERACTIVE_CTX, 'utf-8');
    // The torn-read hazard: reading product-owner-interactive.md off
    // deps.promptsDir at session start re-reads the daemon's own (moving)
    // working tree. Self-hosting requires this prompt come from the
    // boot-frozen cache — so no live readFile of it may remain here.
    const livePromptRead = /readFile\([^;]*product-owner-interactive\.md/.test(
      source,
    );
    expect(
      livePromptRead,
      'startInteractivePOSession must not live-read product-owner-interactive.md off disk — route it through the boot-frozen prompt cache',
    ).toBe(false);
  });
});
