---
id: STACK-AC-PRODUCT-OWNER
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-PRODUCT-OWNER
code_paths:
  - packages/daemon/src/coordination/product-owner/
  - packages/daemon/src/coordination/product-owner/schemas.ts
  - packages/daemon/src/coordination/product-owner/signal-analyzer.ts
  - packages/daemon/src/coordination/product-owner/proposal-generator.ts
  - packages/daemon/src/coordination/product-owner/session-output-parser.ts
  - packages/daemon/src/coordination/product-owner/protocol-round-formatter.ts
  - packages/daemon/src/coordination/product-owner/idea-processor.ts
  - prompts/product-owner.md
  - prompts/product-owner-enrichment.md
test_paths:
  - packages/daemon/src/coordination/product-owner/**/*.test.ts
---

# STACK-AC-PRODUCT-OWNER — Product Owner Agent (TypeScript)

## Pattern

**PO as a spawned session with structured output.** The PO is not a long-running process. The Coordinator spawns it via Session Runtime on a configurable schedule (default: 30 minutes) or on events (idea submission, batch completion). Each session receives a read-only SignalSnapshot as context and returns structured output (zero or more RawProposals, optional protocol trigger requests). The Coordinator parses the output and takes action. Same spawn pattern as other pooled agents in STACK-AC-COORDINATION — registered as agent type `product_owner` with min 1, max 1.

**Data models as Zod schemas with inferred types.** RawProposal, SignalSnapshot, ProposalEnrichmentReview, and all protocol round output types are defined as Zod schemas. TypeScript types derived via `z.infer`. Runtime validation on read, type safety on write. Follows the project's Zod-first pattern (STACK-AC-CONVENTIONS, STACK-AC-COORDINATION).

**SignalSnapshot as transient input document.** The Coordinator assembles the SignalSnapshot before spawning the PO session. The snapshot is not persisted — it is a read-only context passed to the session. Each section maps to an existing data source (spec directory, run history, proposal store, issue backlog, idea inbox, knowledge service). The PO never queries these sources directly.

**Protocol round outputs as typed discriminated objects.** Each protocol type has a dedicated Zod schema for the PO's round output. The session-output-parser selects the correct schema based on the protocol context passed to the session. This avoids a single monolithic output type while keeping validation strict per protocol.

**File-based persistence for PO-generated proposals.** RawProposals produced by the PO session are stored by the Coordinator as individual JSON files in `state/coordination/product-owner/proposals/{id}.json`. The PO does not write these files directly — the Coordinator processes session output and persists it. Follows the project's file-based persistence pattern (STACK-AC-CONVENTIONS).

**Prompt template: Markdown file in `prompts/product-owner.md`.** Template with `{{signal_snapshot}}` placeholder. Rendered via `String.replaceAll()` (STACK-AC-KNOWLEDGE pattern). The template instructs the model to output JSON matching `POAnalysisOutputSchema`. Enrichment review uses a separate template `prompts/product-owner-enrichment.md` with `{{proposal}}` and `{{tech_lead_assessment}}` placeholders.

## Key Decisions

**RawProposal schema.** Single Zod schema covering all PO proposal types. The `proposalType` field discriminates behavior, not shape — all proposals share the same fields. The Coordinator converts RawProposals into Proposal records (STACK-AC-COORDINATION ownership).

```typescript
const ProposalTypeSchema = z.enum([
  'spec_advancement', 'stale_investigation',
  'backlog_prioritization', 'operator_idea_refinement',
]);
```

```typescript
// Key fields — Coordinator adds id, status, timestamps when creating Proposal record
const RawProposalSchema = z.object({
  title: z.string(), rationale: z.string(),
  proposalType: ProposalTypeSchema,
  relatedRefs: z.array(z.string()), // spec IDs or issue numbers
  estimatedScope: z.enum(['small', 'medium', 'large']),
});
```

**SignalSnapshot schema.** Assembled by the Coordinator, validated by the PO session on receipt. Each section is independently optional (partial snapshots are valid when sources are unavailable).

```typescript
// 8 sections, all default([]) for partial snapshot support; key sub-schemas below
const SignalSnapshotSchema = z.object({
  cycleTimestamp: z.string().datetime(),
  specPipeline: z.array(SpecGapEntrySchema).default([]),
  // also: deliverySummary, backlog, activeProposals, proposalHistory, ideaInbox, missingSources
});
```

**SpecGapEntry schema.** Represents a single spec's layer chain status for pipeline gap analysis.

```typescript
const SpecGapEntrySchema = z.object({
  specId: z.string(), hasL1: z.boolean(), hasL2: z.boolean(),
  hasL3: z.boolean(), isImplemented: z.boolean(),
});
```

**Protocol round output schemas.** Each protocol type has a dedicated Zod schema for the PO's round output: `POBatchPlanningOutputSchema` (prioritized items with rationale), `POEnrichmentReviewSchema` (forward/reject decision), `POBacklogGroomingOutputSchema` (re-prioritized backlog), `POStatusSyncOutputSchema` (priority changes and outcomes), `PORetrospectiveOutputSchema` (expectations vs actuals), `POEscalationInitiateSchema` / `POEscalationResponseSchema`. The session-output-parser selects the correct schema via a `Record<ProtocolType, ZodSchema>` lookup.

```typescript
// Representative protocol schema — others follow same shape
const POEnrichmentReviewSchema = z.object({
  decision: z.enum(['forward', 'reject']), reason: z.string(),
  scopeAdjustments: z.array(z.string()).default([]),
});
```

**PO analysis cycle output schema.** Top-level output from a standalone analysis session.

```typescript
const POAnalysisOutputSchema = z.object({
  proposals: z.array(RawProposalSchema).default([]),
  protocolTriggers: z.array(z.enum(['backlog_grooming', 'escalation'])).default([]),
});
```

**Signal analysis: Gap detection from SpecGapEntry array.** The PO session receives pre-computed spec pipeline state. It identifies advancement opportunities by finding specs with incomplete layer chains (`hasL2: false`, `hasL3: false`, `isImplemented: false`). The gap computation itself happens in the Coordinator during SignalSnapshot assembly — it reads `traceability.yml` and checks for children at each layer.

**Proposal history deduplication.** The PO session receives recent proposal history (approved, rejected, expired) as part of the SignalSnapshot. The prompt template instructs the model to check `proposalHistory` before generating new proposals and avoid re-proposing recently rejected work without new justification. The Coordinator also applies duplicate detection (ARCH-AC-PRODUCT-OWNER) as a second layer — comparing `relatedRefs` overlap between new RawProposals and active Proposals.

**Idea processing: Debounced via Coordinator.** When an IdeaSubmission arrives, the Coordinator debounces (default: 5 minutes) before including it in the next PO cycle's SignalSnapshot `ideaInbox`. The PO refines ideas into RawProposals with `proposalType: 'operator_idea_refinement'` and a `relatedRefs` entry linking to the IdeaSubmission ID. The Coordinator marks the IdeaSubmission as processed after creating the Proposal record.

**Retrospective output: Business lessons.** The PO's retrospective round produces structured business observations (expectations vs actuals, business-level lessons). The Coordinator submits these to the Knowledge Service as `business_observation` records with `originType: 'retrospective-po'` and `lifecycleStatus: 'candidate'`.

```typescript
// Retrospective — expectations vs actuals + distilled business lessons
const PORetrospectiveOutputSchema = z.object({
  expectationsVsActuals: z.array(z.object({ item: z.string(), expected: z.string(), actual: z.string() })),
  businessLessons: z.array(z.object({ description: z.string(), artifactRefs: z.array(z.string()) })),
});
```

**Remaining protocol schemas.** Status Sync carries priority changes and proposal outcomes. Escalation has two variants: PO-initiated (priority shift with urgency) and PO response (chosen option with rationale). Backlog Grooming returns a re-prioritized list with movement direction and rationale per item. All follow the same flat Zod object pattern — arrays of typed entries with string references.

**Config extension: Added to existing config schema.** New settings in `config.ts` (STACK-AC-CONVENTIONS): `poInterval` (default: 1800 seconds), `poIdeaDebounce` (default: 300 seconds), `poProposalExpiry` (default: 7 days in ms), `poMaxProposalsPerCycle` (default: 5), `poProposalHistoryWindow` (default: 30 days), `poSpecPipelineEnabled` (default: true).

## Examples

```typescript
// Session output parsing — select schema by protocol context
function parsePOOutput(raw: unknown, context: POSessionContext): POOutput {
  if (!context.protocolType) return POAnalysisOutputSchema.parse(raw);
  const schema = PROTOCOL_OUTPUT_SCHEMAS[context.protocolType];
  return schema.parse(raw);
}
```

```typescript
// Spec gap detection — Coordinator assembles from traceability.yml
function computeSpecGaps(traceability: TraceabilityMap): SpecGapEntry[] {
  return traceability.getL1Specs().map(spec => ({
    specId: spec.id, hasL1: true,
    hasL2: spec.children.some(c => c.layer === 2),
    hasL3: spec.children.some(c => c.layer === 3),
    isImplemented: spec.children.some(c => c.layer === 3 && c.hasCode),
    staleDays: computeStaleDays(spec),
  }));
}
```

```typescript
// Duplicate detection — Coordinator checks before creating Proposal
function isDuplicateProposal(raw: RawProposal, active: Proposal[]): boolean {
  return active.some(p => p.proposalType === raw.proposalType
    && setOverlap(p.relatedRefs, raw.relatedRefs) > 0.5);
}
```

```typescript
// Idea debounce — Coordinator batches ideas into next PO cycle
let ideaDebounceTimer: NodeJS.Timeout | null = null;
function debounceIdeaProcessing(cfg: POConfig) {
  if (ideaDebounceTimer) clearTimeout(ideaDebounceTimer);
  ideaDebounceTimer = setTimeout(() => triggerPOCycle('idea_submitted'), cfg.poIdeaDebounce * 1000);
}
```

## Gotchas

- The PO session receives the SignalSnapshot as a JSON string in the prompt context. Large snapshots (many backlog items, many proposals) may approach token limits. Cap each section at a configurable maximum (default: 50 entries for backlog, 20 for proposals, 10 for ideas) and include a truncation marker if exceeded. Prioritize by staleness/age.
- The PO operates at L0-L2 only — the prompt template must not include code-level context, source file contents, or detailed failure analysis. The SignalSnapshot enforces this by design: it contains aggregate delivery outcomes (pass/fail rates), not error details. Verify that the Coordinator's snapshot assembly never includes Tech Lead-level data.
- Proposal history in the SignalSnapshot includes rejection reasons from the operator. The prompt instructs the model to avoid re-proposing recently rejected work unless new signals justify it. However, the model may still re-propose — the Coordinator's duplicate detection (by `relatedRefs` overlap) is the authoritative guard. The prompt instruction is advisory.
- The `missingSources` field in SignalSnapshot indicates which data sources were unavailable during assembly. The PO session must check this field — proposals based on incomplete data should note which sources were unavailable in their rationale. The prompt template includes instructions for handling partial snapshots.
- Idea-to-proposal linking uses the IdeaSubmission ID in `relatedRefs`. When the Coordinator creates a Proposal from a RawProposal with `proposalType: 'operator_idea_refinement'`, it must also mark the originating IdeaSubmission as processed. If the PO session generates multiple proposals from a single idea, only the first Proposal links to the IdeaSubmission — subsequent ones are standalone.
- Protocol round output schemas are strict — unknown fields are stripped by Zod's default behavior. If the PO session produces extra fields (model hallucination), they are silently dropped. Log a warning when `parse` strips fields, as it may indicate prompt drift.
- The PO never schedules its own execution. If the PO session output includes a `protocolTriggers` entry, it is advisory — the Coordinator validates against current system state before executing. A `backlog_grooming` trigger is ignored if grooming ran within the debounce window. Invalid triggers are logged and discarded.
- Proposal expiry is managed by the Coordinator (ARCH-AC-PRODUCT-OWNER), not by the PO session. The PO sees expired proposals in `proposalHistory` but does not transition proposal states. Do not add expiry logic to PO code paths.
- The `estimatedScope` on RawProposal is the PO's business-level estimate, not a technical effort assessment. The Tech Lead provides the technical effort estimate during Proposal Enrichment. These are complementary — the Coordinator presents both to the operator.
- PO containment: the AgentConfig for `product_owner` sessions must include `.specify/` and `packages/` in prohibited write patterns. The PO can read specs via the signal snapshot but must never write to the spec directory or source code. Verify this in the AgentConfig registration.
- Empty analysis cycles are expected. If the PO session produces zero proposals and zero protocol triggers, the Coordinator logs the empty cycle and takes no action. Do not treat an empty cycle as a failure.
- Backlog grooming output replaces the current prioritized backlog. The Coordinator must persist the full re-prioritized list, not merge it with the previous version. The PO's output is the new ground truth for business priority ordering.
- When the PO participates in Batch Planning, it receives the current backlog (not the full issue tracker). The Coordinator filters to items that are ready for work (labeled, spec chain complete, not blocked). The PO orders from this pre-filtered set.
- PO session failure during a protocol round: the ProtocolRound status is set to `failed`. For Enrichment, the proposal proceeds with the "unassessed" flag. For Batch Planning, the protocol escalates to the operator. For Backlog Grooming, the grooming is recorded as Tech Lead-only (inverse of the PO-only degraded path). For Status Sync and Retrospective, the round is skipped.
