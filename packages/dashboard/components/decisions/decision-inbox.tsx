/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — the Operator Surface decisions inbox (read).
 *
 * The ranked pending-decisions inbox rendered on the operator-surface route
 * (FUNC-AC-OPERATOR-SURFACE: "the operator surface shows decisions and the
 * briefing"). This is the PRESENTATIONAL core: a pure component that takes a plain
 * `RankedListItem[]` (mirroring the daemon Decision API's `GET /decisions/pending`
 * wire shape — see `packages/daemon/src/control-plane/decision-api.ts`) plus an
 * `unavailable` degraded flag, and renders rows / empty / degraded from props
 * alone. The server component (`app/(dashboard)/steering/page.tsx`) owns the fetch
 * via the proxy route (`app/api/decisions/pending/route.ts`); this owns pixels.
 *
 * REDACTION (L2/L3): a `question` (or any `ListField`) is a discriminated union.
 * A `protected` field carries ONLY its class marker (no resolvable value/ref by
 * type) and MUST render as "[protected: <class>]" — never a value. The list type
 * structurally cannot carry a `ref`; the reveal is server-side on the deferred
 * detail path only.
 *
 * SCOPE (7b): the READ inbox list only. The per-decision drill-down detail and
 * the operator ANSWER flow are deferred follow-ups.
 *
 * STUB: not implemented — Kimi implements per the work-order. The body throws so
 * the RED component test fails for the right reason while the dashboard typechecks.
 */

/**
 * The list-surface redaction-typed field. A `protected` field is class-only — it
 * NEVER carries a resolvable value or ref (that lives only on the detail surface).
 * Structurally mirrors the daemon `ListField` (decision-index read model).
 */
export type ListField =
  | { kind: 'text'; value: string }
  | { kind: 'protected'; field: string; class: string };

/**
 * A single answerable choice on a decision, mirroring the daemon `ListOption` wire
 * shape (`packages/decision-index/src/read-model.ts`). The `label` is itself a
 * redaction-typed `ListField` — an option label CAN be protected, so the answer
 * dialog renders it through the SAME redaction discrimination as the question and
 * never prints a protected value. `id` is the stable choice key submitted as
 * `chosen_option` (the answerable transport recognizes `approve`/`reject`).
 */
export interface ListOption {
  id: string;
  label: ListField;
  detail?: ListField;
}

/**
 * A ranked inbox row, mirroring the daemon `RankedListItem` wire shape (the fields
 * the inbox renders). Kept as a dashboard-local type — the dashboard does NOT
 * depend on `@auto-claude/decision-index`; the boundary is JSON over HTTP.
 */
export interface RankedListItem {
  decision_id: string;
  status: string;
  risk_class: string;
  created_at: string;
  question: ListField;
  /**
   * The answerable choices for this decision (approve/reject); drives the answer
   * dialog. Optional on the row type so the read-inbox fixtures (which predate the
   * answer flow) stay structurally valid; the daemon wire shape always carries it,
   * and the answer dialog treats a missing/empty list as "no choices to offer".
   */
  options?: ListOption[];
  /**
   * The rung-2 pre-fill: the recommended option's `id` (`approve`/`reject`), or
   * null/absent when there is no recommendation (PR1 look). The daemon wire shape
   * (`RankedListItem.recommended_option`, decision-index read model) carries it; the
   * answer dialog highlights the matching option + shows its `detail` reason.
   * Optional so pre-answer-flow fixtures stay valid; the proxy passes it through.
   */
  recommended_option?: string | null;
  score: number;
  why_ranked: string;
}

export interface DecisionInboxProps {
  items: RankedListItem[];
  /** true when the daemon Decision API is unreachable/degraded — render the calm degraded panel. */
  unavailable?: boolean;
  /** optional callback fired when a decision is answered through the row control. */
  onAnswered?: (decisionId: string) => void;
}

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { AlertTriangle, Inbox } from 'lucide-react';
import { DecisionAnswer } from './decision-answer';
import { DecisionDetailPanel } from './decision-detail';

/**
 * Map the wire `risk_class` (`P0|P1|P2|P3` — decision-protocol `RISK_CLASSES`)
 * to a shadcn `Badge` variant. P0 is the most urgent / destructive class and
 * gets the loudest treatment; P3 is the calmest. Unknown values fall back to
 * the muted `outline` so an unexpected class never reads as urgent.
 */
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

function QuestionField({ field }: { field: ListField }) {
  if (field.kind === 'protected') {
    return (
      <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
        [protected: {field.class}] {field.field}
      </span>
    );
  }
  return <span>{field.value}</span>;
}

export function DecisionInbox({ items, unavailable, onAnswered }: DecisionInboxProps) {
  if (unavailable === true) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-muted-foreground" />
            Decision index unavailable
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Decisions are temporarily unavailable. They will appear here once
            the connection is restored.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Inbox className="h-5 w-5 text-muted-foreground" />
            No decisions awaiting you
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Nothing needs your attention right now.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Render in the EXACT daemon-ranked order — the daemon returns a global ranked
  // order the client MUST preserve and never re-rank (L3: "render daemon order,
  // do not re-rank"; FUNC-AC-FLEET owns ranking). Date separators are inline
  // headers inserted only when the date CHANGES from the previous row in ranked
  // sequence — they never regroup or sort, so a [today, yesterday, today] ranked
  // list stays in that order (and shows the date header three times). The header
  // condition is derived purely from the preceding item (no render-time mutation).
  return (
    <div className="flex flex-col gap-3">
      {items.map((item, index) => {
        const date = item.created_at.slice(0, 10);
        const previousDate =
          index > 0 ? items[index - 1].created_at.slice(0, 10) : null;
        const showDateHeader = date !== previousDate;

        return (
          <div key={item.decision_id} className="flex flex-col gap-3">
            {showDateHeader && (
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {date}
              </div>
            )}
            <div className="flex flex-col gap-2 rounded-xl border p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={riskBadgeVariant(item.risk_class)}>
                    {item.risk_class}
                  </Badge>
                  <time
                    dateTime={item.created_at}
                    className="text-xs text-muted-foreground"
                  >
                    {new Date(item.created_at).toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: 'UTC',
                      hour12: false,
                    })}
                  </time>
                </div>
                <div className="text-sm">
                  <QuestionField field={item.question} />
                </div>
                <DecisionDetailPanel decisionId={item.decision_id} />
              </div>
              <div className="flex shrink-0 items-start pt-1 sm:pt-0">
                <DecisionAnswer decision={item} onAnswered={onAnswered} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
