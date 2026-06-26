// packages/daemon/src/operator-learning/audit.ts
//
// Reset, revert, ask-less proposals, and audit trail.

import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { appendObservation, readObservations, generateObservationId } from './observation-log.js';
import {
  PreferenceResetEventSchema,
  PreferenceRevertEventSchema,
  AskLessProposalSchema,
  type Observation,
  type Preference,
  type AskLessProposal,
  type OperatorLearningConfig,
} from './types.js';
import { derivePreference, meetsAskLessEvidence, lastResetAt } from './preference-engine.js';

/**
 * An approved AskLessProposal only authorizes the `propose-ask-less` rung while
 * no reset/revert has occurred for its class/context *after* it was approved.
 * A `preference_reset` or `preference_revert` returns the preference to its
 * cautious, pre-learning state (see FUNC-AC-OPERATOR-LEARNING), invalidating any
 * previously-approved proposal until the Operator approves a NEW one. Without
 * this, fresh observations that re-cross the ask-less thresholds would jump
 * straight back to `propose-ask-less` with no new operator approval.
 *
 * A reset recorded at the same millisecond as (or after) the approval counts as
 * invalidating — reset/revert always follow approval in wall-clock order, so
 * treating the boundary cautiously keeps the rung at pre-fill until re-approved.
 */
export function isApprovedProposalLive(
  proposal: AskLessProposal,
  observations: Observation[],
): boolean {
  if (proposal.status !== 'approved') return false;
  const cutoff = lastResetAt(observations, proposal.decisionClass, proposal.context);
  return (proposal.approvedAt ?? 0) > cutoff;
}

export async function resetPreference(
  decisionClass: string,
  context: string,
  logPath: string,
): Promise<void> {
  const event: Observation = {
    kind: 'preference_reset',
    observationId: generateObservationId(),
    decisionClass,
    context,
    observedAt: Date.now(),
  };
  PreferenceResetEventSchema.parse(event);
  await appendObservation(logPath, event);
}

export async function revertPreference(
  decisionClass: string,
  context: string,
  logPath: string,
  fleetWide = false,
): Promise<void> {
  const event: Observation = {
    kind: 'preference_revert',
    observationId: generateObservationId(),
    decisionClass,
    context,
    fleetWide,
    observedAt: Date.now(),
  };
  PreferenceRevertEventSchema.parse(event);
  await appendObservation(logPath, event);
}

export async function readAuditTrail(
  logPath: string,
  filters?: { decisionClass?: string; context?: string },
): Promise<Observation[]> {
  const observations = await readObservations(logPath);
  return observations.filter((o) => {
    if (
      o.kind !== 'preference_reset' &&
      o.kind !== 'preference_revert'
    ) {
      return false;
    }
    if (filters?.decisionClass !== undefined && filters.decisionClass !== '' && o.decisionClass !== filters.decisionClass) return false;
    if (filters?.context !== undefined && filters.context !== '' && o.context !== filters.context) return false;
    return true;
  });
}

export async function createAskLessProposal(
  decisionClass: string,
  context: string,
  proposedThreshold: number,
  preference: Preference,
  proposalDir: string,
): Promise<AskLessProposal> {
  await mkdir(proposalDir, { recursive: true });
  const id = `alp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const proposal: AskLessProposal = {
    id,
    decisionClass,
    context,
    proposedThreshold,
    evidence: preference.evidenceSummary,
    status: 'pending',
    createdAt: Date.now(),
  };
  AskLessProposalSchema.parse(proposal);
  await writeFile(join(proposalDir, `${id}.json`), JSON.stringify(proposal, null, 2));
  return proposal;
}

export async function listAskLessProposals(proposalDir: string): Promise<AskLessProposal[]> {
  try {
    const files = await readdir(proposalDir);
    const proposals: AskLessProposal[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const raw = await readFile(join(proposalDir, file), 'utf-8');
      const parsed = AskLessProposalSchema.safeParse(JSON.parse(raw));
      if (parsed.success) proposals.push(parsed.data);
    }
    return proposals;
  } catch {
    return [];
  }
}

export async function updateAskLessProposal(
  proposalId: string,
  proposalDir: string,
  update: Partial<Pick<AskLessProposal, 'status' | 'approvedAt' | 'cooldownUntil'>>,
): Promise<AskLessProposal | undefined> {
  const path = join(proposalDir, `${proposalId}.json`);
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = AskLessProposalSchema.parse(JSON.parse(raw));
    const updated = { ...parsed, ...update };
    AskLessProposalSchema.parse(updated);
    await writeFile(path, JSON.stringify(updated, null, 2));
    return updated;
  } catch {
    return undefined;
  }
}

export async function maybeCreateAskLessProposal(
  decisionClass: string,
  context: string,
  observations: Observation[],
  config: Pick<OperatorLearningConfig, 'logPath' | 'proposalDir' | 'thresholds' | 'guardedClasses' | 'proposalCooldownMs'>,
): Promise<AskLessProposal | undefined> {
  const guarded = new Set(config.guardedClasses);
  if (guarded.has(decisionClass)) return undefined;

  const relevant = observations.filter(
    (o) => o.decisionClass === decisionClass && o.context === context,
  );
  const preference = derivePreference(
    decisionClass,
    context,
    relevant,
    config.thresholds,
    guarded,
  );
  // Eligibility to *propose* ask-less is based on the evidence crossing the
  // proposeAskLess thresholds — NOT on the active rung. The active rung stays
  // `pre-fill` until a proposal is approved (resolveRung gates propose-ask-less
  // on an approved proposal), so gating proposal creation on the rung would be
  // a chicken-and-egg deadlock (no proposal could ever be created).
  if (!meetsAskLessEvidence(preference.evidenceSummary, config.thresholds)) {
    return undefined;
  }

  // Check for an existing live proposal for this key. A proposal is "active"
  // while pending, while approved AND still live (not invalidated by a later
  // reset/revert — see isApprovedProposalLive), or while in post-rejection
  // cooldown. An approved-but-since-reset proposal must NOT block a fresh
  // proposal, otherwise the operator could never re-authorize ask-less after a
  // reset/revert.
  const existing = await listAskLessProposals(config.proposalDir);
  const now = Date.now();
  const hasActive = existing.some(
    (p) =>
      p.decisionClass === decisionClass &&
      p.context === context &&
      (p.status === 'pending' ||
        isApprovedProposalLive(p, observations) ||
        (p.cooldownUntil !== undefined && p.cooldownUntil > now)),
  );
  if (hasActive) return undefined;

  // Threshold doubles the surface interval as a concrete proposal.
  return createAskLessProposal(
    decisionClass,
    context,
    2,
    preference,
    config.proposalDir,
  );
}
