// src/coordination/tech-lead/proposal-lifecycle.ts — FSM transition table for TechnicalProposal
import type { TechProposalStatus, TechProposalEvent, TechnicalProposal } from './schemas.js';

export const TERMINAL_STATUSES: TechProposalStatus[] = [
  'approved',
  'rejected_by_po',
  'rejected_by_operator',
  'expired',
];

export const PROPOSAL_TRANSITIONS: Record<
  TechProposalStatus,
  Partial<Record<TechProposalEvent, { next: TechProposalStatus }>>
> = {
  generated: {
    po_forward: { next: 'forwarded' },
    po_reject: { next: 'rejected_by_po' },
    expire: { next: 'expired' },
  },
  forwarded: {
    operator_view: { next: 'pending_operator' },
    expire: { next: 'expired' },
  },
  pending_operator: {
    operator_approve: { next: 'approved' },
    operator_reject: { next: 'rejected_by_operator' },
    expire: { next: 'expired' },
  },
  approved: {},
  rejected_by_po: {},
  rejected_by_operator: {},
  expired: {},
};

export function transitionProposal(
  proposal: TechnicalProposal,
  event: TechProposalEvent,
): TechnicalProposal {
  const transition = PROPOSAL_TRANSITIONS[proposal.status]?.[event];
  if (!transition) {
    throw new Error(`Invalid transition: ${proposal.status} + ${event}`);
  }
  return { ...proposal, status: transition.next };
}

export function isTerminalStatus(status: TechProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
