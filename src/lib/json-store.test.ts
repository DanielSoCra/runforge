// src/lib/json-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeJsonSafe, readJsonSafe, appendJsonl, readJsonl, writeTextSafe } from './json-store.js';

describe('json-store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'json-store-'));
  });

  it('writeJsonSafe + readJsonSafe roundtrip', async () => {
    const path = join(dir, 'data.json');
    await writeJsonSafe(path, { a: 1, b: 'hello' });
    const result = await readJsonSafe<{ a: number; b: string }>(path);
    expect(result).toEqual({ ok: true, value: { a: 1, b: 'hello' } });
  });

  it('readJsonSafe returns err for missing file', async () => {
    const result = await readJsonSafe(join(dir, 'nope.json'));
    expect(result.ok).toBe(false);
  });

  it('readJsonSafe returns err for invalid JSON', async () => {
    const path = join(dir, 'bad.json');
    await writeTextSafe(path, 'not json');
    const result = await readJsonSafe(path);
    expect(result.ok).toBe(false);
  });

  it('appendJsonl + readJsonl roundtrip', async () => {
    const path = join(dir, 'log.jsonl');
    await appendJsonl(path, { id: 1 });
    await appendJsonl(path, { id: 2 });
    const entries = await readJsonl<{ id: number }>(path);
    expect(entries).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('readJsonl returns empty array for missing file', async () => {
    const entries = await readJsonl(join(dir, 'nope.jsonl'));
    expect(entries).toEqual([]);
  });

  it('readJsonl skips malformed lines', async () => {
    const path = join(dir, 'bad.jsonl');
    await writeTextSafe(path, '{"id":1}\nBAD LINE\n{"id":2}\n');
    const entries = await readJsonl<{ id: number }>(path);
    expect(entries).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('writeTextSafe writes raw text atomically', async () => {
    const path = join(dir, 'raw.txt');
    await writeTextSafe(path, 'hello world');
    const { readFile } = await import('fs/promises');
    const content = await readFile(path, 'utf-8');
    expect(content).toBe('hello world');
  });
});
