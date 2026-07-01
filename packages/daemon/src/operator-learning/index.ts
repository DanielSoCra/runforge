// packages/daemon/src/operator-learning/index.ts
//
// Operator Learning Service public API.

import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import {
  type Observation,
  type InboxItem,
  type RankedItem,
  type Preference,
  type AskLessProposal,
  type OperatorLearningConfig,
  DEFAULT_RUNG_THRESHOLDS,
  DEFAULT_GUARDED_CLASSES,
} from './types.js';
import {
  appendObservation,
  readObservations,
  observationsForKey,
  generateObservationId,
} from './observation-log.js';
import { derivePreference } from './preference-engine.js';
import { rankItems, selectPullTimeRelevance } from './ranking.js';
import {
  resetPreference,
  revertPreference,
  readAuditTrail,
  maybeCreateAskLessProposal,
  listAskLessProposals,
  updateAskLessProposal,
  isApprovedProposalLive,
} from './audit.js';

export interface DecisionObservationInput {
  decisionClass: string;
  context: string;
  sourceDecisionId: string;
  chosenOption: string;
  recommendedOption?: string;
  sensitive?: boolean;
}

export interface ReRankObservationInput {
  decisionClass: string;
  context: string;
  action: 'pin' | 'mute' | 'defer' | 'reorder-to-top';
  priorPosition?: number;
  resultingPosition?: number;
}

export interface SpecEditObservationInput {
  decisionClass: string;
  context: string;
  fingerprint: {
    changeKind: 'added_constraint' | 'removed_step' | 'reordered_section' | 'changed_scope' | 'other';
    affectedSections?: string[];
  };
}

export class OperatorLearningService {
  private readonly config: OperatorLearningConfig;

  constructor(config: Partial<OperatorLearningConfig> & { logPath: string; proposalDir: string }) {
    this.config = {
      thresholds: DEFAULT_RUNG_THRESHOLDS,
      guardedClasses: DEFAULT_GUARDED_CLASSES,
      attentionWindowMs: 30 * 24 * 60 * 60 * 1000,
      rankingBoostScale: 1.0,
      proposalCooldownMs: 30 * 24 * 60 * 60 * 1000,
      ...config,
    };
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.config.logPath), { recursive: true });
    await mkdir(this.config.proposalDir, { recursive: true });
  }

  private guardedSet(): Set<string> {
    return new Set(this.config.guardedClasses);
  }

  /**
   * Build the set of `decisionClass::context` keys that have a *live* approved
   * AskLessProposal. Only these may surface the active `propose-ask-less` rung;
   * everything else stays at `pre-fill` even when evidence is strong. An
   * approval is excluded once a later reset/revert has returned the preference
   * to its cautious state (see isApprovedProposalLive) — so the rung drops back
   * to pre-fill until the Operator approves a NEW proposal.
   */
  private async approvedProposalKeys(observations: Observation[]): Promise<Set<string>> {
    const proposals = await listAskLessProposals(this.config.proposalDir);
    const keys = new Set<string>();
    for (const p of proposals) {
      if (isApprovedProposalLive(p, observations)) {
        keys.add(`${p.decisionClass}::${p.context}`);
      }
    }
    return keys;
  }

  async observeDecisionAnswer(input: DecisionObservationInput): Promise<void> {
    const observation: Observation = {
      kind: 'decision_answer',
      observationId: generateObservationId(),
      decisionClass: input.decisionClass,
      context: input.context,
      sourceDecisionId: input.sourceDecisionId,
      chosenOption: input.chosenOption,
      recommendedOption: input.recommendedOption,
      matchedRecommendation: input.recommendedOption !== undefined && input.chosenOption === input.recommendedOption,
      sensitive: input.sensitive ?? false,
      observedAt: Date.now(),
    };
    await appendObservation(this.config.logPath, observation);
  }

  async observeReRankAction(input: ReRankObservationInput): Promise<void> {
    const observation: Observation = {
      kind: 'rerank_action',
      observationId: generateObservationId(),
      decisionClass: input.decisionClass,
      context: input.context,
      action: input.action,
      priorPosition: input.priorPosition,
      resultingPosition: input.resultingPosition,
      observedAt: Date.now(),
    };
    await appendObservation(this.config.logPath, observation);
  }

  async observeSpecEdit(input: SpecEditObservationInput): Promise<void> {
    const observation: Observation = {
      kind: 'spec_edit',
      observationId: generateObservationId(),
      decisionClass: input.decisionClass,
      context: input.context,
      fingerprint: {
        changeKind: input.fingerprint.changeKind,
        affectedSections: input.fingerprint.affectedSections ?? [],
      },
      observedAt: Date.now(),
    };
    await appendObservation(this.config.logPath, observation);
  }

  async getPreference(decisionClass: string, context: string): Promise<Preference> {
    const observations = await readObservations(this.config.logPath);
    const relevant = observationsForKey(observations, decisionClass, context);
    const approvedKeys = await this.approvedProposalKeys(observations);
    return derivePreference(
      decisionClass,
      context,
      relevant,
      this.config.thresholds,
      this.guardedSet(),
      approvedKeys.has(`${decisionClass}::${context}`),
    );
  }

  async rankInboxItems(items: InboxItem[], now = Date.now()): Promise<RankedItem[]> {
    const observations = await readObservations(this.config.logPath);
    const approvedKeys = await this.approvedProposalKeys(observations);
    return rankItems(items, observations, this.config, now, approvedKeys);
  }

  async getPullTimeRelevance(
    candidates: InboxItem[],
    context: string,
    now = Date.now(),
  ): Promise<{ item: InboxItem; reason: string } | undefined> {
    const observations = await readObservations(this.config.logPath);
    const approvedKeys = await this.approvedProposalKeys(observations);
    return selectPullTimeRelevance(candidates, context, observations, this.config, now, approvedKeys);
  }

  async reset(decisionClass: string, context: string): Promise<void> {
    await resetPreference(decisionClass, context, this.config.logPath);
  }

  async revert(decisionClass: string, context: string, fleetWide = false): Promise<void> {
    await revertPreference(decisionClass, context, this.config.logPath, fleetWide);
  }

  async audit(filters?: { decisionClass?: string; context?: string }): Promise<Observation[]> {
    return readAuditTrail(this.config.logPath, filters);
  }

  async getExplanation(decisionClass: string, context: string): Promise<Preference> {
    return this.getPreference(decisionClass, context);
  }

  async scanAskLessProposals(): Promise<AskLessProposal[]> {
    return listAskLessProposals(this.config.proposalDir);
  }

  /**
   * approveAskLessProposal — APPROVE-ONCE / CAS (codex CRIT-4). Liveness is
   * `approvedAt > lastResetAt`, so blindly re-stamping `approvedAt: Date.now()` on
   * every call would let a REPLAY of an old approval — issued AFTER a
   * `preference_reset`/revert — resurrect a stale ask-less authorization. The fix:
   * only a `pending` proposal transitions to `approved` (stamping `approvedAt` once);
   * an already-approved proposal is returned UNCHANGED (its original `approvedAt`
   * preserved), so a replay past a reset can never make it live again.
   */
  async approveAskLessProposal(proposalId: string): Promise<AskLessProposal | undefined> {
    const existing = (await listAskLessProposals(this.config.proposalDir)).find((p) => p.id === proposalId);
    if (existing === undefined) return undefined;
    // Idempotent / non-resurrecting: anything not `pending` (already approved, or
    // rejected) is returned as-is — never re-stamped with a fresh approvedAt.
    if (existing.status !== 'pending') return existing;
    return updateAskLessProposal(proposalId, this.config.proposalDir, {
      status: 'approved',
      approvedAt: Date.now(),
    });
  }

  async rejectAskLessProposal(proposalId: string): Promise<AskLessProposal | undefined> {
    return updateAskLessProposal(proposalId, this.config.proposalDir, {
      status: 'rejected',
      cooldownUntil: Date.now() + this.config.proposalCooldownMs,
    });
  }

  async maybeProposeAskLess(decisionClass: string, context: string): Promise<AskLessProposal | undefined> {
    const observations = await readObservations(this.config.logPath);
    return maybeCreateAskLessProposal(decisionClass, context, observations, this.config);
  }
}

export {
  DEFAULT_RUNG_THRESHOLDS,
  DEFAULT_GUARDED_CLASSES,
  derivePreference,
  rankItems,
  selectPullTimeRelevance,
};

export type {
  OperatorLearningConfig,
  Preference,
  RankedItem,
  AskLessProposal,
  Observation,
  InboxItem,
};
