// src/knowledge/proposal-store.ts
import { readJsonSafe, writeJsonSafe } from '../lib/json-store.js';
import type { PromptProposal, PromptVersionEntry } from '../types.js';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { readdir } from 'fs/promises';

export class PromptProposalStore {
  constructor(
    private proposalsDir: string,
    private versionsDir: string,
    private cooldownMs: number = 30 * 24 * 60 * 60 * 1000,
  ) {}

  async store(input: {
    templateName: string;
    currentContent: string;
    proposedContent: string;
    reasoning: string;
  }): Promise<string> {
    const id = randomUUID();
    const proposal: PromptProposal = {
      id,
      templateName: input.templateName,
      currentContent: input.currentContent,
      proposedContent: input.proposedContent,
      reasoning: input.reasoning,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await writeJsonSafe(join(this.proposalsDir, `${id}.json`), proposal);
    return id;
  }

  async getPending(): Promise<PromptProposal[]> {
    const all = await this.loadAll();
    return all.filter((p) => p.status === 'pending');
  }

  async approve(id: string): Promise<void> {
    const proposal = await this.load(id);
    if (!proposal) return;
    proposal.status = 'approved';
    await writeJsonSafe(join(this.proposalsDir, `${id}.json`), proposal);

    // Record in version history
    const history = await this.getVersionHistory(proposal.templateName);
    // Archive the previous version if not already in history (first approval).
    // Uses proposal.createdAt as approximate timestamp since original authoring
    // time is unavailable. Status 'approved' indicates this was the active content.
    if (history.length === 0) {
      history.push({
        content: proposal.currentContent,
        timestamp: proposal.createdAt,
        status: 'approved',
      });
    }
    history.push({
      content: proposal.proposedContent,
      timestamp: new Date().toISOString(),
      status: 'approved',
    });
    await writeJsonSafe(
      join(this.versionsDir, `${proposal.templateName}.json`),
      history,
    );
  }

  async reject(id: string): Promise<void> {
    const proposal = await this.load(id);
    if (!proposal) return;
    proposal.status = 'rejected';
    proposal.rejectedAt = new Date().toISOString();
    await writeJsonSafe(join(this.proposalsDir, `${id}.json`), proposal);
  }

  async isTemplateCoolingDown(templateName: string, cooldownMs?: number): Promise<boolean> {
    const all = await this.loadAll();
    const cd = cooldownMs ?? this.cooldownMs;
    const now = Date.now();
    return all.some(
      (p) =>
        p.templateName === templateName &&
        p.status === 'rejected' &&
        p.rejectedAt != null &&
        new Date(p.rejectedAt).getTime() + cd > now,
    );
  }

  async getVersionHistory(templateName: string): Promise<PromptVersionEntry[]> {
    const result = await readJsonSafe<PromptVersionEntry[]>(
      join(this.versionsDir, `${templateName}.json`),
    );
    return result.ok ? result.value : [];
  }

  private async load(id: string): Promise<PromptProposal | undefined> {
    const result = await readJsonSafe<PromptProposal>(
      join(this.proposalsDir, `${id}.json`),
    );
    return result.ok ? result.value : undefined;
  }

  private async loadAll(): Promise<PromptProposal[]> {
    try {
      const files = await readdir(this.proposalsDir);
      const proposals: PromptProposal[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const result = await readJsonSafe<PromptProposal>(
          join(this.proposalsDir, file),
        );
        if (result.ok) proposals.push(result.value);
      }
      return proposals;
    } catch {
      return [];
    }
  }
}
