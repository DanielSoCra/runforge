// GATE (security) — createProbeOracle is the verifier-gating chokepoint's runnability boundary.
// It must confirm runnable=true ONLY for a declared package.json script or a real workflow file
// under .github/workflows/, and fail closed on arbitrary files, directories, absolute refs, and
// any parent-traversal (codex review: arbitrary file existence wrongly asserted a runnable oracle).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProbeOracle } from './phases.js';

let repo: string;
let probe: (ref: { ref: string }) => boolean;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'probe-'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', 'test:e2e': 'playwright' } }));
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci');
  writeFileSync(join(repo, 'README.md'), '# hi');
  mkdirSync(join(repo, 'src'), { recursive: true });
  probe = createProbeOracle(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const p = (ref: string) => probe({ ref });

describe('createProbeOracle — runnable only for recognized oracles', () => {
  it('accepts declared package.json scripts', () => {
    expect(p('test')).toBe(true);
    expect(p('test:e2e')).toBe(true);
  });
  it('accepts a real workflow file under .github/workflows (bare name or path, .yml/.yaml)', () => {
    expect(p('ci')).toBe(true);
    expect(p('ci.yml')).toBe(true);
    expect(p('.github/workflows/ci.yml')).toBe(true);
  });
  it('REJECTS an arbitrary existing file (a README is not a runnable oracle) — the critical fix', () => {
    expect(p('README.md')).toBe(false);
  });
  it('REJECTS an existing directory', () => {
    expect(p('src')).toBe(false);
  });
  it('REJECTS absolute refs and parent-traversal (containment)', () => {
    expect(p('/etc/passwd')).toBe(false);
    expect(p('../other-repo/check')).toBe(false);
    expect(p('.github/workflows/../../README.md')).toBe(false);
  });
  it('REJECTS unknown scripts, missing workflows, and empty refs', () => {
    expect(p('nope')).toBe(false);
    expect(p('missing.yml')).toBe(false);
    expect(p('')).toBe(false);
    expect(p('   ')).toBe(false);
  });
});
