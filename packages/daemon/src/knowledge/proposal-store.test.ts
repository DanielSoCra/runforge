// src/knowledge/proposal-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PromptProposalStore } from './proposal-store.js';

let dir: string;
let proposalsDir: string;
let versionsDir: string;
let store: PromptProposalStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proposal-store-test-'));
  proposalsDir = join(dir, 'proposals');
  versionsDir = join(dir, 'prompt-versions');
  await mkdir(proposalsDir, { recursive: true });
  await mkdir(versionsDir, { recursive: true });
  store = new PromptProposalStore(proposalsDir, versionsDir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PromptProposalStore', () => {
  describe('store and getPending', () => {
    it('stores a proposal and retrieves it as pending', async () => {
      const id = await store.store({
        templateName: 'worker.md',
        currentContent: 'old content',
        proposedContent: 'new content',
        reasoning: 'empirical evidence',
      });
      expect(id).toBeDefined();

      const pending = await store.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.templateName).toBe('worker.md');
      expect(pending[0]!.status).toBe('pending');
    });

    it('stores multiple proposals', async () => {
      await store.store({ templateName: 'a.md', currentContent: 'a', proposedContent: 'a2', reasoning: 'r' });
      await store.store({ templateName: 'b.md', currentContent: 'b', proposedContent: 'b2', reasoning: 'r' });
      const pending = await store.getPending();
      expect(pending).toHaveLength(2);
    });
  });

  describe('approve', () => {
    it('marks proposal as approved and records version history', async () => {
      const id = await store.store({
        templateName: 'worker.md',
        currentContent: 'old',
        proposedContent: 'new',
        reasoning: 'better',
      });
      await store.approve(id);

      const pending = await store.getPending();
      expect(pending).toHaveLength(0);

      const history = await store.getVersionHistory('worker.md');
      expect(history).toHaveLength(2);
      expect(history[0]!.content).toBe('old');
      expect(history[1]!.content).toBe('new');
      expect(history[1]!.status).toBe('approved');
    });
  });

  describe('reject', () => {
    it('marks proposal as rejected with rejectedAt timestamp', async () => {
      const id = await store.store({
        templateName: 'worker.md',
        currentContent: 'old',
        proposedContent: 'new',
        reasoning: 'better',
      });
      await store.reject(id);

      const pending = await store.getPending();
      expect(pending).toHaveLength(0);
    });
  });

  describe('cooldown', () => {
    it('isTemplateCoolingDown returns true for recently rejected template', async () => {
      const id = await store.store({
        templateName: 'worker.md',
        currentContent: 'old',
        proposedContent: 'new',
        reasoning: 'better',
      });
      await store.reject(id);

      const cooling = await store.isTemplateCoolingDown('worker.md');
      expect(cooling).toBe(true);
    });

    it('isTemplateCoolingDown returns false for non-rejected template', async () => {
      const cooling = await store.isTemplateCoolingDown('worker.md');
      expect(cooling).toBe(false);
    });
  });

  describe('version history', () => {
    it('accumulates version history across approvals', async () => {
      const id1 = await store.store({
        templateName: 'worker.md',
        currentContent: 'v1',
        proposedContent: 'v2',
        reasoning: 'first improvement',
      });
      await store.approve(id1);

      const id2 = await store.store({
        templateName: 'worker.md',
        currentContent: 'v2',
        proposedContent: 'v3',
        reasoning: 'second improvement',
      });
      await store.approve(id2);

      const history = await store.getVersionHistory('worker.md');
      expect(history).toHaveLength(3);
      expect(history[0]!.content).toBe('v1');
      expect(history[1]!.content).toBe('v2');
      expect(history[2]!.content).toBe('v3');
    });

    it('returns empty array when no history exists', async () => {
      const history = await store.getVersionHistory('nonexistent.md');
      expect(history).toHaveLength(0);
    });

    it('archives previous version on first approval for rollback (#264)', async () => {
      const id = await store.store({
        templateName: 'worker.md',
        currentContent: 'original',
        proposedContent: 'improved',
        reasoning: 'empirical evidence',
      });
      await store.approve(id);

      const history = await store.getVersionHistory('worker.md');
      // History should contain both the original (previous) and improved (new) versions
      expect(history).toHaveLength(2);
      expect(history[0]!.content).toBe('original');
      expect(history[1]!.content).toBe('improved');
    });

    it('does not duplicate previous version on subsequent approvals (#264)', async () => {
      const id1 = await store.store({
        templateName: 'worker.md',
        currentContent: 'v1',
        proposedContent: 'v2',
        reasoning: 'first',
      });
      await store.approve(id1);

      const id2 = await store.store({
        templateName: 'worker.md',
        currentContent: 'v2',
        proposedContent: 'v3',
        reasoning: 'second',
      });
      await store.approve(id2);

      const history = await store.getVersionHistory('worker.md');
      // v1 (original), v2 (first approval), v3 (second approval)
      expect(history).toHaveLength(3);
      expect(history[0]!.content).toBe('v1');
      expect(history[1]!.content).toBe('v2');
      expect(history[2]!.content).toBe('v3');
    });
  });
});
