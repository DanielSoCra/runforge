import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// The inbox mounts the per-row answer control, which calls useRouter().refresh()
// on a successful answer — mock next/navigation so it renders without an
// app-router context in jsdom.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  DecisionInbox,
  type RankedListItem,
} from './decision-inbox';

afterEach(() => cleanup());

/**
 * A row whose question is a plain text field (rendered verbatim). `risk_class`
 * uses the real wire vocabulary — decision-protocol `RISK_CLASSES` is
 * `P0|P1|P2|P3`, NOT `RED`/`ORANGE`.
 */
const textItem: RankedListItem = {
  decision_id: 'dec-001',
  status: 'notified',
  risk_class: 'P1',
  created_at: '2026-06-18T09:30:00.000Z',
  question: { kind: 'text', value: 'Merge PR #482 into main?' },
  score: 87,
  why_ranked: 'P1 risk, waiting 2h',
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
  risk_class: 'P0',
  created_at: '2026-06-18T10:15:00.000Z',
  // The wire shape for a protected list field: class only, no `value`/`ref`.
  question: { kind: 'protected', field: 'patient_summary', class: 'phi' },
  score: 95,
  why_ranked: 'P0 risk, PHI involved',
};

describe('DecisionInbox', () => {
  describe('rows', () => {
    it('renders one row per item with its risk_class and created_at', () => {
      render(<DecisionInbox items={[textItem, protectedItem]} />);

      // (a) risk_class shown for each row — the real P0-P3 vocabulary
      expect(screen.getByText('P1')).toBeInTheDocument();
      expect(screen.getByText('P0')).toBeInTheDocument();

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

  describe('risk-class badges', () => {
    it('maps P0-P3 to distinct variants — urgent classes get a louder treatment than calm ones', () => {
      render(
        <DecisionInbox
          items={[
            { ...textItem, decision_id: 'p0', risk_class: 'P0' },
            { ...textItem, decision_id: 'p1', risk_class: 'P1' },
            { ...textItem, decision_id: 'p2', risk_class: 'P2' },
            { ...textItem, decision_id: 'p3', risk_class: 'P3' },
          ]}
        />,
      );

      const p0 = screen.getByText('P0');
      const p1 = screen.getByText('P1');
      const p2 = screen.getByText('P2');
      const p3 = screen.getByText('P3');

      // Each class resolves to its own Badge variant (data-variant from the shadcn Badge).
      expect(p0).toHaveAttribute('data-variant', 'destructive');
      expect(p1).toHaveAttribute('data-variant', 'secondary');
      expect(p2).toHaveAttribute('data-variant', 'default');
      expect(p3).toHaveAttribute('data-variant', 'outline');

      // The urgent P0 must NOT fall through to the muted/outline default that the
      // calm P3 uses — the regression this fixes (every row → outline).
      expect(p0.getAttribute('data-variant')).not.toBe(
        p3.getAttribute('data-variant'),
      );
      // All four variants are pairwise distinct.
      const variants = [p0, p1, p2, p3].map((el) =>
        el.getAttribute('data-variant'),
      );
      expect(new Set(variants).size).toBe(4);
    });

    it('falls back to the muted outline variant for an unknown class (never reads as urgent)', () => {
      render(
        <DecisionInbox
          items={[{ ...textItem, decision_id: 'x', risk_class: 'WEIRD' }]}
        />,
      );
      expect(screen.getByText('WEIRD')).toHaveAttribute(
        'data-variant',
        'outline',
      );
    });
  });

  describe('ranked order', () => {
    it('preserves the exact daemon-ranked order, even when dates are out of order', () => {
      // The daemon returns a GLOBAL ranked order: a high-rank "today" item, then a
      // "yesterday" item, then another "today" item. The client MUST render them
      // in that exact sequence (L3: render daemon order, do not re-rank). A naive
      // date-grouping Map would hoist the second "today" up next to the first.
      const items: RankedListItem[] = [
        {
          ...textItem,
          decision_id: 'rank-1',
          created_at: '2026-06-18T09:00:00.000Z',
          question: { kind: 'text', value: 'first ranked (today)' },
        },
        {
          ...textItem,
          decision_id: 'rank-2',
          created_at: '2026-06-17T18:00:00.000Z',
          question: { kind: 'text', value: 'second ranked (yesterday)' },
        },
        {
          ...textItem,
          decision_id: 'rank-3',
          created_at: '2026-06-18T08:00:00.000Z',
          question: { kind: 'text', value: 'third ranked (today again)' },
        },
      ];

      const { container } = render(<DecisionInbox items={items} />);

      const rendered = Array.from(
        container.querySelectorAll('.text-sm'),
      )
        .map((el) => el.textContent ?? '')
        .filter((text) =>
          /first ranked|second ranked|third ranked/.test(text),
        );

      expect(rendered).toEqual([
        'first ranked (today)',
        'second ranked (yesterday)',
        'third ranked (today again)',
      ]);
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
