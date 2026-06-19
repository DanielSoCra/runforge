// src/session-runtime/offload.test.ts
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { maybeOffload } from './offload.js';
import { readFile, rm } from 'fs/promises';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const workspacePath = mkdtempSync(join(tmpdir(), 'offload-test-'));

afterEach(async () => {
  // Clean up the .offload directory after each test
  await rm(join(workspacePath, '.offload'), { recursive: true, force: true });
});

afterAll(async () => {
  // Remove the mkdtemp root dir so it doesn't leak per test process
  await rm(workspacePath, { recursive: true, force: true });
});

describe('maybeOffload', () => {
  it('returns content unchanged when below threshold', async () => {
    const content = 'Hello, world!';
    const result = await maybeOffload(content, workspacePath, 200_000);
    expect(result.offloaded).toBe(false);
    expect(result.content).toBe(content);
    expect(result.filePath).toBeUndefined();
    expect(result.originalSize).toBeUndefined();
  });

  it('returns content unchanged when exactly at threshold', async () => {
    const content = 'x'.repeat(200_000);
    const result = await maybeOffload(content, workspacePath, 200_000);
    expect(result.offloaded).toBe(false);
    expect(result.content).toBe(content);
  });

  it('offloads content when above threshold', async () => {
    const content = 'x'.repeat(200_001);
    const result = await maybeOffload(content, workspacePath, 200_000);
    expect(result.offloaded).toBe(true);
    expect(result.originalSize).toBe(200_001);
    expect(result.filePath).toBeDefined();
  });

  it('creates the file on disk with original content', async () => {
    const content = 'y'.repeat(300_000);
    const result = await maybeOffload(content, workspacePath, 200_000);
    expect(result.offloaded).toBe(true);
    const fileContent = await readFile(result.filePath!, 'utf-8');
    expect(fileContent).toBe(content);
  });

  it('replacement message includes size and path', async () => {
    const content = 'z'.repeat(250_000);
    const result = await maybeOffload(content, workspacePath, 200_000);
    expect(result.offloaded).toBe(true);
    expect(result.content).toContain('250000');
    expect(result.content).toContain(result.filePath!);
  });

  it('uses default threshold of 200_000 when not specified', async () => {
    const small = 'a'.repeat(100);
    const smallResult = await maybeOffload(small, workspacePath);
    expect(smallResult.offloaded).toBe(false);

    const large = 'b'.repeat(200_001);
    const largeResult = await maybeOffload(large, workspacePath);
    expect(largeResult.offloaded).toBe(true);
  });

  it('offloaded file is placed inside .offload directory in workspace', async () => {
    const content = 'w'.repeat(300_000);
    const result = await maybeOffload(content, workspacePath, 200_000);
    expect(result.filePath!).toContain(join(workspacePath, '.offload'));
  });
});
