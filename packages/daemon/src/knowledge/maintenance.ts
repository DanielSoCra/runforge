// packages/daemon/src/knowledge/maintenance.ts
//
// Periodic institutional-learning maintenance: detect systemic proposals and
// surface promotion candidates. Fire-and-forget scheduling so the daemon loop
// never stalls on knowledge housekeeping.

import { mkdir } from 'fs/promises';
import { join } from 'path';
import type { KnowledgeStore } from './knowledge-store.js';
import { detectSystemicProposals } from './systemic-proposals.js';
import { getKnowledgePromotionCandidates } from './promotion.js';

export interface KnowledgeMaintenanceConfig {
  enabled: boolean;
  intervalMs: number;
  systemicProposalThreshold: number;
  promotionCooldownDays: number;
}

export interface KnowledgeMaintenanceHandle {
  stop(): void;
  triggerNow(): Promise<void>;
}

export function startKnowledgeMaintenance(
  store: KnowledgeStore,
  stateDir: string,
  config: KnowledgeMaintenanceConfig,
): KnowledgeMaintenanceHandle {
  const proposalsDir = join(stateDir, 'systemic-proposals');
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runCycle(): Promise<void> {
    if (running || !config.enabled) return;
    running = true;
    try {
      await mkdir(proposalsDir, { recursive: true });
      const proposals = await detectSystemicProposals(
        store,
        proposalsDir,
        config.systemicProposalThreshold,
      );
      if (proposals.length > 0) {
        console.log(
          `[knowledge-maintenance] generated ${proposals.length} systemic proposal(s): ${proposals.map((p) => p.rootCauseTag).join(', ')}`,
        );
      }

      const candidates = await getKnowledgePromotionCandidates(
        store,
        config.promotionCooldownDays,
      );
      if (candidates.length > 0) {
        console.log(
          `[knowledge-maintenance] ${candidates.length} promotion candidate(s) ready for operator review`,
        );
      }
    } catch (e) {
      console.error('[knowledge-maintenance] cycle error:', e instanceof Error ? e.message : String(e));
    } finally {
      running = false;
    }
  }

  if (config.enabled) {
    timer = setInterval(() => {
      runCycle().catch((e) =>
        console.error('[knowledge-maintenance] unexpected error:', e instanceof Error ? e.message : String(e)),
      );
    }, config.intervalMs);
  }

  return {
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    triggerNow(): Promise<void> {
      return runCycle();
    },
  };
}
