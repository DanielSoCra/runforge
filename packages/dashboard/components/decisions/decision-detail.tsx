/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — the per-decision drill-down detail (read).
 *
 * The deferred "detail" follow-up of the operator surface (decision-inbox.tsx SCOPE
 * note): when the Operator drills into a decision, this surfaces the CONTEXT they need
 * to decide — the question, context slice, the consequence of not answering, how
 * reversible it is, the risk class, the deployment, the recommended option, and the
 * source link — projected from the daemon Decision API's `GET /decisions/:id`
 * (`DetailView`, see packages/daemon/src/control-plane/decision-api.ts).
 *
 * CONTEXT-FIRST, NOT OUTCOME/QA (decision-brief D2-C): this drawer shows only data the
 * platform already has. It MUST NOT imply a quality verdict — there is no QA / change-
 * review signal in this view, so it never renders the words "QA", "safe", "passed", or
 * "ready". A real outcome-first view waits on FUNC-AC-QA (a future spec).
 *
 * REDACTION: a `DetailField` is a discriminated union; a `protected` field renders as
 * "[protected: <class>]" and never prints a value. (After the sanitization strip the
 * default deployment produces no protected fields; this arm only renders legacy /
 * sanitizer-plugin rows.)
 *
 * STUB: bodies throw so the RED tests fail for the right reason while the dashboard
 * typechecks. Kimi implements per the work-order; the types + tests are the gate.
 */
'use client';

import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/** Detail-surface redaction-typed field (mirrors the daemon `DetailField`). */
export type DetailField =
  | { kind: 'text'; value: string }
  | { kind: 'protected'; field: string; class: string; ref?: string };

/** A choice on the decision (mirrors the daemon `DetailOption`). */
export interface DetailOption {
  id: string;
  label: DetailField;
  detail?: DetailField;
}

/**
 * The decision detail the drawer renders, mirroring the daemon `DetailView` wire
 * shape (the subset the surface shows). Dashboard-local — the boundary is JSON over
 * HTTP, never a dependency on `@auto-claude/decision-index`.
 */
export interface DecisionDetailData {
  decision_id: string;
  status: string;
  risk_class: string;
  deployment: string;
  source_url: string;
  reversibility: string | null;
  recommended_option: string | null;
  expires_at: string | null;
  created_at: string;
  question: DetailField;
  context: DetailField | null;
  consequence_of_no_answer: DetailField | null;
  options: DetailOption[];
}

function riskBadgeVariant(
  riskClass: string,
): 'destructive' | 'secondary' | 'default' | 'outline' {
  switch (riskClass) {
    case 'P0':
      return 'destructive';
    case 'P1':
      return 'secondary';
    case 'P2':
      return 'default';
    case 'P3':
      return 'outline';
    default:
      return 'outline';
  }
}

/**
 * Only an http(s) URL is rendered as a clickable link. A DecisionRequest's
 * `source_url` is schema-typed only as a non-empty string, so a crafted
 * `javascript:` / `data:` value must never become a clickable href (XSS vector).
 * Anything that doesn't parse as http(s) renders as plain text.
 */
function safeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function DetailField({ field }: { field: DetailField }): React.JSX.Element {
  if (field.kind === 'protected') {
    return (
      <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
        [protected: {field.class}]
      </span>
    );
  }
  return <span>{field.value}</span>;
}

/**
 * Pure presentational detail view. Renders the context fields from a
 * `DecisionDetailData`; protected fields render as their class marker only. No fetch,
 * no state — testable from props alone.
 */
export function DecisionDetailView({
  detail,
}: {
  detail: DecisionDetailData;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={riskBadgeVariant(detail.risk_class)}>
          {detail.risk_class}
        </Badge>
        <span className="text-sm text-muted-foreground">{detail.status}</span>
        <span className="text-sm text-muted-foreground">
          {detail.deployment}
        </span>
        {detail.reversibility !== null && (
          <span className="text-sm text-muted-foreground">
            {detail.reversibility}
          </span>
        )}
      </div>

      <div>
        {safeHttpUrl(detail.source_url) !== null ? (
          <a
            href={detail.source_url}
            className="text-sm text-primary hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            {detail.source_url}
          </a>
        ) : (
          <span className="text-sm text-muted-foreground">{detail.source_url}</span>
        )}
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">Question</h4>
        <p className="text-sm">
          <DetailField field={detail.question} />
        </p>
      </div>

      {detail.context !== null && (
        <div className="space-y-1">
          <h4 className="text-sm font-medium">Context</h4>
          <p className="text-sm">
            <DetailField field={detail.context} />
          </p>
        </div>
      )}

      {detail.consequence_of_no_answer !== null && (
        <div className="space-y-1">
          <h4 className="text-sm font-medium">If unanswered</h4>
          <p className="text-sm">
            <DetailField field={detail.consequence_of_no_answer} />
          </p>
        </div>
      )}

      <div className="space-y-1">
        <h4 className="text-sm font-medium">Options</h4>
        <ul className="space-y-1">
          {detail.options.map((option) => (
            <li key={option.id} className="text-sm">
              <DetailField field={option.label} />
              {detail.recommended_option === option.id && (
                <span className="ml-2 text-xs text-muted-foreground">
                  (recommended)
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Client wrapper: a "Details" toggle that, on first open, fetches
 * `/api/decisions/<id>` and renders the `DecisionDetailView`, with calm loading /
 * unavailable states (never a thrown render). Collapsed by default.
 */
export function DecisionDetailPanel({
  decisionId,
}: {
  decisionId: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DecisionDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const handleToggle = useCallback(async () => {
    const nextOpen = !open;
    setOpen(nextOpen);

    if (nextOpen && detail === null && !loading && !unavailable) {
      setLoading(true);
      try {
        const res = await fetch(
          '/api/decisions/' + encodeURIComponent(decisionId),
        );
        if (!res.ok) {
          setUnavailable(true);
          return;
        }
        const data = (await res.json()) as DecisionDetailData;
        setDetail(data);
      } catch {
        setUnavailable(true);
      } finally {
        setLoading(false);
      }
    }
  }, [open, detail, loading, unavailable, decisionId]);

  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleToggle}
      >
        Details
      </Button>
      {open && (
        <div className="mt-3 rounded-md border p-3">
          {loading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {unavailable && (
            <p className="text-sm text-muted-foreground">
              Detail unavailable.
            </p>
          )}
          {!loading && !unavailable && detail !== null && (
            <DecisionDetailView detail={detail} />
          )}
        </div>
      )}
    </div>
  );
}
