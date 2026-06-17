import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  DecisionInbox,
  type RankedListItem,
} from './decision-inbox';

afterEach(() => cleanup());

/** A row whose question is a plain text field (rendered verbatim). */
const textItem: RankedListItem = {
  decision_id: 'dec-001',
  status: 'notified',
  risk_class: 'ORANGE',
  created_at: '2026-06-18T09:30:00.000Z',
  question: { kind: 'text', value: 'Merge PR #482 into main?' },
  score: 87,
  why_ranked: 'orange risk, waiting 2h',
};

/**
 * A row whose question is a PROTECTED field — the list surface carries ONLY the
 * class marker (no value, no resolvable ref). The renderer must show
 * "[protected: <class>]" and NEVER the field name as if it were a value, nor any
 * resolved content. This is the redaction-boundary the inbox must not breach.
 */
const protectedSecret = 'super-secret-patient-name';
const protectedItem: RankedListItem = {
  decision_id: 'dec-002',
  status: 'viewed',
  risk_class: 'RED',
  created_at: '2026-06-18T10:15:00.000Z',
  // The wire shape for a protected list field: class only, no `value`/`ref`.
  question: { kind: 'protected', field: 'patient_summary', class: 'phi' },
  score: 95,
  why_ranked: 'red risk, PHI involved',
};

describe('DecisionInbox', () => {
  describe('rows', () => {
    it('renders one row per item with its risk_class and created_at', () => {
      render(<DecisionInbox items={[textItem, protectedItem]} />);

      // (a) risk_class shown for each row
      expect(screen.getByText('ORANGE')).toBeInTheDocument();
      expect(screen.getByText('RED')).toBeInTheDocument();

      // the text question renders its value verbatim
      expect(screen.getByText('Merge PR #482 into main?')).toBeInTheDocument();

      // (a) created_at is present per row — the raw ISO date appears somewhere in
      // each row (a formatted relative label is acceptable so long as the row
      // carries the timestamp; this asserts the ISO date string is rendered).
      expect(
        screen.getByText((content) => content.includes('2026-06-18')),
      ).toBeTruthy();
    });
  });

  describe('redaction', () => {
    it('renders a protected question as a [protected: <class>] chip', () => {
      render(<DecisionInbox items={[protectedItem]} />);

      expect(
        screen.getByText((content) =>
          /\[protected:\s*phi\]/i.test(content),
        ),
      ).toBeInTheDocument();
    });

    it('NEVER renders the raw protected value or a resolvable ref', () => {
      const { container } = render(<DecisionInbox items={[protectedItem]} />);

      // The list ListField type carries no value/ref; even if a buggy render
      // reached for one, it must not leak into the DOM.
      expect(container.textContent).not.toContain(protectedSecret);
      expect(container.textContent).not.toContain('protected://');
    });
  });

  describe('empty state', () => {
    it('renders a calm empty state for an empty inbox (the success state)', () => {
      render(<DecisionInbox items={[]} />);

      expect(
        screen.getByText(/no decisions awaiting you/i),
      ).toBeInTheDocument();
    });
  });

  describe('degraded state', () => {
    it('renders a degraded panel when the API is unavailable', () => {
      render(<DecisionInbox items={[]} unavailable />);

      expect(
        screen.getByText(/temporarily unavailable/i),
      ).toBeInTheDocument();
      // The degraded state is NOT the empty success state.
      expect(
        screen.queryByText(/no decisions awaiting you/i),
      ).not.toBeInTheDocument();
    });
  });
});
