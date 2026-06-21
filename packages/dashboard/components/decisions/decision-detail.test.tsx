import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  DecisionDetailView,
  DecisionDetailPanel,
  type DecisionDetailData,
} from './decision-detail';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A fully-populated, all-text decision detail. NOTE: no value contains the banned
 *  outcome/QA words (QA/safe/passed/ready) so the lexical-ban test isolates the
 *  component's own copy. */
const detail: DecisionDetailData = {
  decision_id: 'dec-1',
  status: 'notified',
  risk_class: 'P1',
  deployment: 'dep-main',
  source_url: 'https://github.com/org/repo/issues/482',
  reversibility: 'reversible',
  recommended_option: 'approve',
  expires_at: '2026-06-22T00:00:00.000Z',
  created_at: '2026-06-21T09:30:00.000Z',
  question: { kind: 'text', value: 'Merge PR #482 into main?' },
  context: { kind: 'text', value: 'Touches the auth module.' },
  consequence_of_no_answer: { kind: 'text', value: 'The run stays parked.' },
  options: [
    { id: 'approve', label: { kind: 'text', value: 'Approve' } },
    { id: 'reject', label: { kind: 'text', value: 'Reject' } },
  ],
};

const PROTECTED_SECRET = 'token-abc-xyz';
const protectedDetail: DecisionDetailData = {
  ...detail,
  decision_id: 'dec-2',
  question: { kind: 'protected', field: 'raw_question', class: 'secret', ref: 'protected://01H' },
  options: [
    { id: 'approve', label: { kind: 'protected', field: 'raw_label', class: 'phi', ref: 'protected://02H' } },
    { id: 'reject', label: { kind: 'text', value: 'Reject' } },
  ],
};

describe('DecisionDetailView (pure)', () => {
  it('renders the question, context, and consequence-of-no-answer', () => {
    render(<DecisionDetailView decisionId="dec-1" detail={detail} />);
    expect(screen.getByText('Merge PR #482 into main?')).toBeTruthy();
    expect(screen.getByText('Touches the auth module.')).toBeTruthy();
    expect(screen.getByText('The run stays parked.')).toBeTruthy();
  });

  it('renders the risk class, deployment, and reversibility', () => {
    render(<DecisionDetailView decisionId="dec-1" detail={detail} />);
    expect(screen.getByText('P1')).toBeTruthy();
    expect(screen.getByText(/dep-main/)).toBeTruthy();
    expect(screen.getByText(/reversible/)).toBeTruthy();
  });

  it('renders the source as a link to source_url', () => {
    const { container } = render(<DecisionDetailView decisionId="dec-1" detail={detail} />);
    const link = container.querySelector('a[href="https://github.com/org/repo/issues/482"]');
    expect(link).not.toBeNull();
  });

  it('renders the options and marks the recommended one', () => {
    render(<DecisionDetailView decisionId="dec-1" detail={detail} />);
    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Reject')).toBeTruthy();
    // the recommended option ('approve') is indicated somehow (text contains "recommend")
    expect(screen.getByText(/recommend/i)).toBeTruthy();
  });

  it('renders a protected field as its class marker and never the value', () => {
    const { container } = render(<DecisionDetailView decisionId="dec-2" detail={protectedDetail} />);
    expect(screen.getByText(/\[protected: secret\]/)).toBeTruthy();
    expect(screen.getByText(/\[protected: phi\]/)).toBeTruthy();
    expect(container.textContent ?? '').not.toContain(PROTECTED_SECRET);
    expect(container.textContent ?? '').not.toContain('protected://');
  });

  it('never implies a QA/outcome verdict (no banned copy)', () => {
    const { container } = render(<DecisionDetailView decisionId="dec-1" detail={detail} />);
    expect(container.textContent ?? '').not.toMatch(/\b(QA|safe|passed|ready)\b/i);
  });

  it('renders an unsafe (non-http) source_url as plain text, never a clickable link', () => {
    const { container } = render(
      <DecisionDetailView decisionId="dec-1" detail={{ ...detail, source_url: 'javascript:alert(1)' }} />,
    );
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    // still shown (so the operator sees the suspicious value), but inert
    expect(container.textContent ?? '').toContain('javascript:alert(1)');
  });
});

describe('DecisionDetailPanel (client fetch)', () => {
  it('is collapsed by default and shows a details trigger', () => {
    render(<DecisionDetailPanel decisionId="dec-1" />);
    expect(screen.getByRole('button', { name: /detail/i })).toBeTruthy();
    expect(screen.queryByText('Merge PR #482 into main?')).toBeNull();
  });

  it('fetches and renders the detail on open', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => detail,
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DecisionDetailPanel decisionId="dec-1" />);
    fireEvent.click(screen.getByRole('button', { name: /detail/i }));
    await waitFor(() => expect(screen.getByText('Merge PR #482 into main?')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/decisions/dec-1'));
  });

  it('shows a calm unavailable message when the fetch fails (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }));
    render(<DecisionDetailPanel decisionId="dec-1" />);
    fireEvent.click(screen.getByRole('button', { name: /detail/i }));
    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeTruthy());
  });
});

describe('Reveal affordance', () => {
  it('reveals a protected field value on click', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ field: 'raw_question', value: 'secret question' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DecisionDetailView decisionId="dec-2" detail={protectedDetail} />);

    const revealButton = screen.getByRole('button', { name: /Reveal protected raw_question/i });
    expect(revealButton).toBeTruthy();
    fireEvent.click(revealButton);

    await waitFor(() => expect(screen.getByText('secret question')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/decisions/dec-2/reveal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ref: 'protected://01H' }),
      }),
    );
  });

  it('shows "admin only" when the reveal request returns 403', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DecisionDetailView decisionId="dec-2" detail={protectedDetail} />);

    fireEvent.click(screen.getByRole('button', { name: /Reveal protected raw_question/i }));
    await waitFor(() => expect(screen.getByText('admin only')).toBeTruthy());
  });
});
