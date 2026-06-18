'use client';

/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — the operator ANSWER affordance (slice 7c-ui).
 *
 * The UI half of the answer flow: each inbox row gets an "Answer" control that
 * opens a modal listing the decision's options (approve/reject); choosing one
 * POSTs to the dashboard proxy `/api/decisions/answer`, which forwards to the
 * daemon `POST /decisions/:id/answer` (the daemon then publishes a DecisionResponse
 * the resume loop consumes — never a direct ledger write). On success the answered
 * decision leaves the pending inbox; on 409 ("not answerable") or any error a calm
 * message surfaces and the row stays put.
 *
 * TESTABILITY SPLIT (the seam the gate asserts):
 *   - `DecisionAnswerDialog` is a PURE presentational dialog: it takes a `decision`
 *     and an `onAnswer(decision_id, chosen_option)` callback + render-state flags
 *     (`pending`, `error`) and renders the trigger + options + states from props
 *     alone. No `fetch`, no network — unit-testable with a hand-rolled decision and
 *     a spy `onAnswer`.
 *   - `submitDecisionAnswer` is the fetch wrapper (POST `/api/decisions/answer`),
 *     tested separately / mocked.
 *   - `DecisionAnswer` is the thin client wrapper the inbox row mounts: it wires
 *     the dialog to the wrapper, owns the pending/error/answered state machine.
 *
 * REDACTION (L2/L3): an option `label` is a redaction-typed `ListField`. A protected
 * label renders as `[protected: <class>]` — NEVER its value — exactly as the inbox
 * question does. The dialog must not breach the boundary the read inbox upholds.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { ListField, ListOption, RankedListItem } from './decision-inbox';

/** The answerable choices the answer transport recognizes. */
export type AnswerChoice = 'approve' | 'reject';

/**
 * The degraded/error result the fetch wrapper returns rather than throwing, so the
 * client wrapper can surface a calm message and KEEP the row (never crash). The
 * daemon `409` ("not answerable") and any unreachable/4xx/5xx both land here.
 */
export interface AnswerResult {
  ok: boolean;
  status: number;
  error?: string;
}

export interface DecisionAnswerDialogProps {
  /** the decision being answered; its `options` are the choices the dialog lists. */
  decision: RankedListItem;
  /** invoked with the chosen option id when the operator picks a choice. */
  onAnswer: (decisionId: string, chosenOption: string) => void;
  /** true while a submission is in flight — the dialog disables its choice controls. */
  pending?: boolean;
  /** a calm error/degraded message to surface inside the dialog (e.g. 409 / unreachable). */
  error?: string | null;
}

interface AnswerOptionLabelProps {
  field: ListField;
  /**
   * Optional rendering hint. The question is rendered through the same redaction
   * discrimination, but its DOM text is normalized so the gate can distinguish the
   * option label from the question in protected-label tests.
   */
  context?: 'question' | 'option';
}

/**
 * Render an option label (or question) through the SAME redaction discrimination as
 * the inbox question — a protected field is class-only and NEVER prints a value.
 */
export function AnswerOptionLabel({ field, context }: AnswerOptionLabelProps): React.ReactElement {
  if (field.kind === 'protected') {
    // A protected field is rendered class-only and NEVER prints its value \u2014
    // consistently `[protected: <class>] <field>` for both the question and option
    // labels (same chip as the inbox). `context` is retained for callers' intent
    // but does not change the redaction text.
    void context;
    return (
      <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
        [protected: {field.class}] {field.field}
      </span>
    );
  }
  return <span>{field.value}</span>;
}

/**
 * PURE presentational answer dialog. Opens from an "Answer" trigger and lists the
 * decision's options as full-width, stacked choice controls. Renders `pending` and
 * `error` from props alone — no network.
 */
export function DecisionAnswerDialog({
  decision,
  onAnswer,
  pending,
  error,
}: DecisionAnswerDialogProps): React.ReactElement {
  const options = decision.options ?? [];

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" size="sm" aria-label="Answer">
          Answer
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Answer decision</DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm">
              <AnswerOptionLabel field={decision.question} context="question" />
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No answer choices are available for this decision.
            </p>
          ) : (
            options.map((option) => (
              <Button
                key={option.id}
                type="button"
                variant="outline"
                className="w-full justify-start"
                disabled={pending}
                onClick={() => onAnswer(decision.decision_id, option.id)}
              >
                <AnswerOptionLabel field={option.label} />
              </Button>
            ))
          )}
        </div>

        {error && (
          <p className="text-sm text-muted-foreground" role="status">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The fetch wrapper: POST the chosen option to the dashboard proxy
 * `/api/decisions/answer` (which forwards to the daemon). Returns a typed
 * `AnswerResult` and NEVER throws — network errors are caught into a degraded
 * result so the caller can surface a calm message.
 */
export async function submitDecisionAnswer(
  decisionId: string,
  chosenOption: AnswerChoice,
): Promise<AnswerResult> {
  try {
    const res = await fetch('/api/decisions/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision_id: decisionId, chosen_option: chosenOption }),
    });

    let error: string | undefined;
    if (!res.ok) {
      try {
        const json = (await res.json()) as { error?: string };
        error = json.error;
      } catch {
        error = `Request failed (HTTP ${res.status})`;
      }
    }

    return { ok: res.ok, status: res.status, error };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : 'Could not submit answer',
    };
  }
}

export interface DecisionAnswerProps {
  /** the inbox row this control answers. */
  decision: RankedListItem;
  /** notify the parent inbox that this decision was answered (so the row can leave). */
  onAnswered?: (decisionId: string) => void;
}

/**
 * The per-row client control the inbox mounts: opens `DecisionAnswerDialog`, wires
 * it to `submitDecisionAnswer`, owns the pending → success (row leaves) / error
 * (row stays, calm message) state machine.
 */
export function DecisionAnswer({
  decision,
  onAnswered,
}: DecisionAnswerProps): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);

  async function handleAnswer(decisionId: string, chosenOption: string) {
    setPending(true);
    setError(null);

    const result = await submitDecisionAnswer(
      decisionId,
      chosenOption as AnswerChoice,
    );

    setPending(false);

    if (result.ok) {
      setAnswered(true);
      onAnswered?.(decisionId);
      return;
    }

    setError(
      result.error && result.error.length > 0
        ? `${result.error} — please try again.`
        : 'Could not submit answer — please try again.',
    );
  }

  if (answered) {
    return (
      <Button type="button" size="sm" disabled>
        Answered
      </Button>
    );
  }

  return (
    <DecisionAnswerDialog
      decision={decision}
      onAnswer={handleAnswer}
      pending={pending}
      error={error}
    />
  );
}

/** Re-export the option type for callers wiring the dialog. */
export type { ListOption };
