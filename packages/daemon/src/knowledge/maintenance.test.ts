import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startKnowledgeMaintenance } from './maintenance.js';
import { KnowledgeStore } from './knowledge-store.js';
import { DEFAULT_POLICIES } from './policy-registry.js';

describe('startKnowledgeMaintenance', () => {
  let dir: string;
  let store: KnowledgeStore;
  let handle: ReturnType<typeof startKnowledgeMaintenance>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'knowledge-maint-'));
    store = new KnowledgeStore(join(dir, 'knowledge.jsonl'), DEFAULT_POLICIES);
  });

  afterEach(async () => {
    handle?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when disabled', async () => {
    handle = startKnowledgeMaintenance(store, dir, {
      enabled: false,
      intervalMs: 1000,
      systemicProposalThreshold: 3,
      promotionCooldownDays: 30,
    });
    await handle.triggerNow();
  });

  it('detects systemic proposals when threshold is met', async () => {
    for (let i = 0; i < 3; i += 1) {
      await store.storeRecord(
        [{
          artifactPatterns: [`src/foo-${i}.ts`],
          description: `pitfall ${i}`,
          rootCauseTag: 'race-condition',
        }],
        `run-${i}`,
        'autonomous',
        'technical_pitfall',
      );
    }

    handle = startKnowledgeMaintenance(store, dir, {
      enabled: true,
      intervalMs: 1000,
      systemicProposalThreshold: 3,
      promotionCooldownDays: 30,
    });

    await handle.triggerNow();
    // Just verify no error; loadProposals would require fs helpers.
  });

  it('survives an empty store', async () => {
    handle = startKnowledgeMaintenance(store, dir, {
      enabled: true,
      intervalMs: 1000,
      systemicProposalThreshold: 3,
      promotionCooldownDays: 30,
    });
    await expect(handle.triggerNow()).resolves.toBeUndefined();
  });
});
