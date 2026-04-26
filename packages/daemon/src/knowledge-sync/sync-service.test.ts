// src/knowledge-sync/sync-service.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createKnowledgeSyncService } from './sync-service.js';
import type { KnowledgeStore } from '../knowledge/knowledge-store.js';

const tmpDir = () =>
  join(
    tmpdir(),
    `sync-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

async function createVault(
  dir: string,
  manifestContent: string,
  docs: Record<string, string> = {},
) {
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, '00-Meta'), { recursive: true });
  await writeFile(join(dir, '00-Meta', 'auto-claude-sync.md'), manifestContent);
  for (const [relPath, content] of Object.entries(docs)) {
    const absPath = join(dir, relPath);
    await mkdir(join(absPath, '..'), { recursive: true });
    await writeFile(absPath, content);
  }
}

const validManifest = (relativePath: string) => `---
importSources:
  - name: mistakes
    relativePath: ${relativePath}
    recordType: technical_pitfall
    recursion: top-level-only
---
`;

describe('KnowledgeSyncService', () => {
  let stateDir: string;
  let vaultDir: string;
  let mockStore: KnowledgeStore;

  beforeEach(async () => {
    stateDir = tmpDir();
    vaultDir = tmpDir();
    await mkdir(stateDir, { recursive: true });

    mockStore = {
      storeRecord: vi.fn().mockResolvedValue(1),
    } as unknown as KnowledgeStore;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('returns no-op SyncRun when enabled is false', async () => {
    const service = createKnowledgeSyncService(
      { enabled: false, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      mockStore,
      stateDir,
    );
    const run = await service.triggerSync();
    expect(run.status).toBe('success');
    expect(run.importResult.created).toBe(0);
    expect(mockStore.storeRecord).not.toHaveBeenCalled();
  });

  it('returns failed SyncRun when vault manifest is missing', async () => {
    await mkdir(vaultDir, { recursive: true });
    const service = createKnowledgeSyncService(
      { enabled: true, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      mockStore,
      stateDir,
    );
    const run = await service.triggerSync();
    expect(run.status).toBe('failed');
    expect(run.importResult.errors.length).toBeGreaterThan(0);
    expect(mockStore.storeRecord).not.toHaveBeenCalled();
  });

  it('imports a vault document and stores as KnowledgeRecord', async () => {
    await createVault(vaultDir, validManifest('mistakes'), {
      'mistakes/my-pitfall.md': '---\n---\n\nDo not forget to reset the flag.',
    });

    const service = createKnowledgeSyncService(
      { enabled: true, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      mockStore,
      stateDir,
    );
    const run = await service.triggerSync();
    expect(run.status).toBe('success');
    expect(run.importResult.created).toBe(1);
    expect(mockStore.storeRecord).toHaveBeenCalledOnce();
  });

  it('deduplicates documents on second sync cycle', async () => {
    await createVault(vaultDir, validManifest('mistakes'), {
      'mistakes/my-pitfall.md': '---\n---\n\nDo not forget to reset the flag.',
    });

    const service = createKnowledgeSyncService(
      { enabled: true, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      mockStore,
      stateDir,
    );

    const run1 = await service.triggerSync();
    expect(run1.importResult.created).toBe(1);
    expect(run1.importResult.deduplicated).toBe(0);

    const run2 = await service.triggerSync();
    expect(run2.importResult.created).toBe(0);
    expect(run2.importResult.deduplicated).toBe(1);
    expect(mockStore.storeRecord).toHaveBeenCalledOnce();
  });

  it('drops concurrent trigger and warns', async () => {
    await createVault(vaultDir, validManifest('mistakes'), {});

    const mockStoreSlowly = {
      storeRecord: vi
        .fn()
        .mockImplementation(() => new Promise((r) => setTimeout(r, 100))),
    } as unknown as KnowledgeStore;

    const service = createKnowledgeSyncService(
      { enabled: true, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      mockStoreSlowly,
      stateDir,
    );

    const p1 = service.triggerSync();
    const p2 = service.triggerSync();
    const [run1, run2] = await Promise.all([p1, p2]);

    // One should complete normally; the other is the concurrent no-op
    const results = [run1, run2];
    const noOp = results.find((r) =>
      r.importResult.errors.some((e) => e.includes('already in progress')),
    );
    expect(noOp).toBeDefined();
  });

  it('returns partial status when some records fail to store', async () => {
    await createVault(vaultDir, validManifest('mistakes'), {
      'mistakes/doc1.md': '---\n---\n\nFirst pitfall.',
      'mistakes/doc2.md': '---\n---\n\nSecond pitfall.',
    });

    let callCount = 0;
    const flakyStore = {
      storeRecord: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(1);
        return Promise.reject(new Error('Store unavailable'));
      }),
    } as unknown as KnowledgeStore;

    const service = createKnowledgeSyncService(
      { enabled: true, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      flakyStore,
      stateDir,
    );
    const run = await service.triggerSync();
    expect(run.status).toBe('partial');
    expect(run.importResult.created).toBe(1);
    expect(run.importResult.storeErrors).toBe(1);
  });

  it('rejects path traversal in relativePath', async () => {
    await createVault(
      vaultDir,
      `---
importSources:
  - name: escape
    relativePath: ../../etc
    recordType: technical_pitfall
    recursion: top-level-only
---
`,
    );

    const service = createKnowledgeSyncService(
      { enabled: true, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      mockStore,
      stateDir,
    );
    const run = await service.triggerSync();
    // Path traversal source is skipped; no records created
    expect(run.importResult.parseFailures).toBeGreaterThan(0);
    expect(mockStore.storeRecord).not.toHaveBeenCalled();
  });

  it('persists SyncRun history', async () => {
    await createVault(vaultDir, validManifest('mistakes'), {});
    const service = createKnowledgeSyncService(
      { enabled: true, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      mockStore,
      stateDir,
    );
    await service.triggerSync();
    await service.triggerSync();

    const history = await service.getSyncHistory(10);
    expect(history.length).toBe(2);
    // Newest first
    expect(new Date(history[0]!.triggeredAt).getTime()).toBeGreaterThanOrEqual(
      new Date(history[1]!.triggeredAt).getTime(),
    );
  });

  it('respects limit in getSyncHistory', async () => {
    await createVault(vaultDir, validManifest('mistakes'), {});
    const service = createKnowledgeSyncService(
      { enabled: true, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      mockStore,
      stateDir,
    );
    await service.triggerSync();
    await service.triggerSync();
    await service.triggerSync();

    const history = await service.getSyncHistory(2);
    expect(history.length).toBe(2);
  });

  it('skips non-markdown files', async () => {
    await createVault(vaultDir, validManifest('mistakes'), {
      'mistakes/note.md': '---\n---\n\nA pitfall.',
      'mistakes/image.png': 'binary content',
    });

    const service = createKnowledgeSyncService(
      { enabled: true, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      mockStore,
      stateDir,
    );
    const run = await service.triggerSync();
    expect(run.importResult.created).toBe(1);
  });

  it('skips files with no body text after stripping frontmatter', async () => {
    await createVault(vaultDir, validManifest('mistakes'), {
      'mistakes/empty.md': '---\n---\n',
    });

    const service = createKnowledgeSyncService(
      { enabled: true, vaultPath: vaultDir, syncIntervalMinutes: 60 },
      mockStore,
      stateDir,
    );
    const run = await service.triggerSync();
    expect(run.importResult.parseFailures).toBe(1);
    expect(mockStore.storeRecord).not.toHaveBeenCalled();
  });
});
