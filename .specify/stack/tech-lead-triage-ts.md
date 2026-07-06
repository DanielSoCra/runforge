---
id: STACK-AC-TECH-LEAD-TRIAGE
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-TECH-LEAD
code_paths:
  - packages/daemon/src/coordination/tech-lead/finding-triage.ts
test_paths:
  - packages/daemon/src/coordination/tech-lead/finding-triage.test.ts
---

# STACK-AC-TECH-LEAD-TRIAGE — Tech Lead Finding Triage (TypeScript)

## Pattern

**Finding triage as structured session output applied via Octokit side-effects.** The Tech Lead session produces an array of `TriageDecision` objects alongside its proposals output. After session parsing, the Coordinator applies each decision: adds GitHub labels (`tl-triaged` plus a verdict label) and posts an explanatory comment via `@octokit/rest`. Daily cap enforcement happens before the session: the Coordinator fetches untriaged issues, counts that day's approvals from persistent state, and caps the batch at `triageDailyCap` (default: 5) before injecting findings into the signal digest. Same Octokit injection pattern as `phases.ts` and `phases-website.ts` — Octokit is passed as a dependency, never constructed in `finding-triage.ts`.

Why this pattern over alternatives: triage decisions inside the session output keeps the cap logic deterministic (counted before spawning, not guessed during), and Octokit side-effects outside the session boundary keeps the Tech Lead session stateless and testable with mock deps.

## Key Decisions

**`TriageDecisionSchema` — flat schema, verdict enum discriminates behavior.** All verdicts share the same fields (`issueNumber`, `verdict`, `reason`, optional `newSeverity` for promote). No discriminated union — field shapes are identical, the same pattern as `TechnicalProposalSchema` where `proposalType` discriminates behavior.

```typescript
const TriageDecisionSchema = z.object({
  issueNumber: z.number().int().positive(),
  verdict: z.enum(['approve', 'reject', 'promote', 'defer']),
  reason: z.string().min(1),
  newSeverity: z.string().optional(), // only meaningful for 'promote'
});
```

**`TriageStateSchema` — date-keyed daily counter persisted in file.** State stored in `state/coordination/tech-lead/triage-state.json`. Counter resets when `state.date !== today`. Atomic write on each update (same file-based persistence pattern as `STACK-AC-TECH-LEAD`).

```typescript
const TriageStateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
  approvedCount: z.number().int().nonnegative(),
});
```

**Untriaged issues fetched via Octokit, not Knowledge Service.** Finding triage reads GitHub issues directly (`octokit.issues.listForRepo` with `labels: 'review-finding'`, `state: 'open'`), then filters client-side for issues missing the `tl-triaged` label. Knowledge Service `reviewFindings` in `SignalDigestSchema` are KnowledgeRecords used for proposal generation — they are a separate (overlapping) concern from the triage inbox.

**`TechLeadOutputSchema` extension — `triageDecisions` added additively.** The session output schema in `schemas.ts` gains `triageDecisions: z.array(TriageDecisionSchema).default([])`. Additive change — existing callers continue to work unchanged. Defined in `schemas.ts`; `TriageDecisionSchema` exported from `finding-triage.ts` and re-exported via schemas for co-location of session output shape.

**Daily cap applies only to `approve` and `promote` verdicts.** `reject` and `defer` decisions do not consume cap budget — they resolve or defer work without creating new approval obligations. Cap check: `remaining = triageDailyCap − state.approvedCount`; only issues slated for approval count toward it.

**Octokit label application — `addLabels` for verdict, `removeLabel` for severity change.** For `approve`: add `['tl-approved', 'tl-triaged']`. For `reject`: add `['tl-triaged']`, close issue. For `promote`: add `['tl-triaged', 'tl-approved', newSeverity]`, remove old severity label with `.catch(() => {})`. For `defer`: add `['tl-triaged', 'deferred']`. Always `createComment` with `reason` for audit trail.

## Examples

```typescript
// Triage decision schema — flat, verdict discriminates behavior
const TriageDecisionSchema = z.object({
  issueNumber: z.number().int().positive(),
  verdict: z.enum(['approve', 'reject', 'promote', 'defer']),
  reason: z.string().min(1),
  newSeverity: z.string().optional(),
});
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;
```

```typescript
// Daily cap — resets by calendar date, counts only approve+promote
function getRemainingCapacity(state: TriageState, cap: number): number {
  const today = new Date().toISOString().slice(0, 10);
  return cap - (state.date === today ? state.approvedCount : 0);
}
```

```typescript
// Apply verdict — label + comment via injected Octokit (never constructed here)
await octokit.issues.addLabels({ owner, repo, issue_number: d.issueNumber, labels: labelsFor(d) });
await octokit.issues.createComment({ owner, repo, issue_number: d.issueNumber, body: d.reason });
```

## Gotchas

- `octokit.issues.removeLabel` throws a 404 when the label is not present on the issue — always `.catch(() => {})` on remove calls. `addLabels` is idempotent and safe.
- The daily cap resets by calendar date (`YYYY-MM-DD`), not rolling 24-hour window. When loading state, compare `state.date` to today's date string — if they differ, treat `approvedCount` as 0.
- `approve` and `promote` both count toward the daily cap. `reject` and `defer` do not. Compute remaining capacity before injecting the untriaged batch into the digest so the Tech Lead session only sees the issues it is allowed to approve.
- Applying `tl-approved` routes the finding to the PO approval queue — it does not create work directly. Never skip this gate. The PO still decides whether a `tl-approved` finding becomes a work item.
- `octokit.issues.listForRepo` with `labels: 'review-finding'` returns all issues with that label. Filter client-side for issues that do NOT have `tl-triaged` in their `labels` array. Do not use a negative label filter in the API call — the REST API does not support label exclusion natively.
- For `promote`, the old severity label (e.g., `P3`) must be removed before or alongside adding the new one (e.g., `P2`). Fetch the issue's current labels to identify which severity label to remove rather than hardcoding.
- Triage decisions are applied only if the session output parses successfully. On parse failure (malformed JSON or schema violation), no labels or comments are applied and the cycle is logged as producing zero triage actions — same pattern as proposal parse failure in `session-output-parser.ts`.
