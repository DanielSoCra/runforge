// src/knowledge-sync/hash-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { HashRegistry, computeContentHash } from './hash-registry.js';

const tmpPath = () => join(tmpdir(), `hash-reg-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);

describe('computeContentHash', () => {
  it('produces a hex string', () => {
    const hash = computeContentHash(['src/**/*.ts'], 'description here');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is order-independent for artifact patterns', () => {
    const h1 = computeContentHash(['a', 'b'], 'desc');
    const h2 = computeContentHash(['b', 'a'], 'desc');
    expect(h1).toBe(h2);
  });

  it('trims description whitespace', () => {
    const h1 = computeContentHash(['a'], 'desc');
    const h2 = computeContentHash(['a'], '  desc  ');
    expect(h1).toBe(h2);
  });

  it('distinguishes different content', () => {
    const h1 = computeContentHash(['a'], 'desc1');
    const h2 = computeContentHash(['a'], 'desc2');
    expect(h1).not.toBe(h2);
  });
});

describe('HashRegistry', () => {
  let path: string;
  let registry: HashRegistry;

  beforeEach(() => {
    path = tmpPath();
    registry = new HashRegistry(path);
  });

  afterEach(async () => {
    try { await rm(path); } catch { /* ignore */ }
  });

  it('returns false for unknown hash', async () => {
    const known = await registry.has('abc123');
    expect(known).toBe(false);
  });

  it('returns true after recording a hash', async () => {
    await registry.record({
      id: 'test-id',
      contentHash: 'abc123',
      sourceName: 'mistakes',
      vaultDocumentRef: 'path/to/doc.md',
      syncedAt: new Date().toISOString(),
    });
    const known = await registry.has('abc123');
    expect(known).toBe(true);
  });

  it('persists entries across instances', async () => {
    await registry.record({
      id: 'test-id',
      contentHash: 'persistent-hash',
      sourceName: 'mistakes',
      vaultDocumentRef: 'path/to/doc.md',
      syncedAt: new Date().toISOString(),
    });

    const registry2 = new HashRegistry(path);
    const known = await registry2.has('persistent-hash');
    expect(known).toBe(true);
  });

  it('skips malformed lines on read and treats file as partial', async () => {
    const { appendFile } = await import('fs/promises');
    await appendFile(path, 'not-json\n');
    await registry.record({
      id: 'test-id',
      contentHash: 'valid-hash',
      sourceName: 'mistakes',
      vaultDocumentRef: 'path/to/doc.md',
      syncedAt: new Date().toISOString(),
    });

    const registry2 = new HashRegistry(path);
    expect(await registry2.has('valid-hash')).toBe(true);
    expect(await registry2.has('not-json')).toBe(false);
  });

  it('treats missing file as empty registry', async () => {
    const emptyRegistry = new HashRegistry('/nonexistent/path.jsonl');
    expect(await emptyRegistry.has('any-hash')).toBe(false);
  });
});
