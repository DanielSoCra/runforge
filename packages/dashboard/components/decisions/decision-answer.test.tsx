import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

// The wired control calls useRouter().refresh() on a successful answer (to re-fetch
// the server-rendered inbox); mock next/navigation so it works without an app-router
// context in jsdom.
const routerRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

import {
  DecisionAnswerDialog,
  DecisionAnswer,
} from './decision-answer';
import type { RankedListItem } from './decision-inbox';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * A decision the operator can answer. `options` carries the two answerable choices
 * the answer transport recognizes (approve/reject) — each `label` is a redaction-
 * typed `ListField`. This is the wire shape the daemon `RankedListItem.options`
 * projects (`packages/decision-index/src/read-model.ts`).
 */
const answerable: RankedListItem = {
  decision_id: 'dec-answer-1',
  status: 'notified',
  risk_class: 'P1',
  created_at: '2026-06-18T09:30:00.000Z',
  question: { kind: 'text', value: 'Merge PR #482 into main?' },
  options: [
    { id: 'approve', label: { kind: 'text', value: 'Approve' } },
    { id: 'reject', label: { kind: 'text', value: 'Reject' } },
  ],
  score: 87,
  why_ranked: 'P1 risk, waiting 2h',
};

/**
 * A decision whose option label is PROTECTED — the dialog must render it through
 * the same redaction discrimination as the inbox question: `[protected: <class>]`,
 * NEVER the raw value. This is the redaction boundary the answer dialog must not
 * breach (the read inbox already upholds it; the modal must too).
 */
const protectedOptionSecret = 'discharge-patient-jane-doe';
const protectedAnswerable: RankedListItem = {
  decision_id: 'dec-answer-2',
  status: 'viewed',
  risk_class: 'P0',
  created_at: '2026-06-18T10:15:00.000Z',
  // distinct class from the option below so `[protected: phi]` uniquely identifies
  // the OPTION label (both render the identical `[protected: <class>]` chip — the
  // discrimination is by class text, not a rendering quirk).
  question: { kind: 'protected', field: 'patient_summary', class: 'internal' },
  options: [
    { id: 'approve', label: { kind: 'protected', field: 'discharge_action', class: 'phi' } },
    { id: 'reject', label: { kind: 'text', value: 'Reject' } },
  ],
  score: 95,
  why_ranked: 'P0 risk, PHI involved',
};

/** Open the answer dialog by clicking its trigger control (the "Answer" affordance). */
function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: /answer/i }));
}

describe('DecisionAnswerDialog (pure presentational)', () => {
  it('renders an Answer control that opens the dialog', async () => {
    render(<DecisionAnswerDialog decision={answerable} onAnswer={() => {}} />);

    // The dialog is closed until the operator opens it.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    openDialog();

    // Opening reveals the dialog and the decision's question.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByText('Merge PR #482 into main?'),
    ).toBeInTheDocument();
  });

  it('lists the decision options as choices', async () => {
    render(<DecisionAnswerDialog decision={answerable} onAnswer={() => {}} />);
    openDialog();

    await screen.findByRole('dialog');

    // Both answerable choices are offered as distinct, clickable controls.
    expect(
      screen.getByRole('button', { name: /approve/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /reject/i }),
    ).toBeInTheDocument();
  });

  it('invokes onAnswer with (decision_id, chosen_option) when a choice is picked', async () => {
    const onAnswer = vi.fn();
    render(<DecisionAnswerDialog decision={answerable} onAnswer={onAnswer} />);
    openDialog();
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onAnswer).toHaveBeenCalledWith('dec-answer-1', 'approve');
  });

  it('invokes onAnswer with the reject choice when reject is picked', async () => {
    const onAnswer = vi.fn();
    render(<DecisionAnswerDialog decision={answerable} onAnswer={onAnswer} />);
    openDialog();
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    expect(onAnswer).toHaveBeenCalledWith('dec-answer-1', 'reject');
  });

  it('disables the choice controls while a submission is pending', async () => {
    render(
      <DecisionAnswerDialog decision={answerable} onAnswer={() => {}} pending />,
    );
    openDialog();
    await screen.findByRole('dialog');

    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reject/i })).toBeDisabled();
  });

  it('surfaces a calm error message inside the dialog (does not crash)', async () => {
    render(
      <DecisionAnswerDialog
        decision={answerable}
        onAnswer={() => {}}
        error="This decision is no longer answerable."
      />,
    );
    openDialog();
    await screen.findByRole('dialog');

    expect(
      screen.getByText(/no longer answerable/i),
    ).toBeInTheDocument();
  });

  describe('redaction', () => {
    it('renders a protected option label as [protected: <class>], never its value', async () => {
      const { container } = render(
        <DecisionAnswerDialog
          decision={protectedAnswerable}
          onAnswer={() => {}}
        />,
      );
      openDialog();
      await screen.findByRole('dialog');

      // The protected option label shows the class marker chip, not a value.
      expect(
        screen.getByText((content) => /\[protected:\s*phi\]/i.test(content)),
      ).toBeInTheDocument();
      // and never leaks a raw value / resolvable ref into the dialog DOM.
      expect(container.textContent).not.toContain(protectedOptionSecret);
      expect(container.textContent).not.toContain('protected://');
    });
  });
});

describe('DecisionAnswer (client wrapper — fetch-backed)', () => {
  it('posts the chosen option and removes the row on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ answered: true, chosen_option: 'approve' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onAnswered = vi.fn();

    render(<DecisionAnswer decision={answerable} onAnswered={onAnswered} />);
    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/decisions/answer',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    // The body carries the decision id + chosen option.
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({
      decision_id: 'dec-answer-1',
      chosen_option: 'approve',
    });
    // On success the answered decision leaves the pending inbox.
    await waitFor(() => {
      expect(onAnswered).toHaveBeenCalledWith('dec-answer-1');
    });
    // And the server-rendered inbox is refreshed so the row drops even with no
    // onAnswered parent (the live Steering page) — codex.
    expect(routerRefresh).toHaveBeenCalled();
  });

  it('keeps the row and shows a calm message on a 409 (not answerable)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'decision is not answerable' }), {
        status: 409,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onAnswered = vi.fn();

    render(<DecisionAnswer decision={answerable} onAnswered={onAnswered} />);
    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    // The row is NOT removed on error.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(onAnswered).not.toHaveBeenCalled();
    // A calm error message is surfaced (no crash).
    expect(
      await screen.findByText(/not answerable|could not|try again/i),
    ).toBeInTheDocument();
  });

  it('never renders a protected option value in the wired control', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <DecisionAnswer decision={protectedAnswerable} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    await screen.findByRole('dialog');

    expect(container.textContent).not.toContain(protectedOptionSecret);
    expect(container.textContent).not.toContain('protected://');
  });
});
