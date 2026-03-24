// src/coordination/tech-lead/proposal-lifecycle.test.ts
import { describe, it, expect } from 'vitest';
import {
  transitionProposal,
  isTerminalStatus,
  PROPOSAL_TRANSITIONS,
  TERMINAL_STATUSES,
} from './proposal-lifecycle.js';
import type { TechnicalProposal, TechProposalStatus, TechProposalEvent } from './schemas.js';
import { TechProposalStatusSchema, TechProposalEventSchema } from './schemas.js';

function makeProposal(overrides: Partial<TechnicalProposal> = {}): TechnicalProposal {
  return {
    id: crypto.randomUUID(),
    proposalType: 'debt_reduction',
    title: 'Test proposal',
    evidence: [{ signal: 'test', detail: 'test' }],
    affectedAreas: ['src/'],
    riskAssessment: 'Low',
    effortEstimate: '1 day',
    status: 'generated',
    poDecision: null,
    operatorDecision: null,
    priorRejectionId: null,
    expiresAt: new Date(Date.now() + 604800000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('transitionProposal', () => {
  it('generated → forwarded on po_forward', () => {
    const p = makeProposal({ status: 'generated' });
    const next = transitionProposal(p, 'po_forward');
    expect(next.status).toBe('forwarded');
  });

  it('generated → rejected_by_po on po_reject', () => {
    const p = makeProposal({ status: 'generated' });
    const next = transitionProposal(p, 'po_reject');
    expect(next.status).toBe('rejected_by_po');
  });

  it('forwarded → pending_operator on operator_view', () => {
    const p = makeProposal({ status: 'forwarded' });
    const next = transitionProposal(p, 'operator_view');
    expect(next.status).toBe('pending_operator');
  });

  it('pending_operator → approved on operator_approve', () => {
    const p = makeProposal({ status: 'pending_operator' });
    const next = transitionProposal(p, 'operator_approve');
    expect(next.status).toBe('approved');
  });

  it('pending_operator → rejected_by_operator on operator_reject', () => {
    const p = makeProposal({ status: 'pending_operator' });
    const next = transitionProposal(p, 'operator_reject');
    expect(next.status).toBe('rejected_by_operator');
  });

  it('any non-terminal → expired on expire', () => {
    for (const status of ['generated', 'forwarded', 'pending_operator'] as TechProposalStatus[]) {
      const p = makeProposal({ status });
      const next = transitionProposal(p, 'expire');
      expect(next.status).toBe('expired');
    }
  });

  it('throws on invalid transition from terminal state', () => {
    for (const status of TERMINAL_STATUSES) {
      const p = makeProposal({ status });
      expect(() => transitionProposal(p, 'po_forward')).toThrow('Invalid transition');
    }
  });

  it('throws on invalid event for current state', () => {
    const p = makeProposal({ status: 'generated' });
    expect(() => transitionProposal(p, 'operator_approve')).toThrow('Invalid transition');
  });

  it('does not mutate original proposal', () => {
    const p = makeProposal({ status: 'generated' });
    const next = transitionProposal(p, 'po_forward');
    expect(p.status).toBe('generated');
    expect(next.status).toBe('forwarded');
  });
});

describe('isTerminalStatus', () => {
  it('returns true for terminal statuses', () => {
    expect(isTerminalStatus('approved')).toBe(true);
    expect(isTerminalStatus('rejected_by_po')).toBe(true);
    expect(isTerminalStatus('rejected_by_operator')).toBe(true);
    expect(isTerminalStatus('expired')).toBe(true);
  });

  it('returns false for non-terminal statuses', () => {
    expect(isTerminalStatus('generated')).toBe(false);
    expect(isTerminalStatus('forwarded')).toBe(false);
    expect(isTerminalStatus('pending_operator')).toBe(false);
  });
});

describe('PROPOSAL_TRANSITIONS exhaustiveness', () => {
  it('has entries for all statuses', () => {
    for (const status of TechProposalStatusSchema.options) {
      expect(PROPOSAL_TRANSITIONS).toHaveProperty(status);
    }
  });

  it('terminal statuses have no transitions', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(Object.keys(PROPOSAL_TRANSITIONS[status])).toHaveLength(0);
    }
  });
});
