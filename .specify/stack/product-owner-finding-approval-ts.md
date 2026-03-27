---
id: STACK-AC-PRODUCT-OWNER-FINDING-APPROVAL
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-PRODUCT-OWNER
code_paths:
  - packages/daemon/src/coordination/product-owner/finding-approval.ts
  - packages/daemon/src/coordination/product-owner/schemas.ts
test_paths:
  - packages/daemon/src/coordination/product-owner/finding-approval.test.ts
---

# STACK-AC-PRODUCT-OWNER-FINDING-APPROVAL — PO Finding Approval (TypeScript)

## Pattern

**Finding approval as structured session output applied via Octokit side-effects.** Mirror of the Tech Lead triage pattern (STACK-AC-TECH-LEAD-TRIAGE): the PO session produces an array of `POFindingDecision` objects as part of `POAnalysisOutput`. After session parsing, the Coordinator applies each decision via Octokit label mutations and comments. Daily cap enforcement happens before the session: the Coordinator counts that day's approvals from persistent state and caps the batch of `tl-approved` findings injected into the SignalSnapshot at `poFindingDailyCap` (default: 5). Same Octokit injection pattern as Tech Lead triage — Octokit is passed as a dependency, never constructed in `finding-approval.ts`.

Why this pattern over alternatives: pre-session cap enforcement keeps the PO session deterministic (it only sees findings it is allowed to act on), and Octokit side-effects outside the session boundary keeps the PO session stateless and testable. Mirrors the established Tech Lead triage pattern for consistency across agents.

**`tl-approved` findings in SignalSnapshot.** The Coordinator extends SignalSnapshot assembly to query GitHub for issues labeled `tl-approved` that lack `po-approved`, `po-rejected`, and `needs-discussion`. These become a new `findingsAwaitingApproval` section in the snapshot, capped by remaining daily capacity. The PO session evaluates each finding against current priorities and capacity.

## Key Decisions

**`POFindingDecisionSchema` — flat schema, verdict enum discriminates behavior.** Same flat-schema pattern as `TriageDecisionSchema` in STACK-AC-TECH-LEAD-TRIAGE. All verdicts share the same fields. No discriminated union needed.

```typescript
const POFindingDecisionSchema = z.object({
  issueNumber: z.number().int().positive(),
  verdict: z.enum(['approve', 'reject', 'needs_discussion']),
  reason: z.string().min(1),
  discussionContext: z.string().optional(), // only for 'needs_discussion'
});
```

**`POFindingDailyCapSchema` — date-keyed daily counter persisted in file.** State stored in `state/coordination/product-owner/finding-cap-state.json`. Counter resets when `state.date !== today`. Atomic write via `writeJsonSafe` (STACK-AC-CONVENTIONS). Same pattern as `TriageStateSchema` in STACK-AC-TECH-LEAD-TRIAGE.

```typescript
const POFindingDailyCapSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  approvedCount: z.number().int().nonnegative(),
});
```

**`POAnalysisOutputSchema` extension — `findingDecisions` added additively.** The existing `POAnalysisOutputSchema` in `schemas.ts` gains `findingDecisions: z.array(POFindingDecisionSchema).default([])`. Additive change — existing callers continue to work unchanged. Same extension pattern as `triageDecisions` on `TechLeadOutputSchema`.

```typescript
// Addition to existing POAnalysisOutputSchema
const POAnalysisOutputSchema = z.object({
  proposals: z.array(RawProposalSchema).default([]),
  protocolTriggers: z.array(z.enum(['backlog_grooming', 'escalation'])).default([]),
  findingDecisions: z.array(POFindingDecisionSchema).default([]),
});
```

**`FindingAwaitingApproval` — snapshot section for tl-approved findings.** Added to `SignalSnapshotSchema` as a new optional array section. Each entry carries the issue number, title, severity labels, and TL approval reason (extracted from the TL comment). Capped at remaining daily capacity before injection.

```typescript
const FindingAwaitingApprovalSchema = z.object({
  issueNumber: z.number().int().positive(),
  title: z.string(), severityLabel: z.string().optional(),
  tlApprovalReason: z.string(),
});
```

**Daily cap applies only to `approve` verdicts.** `reject` and `needs_discussion` do not consume cap budget — they resolve or defer findings without creating new approval obligations. Consistent with Tech Lead triage where only `approve` and `promote` count toward the cap. Cap is independent of TL triage cap (L1 constraint).

**Octokit label application per verdict.** For `approve`: add `po-approved`, post comment with reason, increment daily cap counter. For `reject`: remove `tl-approved`, add `po-rejected`, post comment with reason. For `needs_discussion`: add finding to SharedPOState `needsDiscussion` queue (STACK-AC-PRODUCT-OWNER-INTERACTIVE) with `sourceType: 'finding'`, post comment noting the finding is queued for operator discussion. No cap counter increment for reject or needs_discussion.

```typescript
// Label mapping per verdict — applied via injected Octokit
const VERDICT_LABELS: Record<string, { add: string[]; remove: string[] }> = {
  approve: { add: ['po-approved'], remove: [] },
  reject: { add: ['po-rejected'], remove: ['tl-approved'] },
  needs_discussion: { add: ['needs-discussion'], remove: [] },
};
```

**`auto-fix-approved` bypass.** Findings labeled `auto-fix-approved` are excluded from the PO finding approval flow entirely. The Coordinator filters them out during SignalSnapshot assembly. They bypass both TL and PO triage (L1: "Operator overrides triage via auto-fix-approved"). The PO's daily cap does not apply to these findings.

**Operator confirmation is external to this module.** After `po-approved` is applied, the finding is surfaced to the Operator via briefing or interactive session. The Operator confirms by adding the `ready` label (or equivalent). This confirmation step is handled by the Dashboard/interactive session layer (STACK-AC-PRODUCT-OWNER-INTERACTIVE), not by `finding-approval.ts`. The `finding-approval.ts` module's responsibility ends at label application.

**SharedPOState integration for needs-discussion.** When the PO returns a `needs_discussion` verdict, the Coordinator adds a `NeedsDiscussionItem` to SharedPOState (STACK-AC-PRODUCT-OWNER-INTERACTIVE) with `sourceType: 'finding'` and `sourceRef` set to the issue URL. This uses the existing `writeSharedPOState` with optimistic concurrency — same write pattern, no new persistence mechanism.

**Config extension.** New setting in `config.ts` (STACK-AC-CONVENTIONS): `poFindingDailyCap` (default: 5). Independent of TL's `triageDailyCap`. Added to the existing PO config section alongside `poInterval`, `poIdeaDebounce`, etc.

## Examples

```typescript
// Daily cap — resets by calendar date, counts only approve verdicts
function getRemainingCapacity(state: POFindingDailyCap, cap: number): number {
  const today = new Date().toISOString().slice(0, 10);
  return cap - (state.date === today ? state.approvedCount : 0);
}
```

```typescript
// Apply verdict — label + comment via injected Octokit (never constructed here)
const mapping = VERDICT_LABELS[decision.verdict];
await octokit.issues.addLabels({ owner, repo, issue_number: d.issueNumber, labels: mapping.add });
for (const l of mapping.remove) await octokit.issues.removeLabel({ owner, repo, issue_number: d.issueNumber, name: l }).catch(() => {});
await octokit.issues.createComment({ owner, repo, issue_number: d.issueNumber, body: `**PO ${d.verdict}:** ${d.reason}` });
```

```typescript
// Fetch tl-approved findings, filter out already-processed labels client-side
const issues = await octokit.issues.listForRepo({ owner, repo, labels: 'tl-approved', state: 'open' });
const skipLabels = ['po-approved', 'po-rejected', 'needs-discussion', 'auto-fix-approved'];
return issues.data.filter(i => !i.labels.some(l => skipLabels.includes(labelName(l))));
```

```typescript
// Cap state persistence — atomic write via writeJsonSafe
async function incrementCapCounter(statePath: string): Promise<void> {
  const state = await readCapState(statePath);
  const today = new Date().toISOString().slice(0, 10);
  const updated = state.date === today
    ? { date: today, approvedCount: state.approvedCount + 1 }
    : { date: today, approvedCount: 1 };
  await writeJsonSafe(statePath, updated);
}
```

## Gotchas

- `octokit.issues.removeLabel` throws a 404 when the label is not present on the issue — always `.catch(() => {})` on remove calls. `addLabels` is idempotent and safe. Same caveat as STACK-AC-TECH-LEAD-TRIAGE.
- The daily cap resets by calendar date (`YYYY-MM-DD`), not a rolling 24-hour window. When loading state, compare `state.date` to today's date string — if they differ, treat `approvedCount` as 0. Same pattern as TL triage state.
- The PO cap (default 5) is independent of the TL triage cap (default 5). They track separate counters in separate state files. Do not share state between them.
- `auto-fix-approved` findings must be filtered out during SignalSnapshot assembly, not in the PO session. If they reach the session, the PO may waste cap budget evaluating findings that bypass the triage lifecycle entirely.
- Operator confirmation (adding `ready` label after `po-approved`) happens outside this module. Do not add operator confirmation logic to `finding-approval.ts` — it is owned by the interactive session and dashboard layers.
- When the PO returns `needs_discussion`, the SharedPOState write may fail due to version conflict (concurrent daemon cycle). Retry with `writeWithRetry` (STACK-AC-PRODUCT-OWNER-INTERACTIVE pattern). If retries exhaust, log the failure — the finding remains labeled `needs-discussion` on GitHub even if the SharedPOState write fails. The next interactive session can detect the label and surface the item.
- Race condition on cap counter: two concurrent PO cycles could both read the same `approvedCount` and both approve, exceeding the cap. This is acceptable — the PO runs as a single instance (`min: 1, max: 1` in agent pool), so concurrent cycles do not occur under normal operation. The Coordinator defers autonomous cycles when an interactive session is active (STACK-AC-PRODUCT-OWNER-INTERACTIVE). No locking needed.
- `tl-approved` findings that are also labeled `po-rejected` from a prior cycle may re-enter the queue if the Tech Lead re-triages them (removes `po-rejected`, re-adds `tl-approved`). The `fetchFindingsAwaitingApproval` filter handles this correctly — it checks for the absence of `po-approved`, `po-rejected`, and `needs-discussion`.
- Finding decisions are applied only if the session output parses successfully. On parse failure, no labels or comments are applied and the cycle is logged as producing zero finding actions — same pattern as triage parse failure in STACK-AC-TECH-LEAD-TRIAGE.
- When `finding-cap-state.json` does not exist (first run or fresh install), `readCapState` should return `{ date: today, approvedCount: 0 }` rather than throwing. Same defensive read pattern as TL triage state.
- Daily cap reset uses UTC dates (`toISOString().slice(0, 10)`), so the "day" boundary may not align with the operator's local timezone. This is a conscious trade-off for consistency with TL triage and avoidance of timezone configuration complexity.
