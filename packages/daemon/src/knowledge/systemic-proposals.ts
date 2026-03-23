// src/knowledge/systemic-proposals.ts
import { readJsonSafe, writeJsonSafe } from '../lib/json-store.js';
import type { SystemicProposal } from '../types.js';
import type { KnowledgeStore } from './knowledge-store.js';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { readdir } from 'fs/promises';

export async function detectSystemicProposals(
  store: KnowledgeStore,
  proposalsDir: string,
  threshold: number = 3,
): Promise<SystemicProposal[]> {
  const all = await store.loadAll();
  const active = all.filter(r => r.lifecycleStatus === 'active' && r.rootCauseTag);

  // Group by rootCauseTag
  const groups = new Map<string, typeof active>();
  for (const r of active) {
    const tag = r.rootCauseTag!;
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag)!.push(r);
  }

  // Load existing proposals to check for cooldowns
  const existing = await loadAllProposals(proposalsDir);
  const coolingDown = new Set<string>();
  const now = Date.now();
  for (const p of existing) {
    if (p.cooldownUntil && new Date(p.cooldownUntil).getTime() > now) {
      coolingDown.add(p.rootCauseTag);
    }
    // Also skip tags with pending/approved proposals
    if (p.status === 'pending' || p.status === 'approved') {
      coolingDown.add(p.rootCauseTag);
    }
  }

  const newProposals: SystemicProposal[] = [];
  for (const [tag, records] of groups) {
    if (records.length < threshold) continue;
    if (coolingDown.has(tag)) continue;

    const proposal: SystemicProposal = {
      id: randomUUID(),
      rootCauseTag: tag,
      description: `Recurring root cause "${tag}" found across ${records.length} records: ${records.map(r => r.description).join('; ')}`,
      relatedRecordIds: records.map(r => r.id),
      remediation: `Address root cause "${tag}" to prevent recurring issues`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await writeJsonSafe(join(proposalsDir, `${proposal.id}.json`), proposal);
    newProposals.push(proposal);
  }
  return newProposals;
}

export async function loadProposals(
  proposalsDir: string,
  statusFilter?: SystemicProposal['status'],
): Promise<SystemicProposal[]> {
  const all = await loadAllProposals(proposalsDir);
  return statusFilter ? all.filter(p => p.status === statusFilter) : all;
}

export async function approveProposal(proposalsDir: string, id: string): Promise<void> {
  const path = join(proposalsDir, `${id}.json`);
  const result = await readJsonSafe<SystemicProposal>(path);
  if (!result.ok) return;
  result.value.status = 'approved';
  await writeJsonSafe(path, result.value);
}

export async function rejectProposal(
  proposalsDir: string,
  id: string,
  cooldownDays: number = 30,
): Promise<void> {
  const path = join(proposalsDir, `${id}.json`);
  const result = await readJsonSafe<SystemicProposal>(path);
  if (!result.ok) return;
  result.value.status = 'rejected';
  result.value.cooldownUntil = new Date(Date.now() + cooldownDays * 24 * 60 * 60 * 1000).toISOString();
  await writeJsonSafe(path, result.value);
}

async function loadAllProposals(proposalsDir: string): Promise<SystemicProposal[]> {
  try {
    const files = await readdir(proposalsDir);
    const proposals: SystemicProposal[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const result = await readJsonSafe<SystemicProposal>(join(proposalsDir, file));
      if (result.ok) proposals.push(result.value);
    }
    return proposals;
  } catch {
    return [];
  }
}
