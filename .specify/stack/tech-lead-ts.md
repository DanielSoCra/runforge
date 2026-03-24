---
id: STACK-AC-TECH-LEAD
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-TECH-LEAD
code_paths:
  - packages/daemon/src/coordination/tech-lead/
  - packages/daemon/src/coordination/tech-lead/schemas.ts
  - packages/daemon/src/coordination/tech-lead/signal-digest.ts
  - packages/daemon/src/coordination/tech-lead/proposal-store.ts
  - packages/daemon/src/coordination/tech-lead/proposal-lifecycle.ts
  - packages/daemon/src/coordination/tech-lead/enrichment.ts
  - packages/daemon/src/coordination/tech-lead/metrics.ts
  - packages/daemon/src/coordination/tech-lead/session-output-parser.ts
  - packages/daemon/src/coordination/tech-lead/retrospective.ts
  - prompts/tech-lead.md
  - prompts/tech-lead-enrichment.md
test_paths:
  - packages/daemon/src/coordination/tech-lead/**/*.test.ts
---

# STACK-AC-TECH-LEAD — Tech Lead Agent (TypeScript)

## Pattern

**Tech Lead as a spawned session with structured output.** The Tech Lead is not a long-running process. The Coordinator spawns it via Session Runtime on a configurable schedule (default: 2 hours) or on events (run failure, new findings, retrospective completion). Each session receives a read-only SignalDigest as context and returns structured output (zero or more TechnicalProposals, optional protocol trigger requests). The Coordinator parses the output and takes action. Same spawn pattern as other pooled agents in STACK-AC-COORDINATION — registered as agent type `tech_lead` with min 0, max 1.

**Data models as Zod schemas with inferred types.** TechnicalProposal, TechnicalEnrichment, SignalDigest, and ProtocolExchange are defined as Zod schemas. TypeScript types derived via `z.infer`. Runtime validation on read, type safety on write. Follows the project's Zod-first pattern (STACK-AC-CONVENTIONS, STACK-AC-COORDINATION).

**Proposal lifecycle as explicit transition table.** Same FSM pattern as STACK-AC-CONTROL-PLANE and STACK-AC-COORDINATION: a `Record<ProposalStatus, Record<ProposalEvent, { next, action }>>` with exhaustive matching. States: `generated`, `forwarded`, `rejected_by_po`, `pending_operator`, `approved`, `rejected_by_operator`, `expired`. No state machine library.

**Signal digest as deterministic pre-computation.** Before spawning the Tech Lead session, the Coordinator assembles a SignalDigest by querying existing services: Knowledge Service for review findings, Control Plane for run outcomes, traceability map for drift indicators, codebase scan for deferred work, test infrastructure for health, dependency audit for risks. The digest also includes active proposals and prior rejections for context. Assembly is a pure read operation — no side effects.

**File-based persistence for proposals and enrichments.** Proposals stored as individual JSON files in `state/coordination/tech-lead/proposals/{id}.json`. Enrichments stored in `state/coordination/tech-lead/enrichments/{id}.json`. Follows the project's file-based persistence pattern (STACK-AC-CONVENTIONS). Atomic writes prevent corruption. The single-process model eliminates concurrency concerns.

**Protocol orchestration via Coordinator.** The Tech Lead never communicates directly with the PO. All protocol exchanges are mediated by the Coordinator's ProtocolExecutor (STACK-AC-COORDINATION). The Coordinator spawns agent sessions in sequence, passes structured output between them, and records each step in a ProtocolExchange. Protocol chains (batch completion → retrospective → grooming → planning) are registered as ordered sequences in the ProtocolExecutor configuration.

## Key Decisions

**TechnicalProposal schema.** Single Zod schema covering all proposal types. The `proposalType` field discriminates behavior, not shape — all proposal types share the same fields. This avoids a discriminated union where the fields are identical.

```typescript
const ProposalTypeSchema = z.enum([
  'debt_reduction', 'quality_improvement',
  'architecture_concern', 'dependency_update',
  'failure_investigation',
]);
```

```typescript
// Key fields — full schema includes status, decisions, timestamps, priorRejectionId
const TechnicalProposalSchema = z.object({
  id: z.string().uuid(), proposalType: ProposalTypeSchema,
  evidence: z.array(z.object({ signal: z.string(), detail: z.string() })),
  effortEstimate: z.union([z.string(), z.literal('unassessed')]),
});
```

**ProposalStatus transition table.** Exhaustive mapping — every valid transition is explicit, every invalid transition is absent.

```typescript
// Same FSM pattern as STACK-AC-CONTROL-PLANE — exhaustive transition table
const PROPOSAL_TRANSITIONS = {
  generated: { po_forward: { next: 'forwarded' }, po_reject: { next: 'rejected_by_po' } },
  forwarded: { operator_view: { next: 'pending_operator' } },
  pending_operator: { operator_approve: { next: 'approved' }, operator_reject: { next: 'rejected_by_operator' } },
} // all non-terminal states also accept 'expire' → 'expired'; terminal states have no transitions
```

**TechnicalEnrichment schema.** Returned by the Tech Lead when enriching a PO business proposal. The `unassessed` flag on effort is a defined degraded path.

```typescript
const TechnicalEnrichmentSchema = z.object({
  id: z.string().uuid(), proposalId: z.string().uuid(),
  effortEstimate: z.union([z.string(), z.literal('unassessed')]),
  dependencies: z.array(z.string()), technicalRisks: z.array(z.string()),
  prerequisites: z.array(z.string()), createdAt: z.string().datetime(),
});
```

**ProtocolExchange schema.** Record of a single protocol execution between agents. Stored for audit and retrospective analysis. Managed by the Coordinator's ProtocolExecutor, never written by agent sessions directly.

```typescript
const ProtocolExchangeSchema = z.object({
  id: z.string().uuid(),
  protocolType: z.enum(['proposal_enrichment', 'batch_planning', 'backlog_grooming', 'escalation', 'status_sync', 'retrospective']),
  steps: z.array(z.object({ agentType: z.string(), output: z.unknown(), at: z.string().datetime() })),
  outcome: z.unknown().nullable(), startedAt: z.string().datetime(),
});
```

**SignalDigest assembly: Query existing services, no new stores.** Each signal section maps to an existing data source. Review findings come from the Knowledge Service's `matchRecords` with the traceability-derived artifact paths and `tech_lead` session type. Run outcomes come from the Control Plane's run state. Drift indicators are computed by diffing the traceability map against the filesystem. Deferred work markers are counted via a deterministic `grep`-like scan for `TODO`, `FIXME`, `HACK` patterns. Test health comes from run metadata. Dependency risks come from `npm audit --json` output.

```typescript
// Parallel query — matchRecords uses PolicyRegistry to filter eligible record types
async function assembleSignalDigest(trigger: CycleTrigger, deps: DigestDeps): Promise<SignalDigest> {
  const allCodePaths = deps.traceabilityMap.getAllCodePaths();
  const [findings, runs, drift] = await Promise.all([
    deps.knowledge.matchRecords(allCodePaths, 'tech_lead', deps.policies),
    deps.controlPlane.getRecentRuns(cfg.lookbackWindow), computeDriftIndicators(deps.traceabilityMap),
  ]);  // ... also scanDeferredWork, getTestHealth, runDependencyAudit, loadActiveProposals, loadPriorRejections
}
```

**Drift detection: Traceability map diff.** Read `.specify/traceability.yml` to get L3 spec `code_paths`. For each path, check if the file exists and, optionally, if key patterns from the L3 spec are present. Missing files or missing patterns are drift indicators. No AST parsing — presence checks and simple pattern matching are sufficient at this stage.

**Deferred work scan: `grep`-style marker count.** Scan configured paths for `TODO`, `FIXME`, `HACK` markers. Return per-directory counts. Uses Node's `readdir` + `readFile` with a streaming line scanner. No external tool dependency.

```typescript
async function scanDeferredWork(paths: string[], fs: FsLike): Promise<DeferredWorkEntry[]> {
  const markers = /\b(TODO|FIXME|HACK)\b/;
  // Walk paths, count markers per directory, return aggregated entries
}
```

**Dependency audit: `npm audit --json`.** Spawn `npm audit --json --omit=dev` as a child process, parse the JSON output. Extract vulnerability counts by severity. Timeout after 30 seconds — if it hangs, return an empty result with a missing-source marker. No library wrapper — `child_process.execFile` is sufficient.

**Session output parsing: Zod validated structured output.** The Tech Lead session returns structured JSON. The Coordinator parses it through a Zod schema (`TechLeadOutputSchema`) that expects an array of TechnicalProposals and an optional array of protocol trigger requests. Malformed output is logged and treated as "zero proposals generated."

```typescript
const TechLeadOutputSchema = z.object({
  proposals: z.array(TechnicalProposalSchema).default([]),
  protocolTriggers: z.array(z.enum([
    'escalation', 'batch_planning', 'backlog_grooming', 'retrospective',
  ])).default([]),
});
```

**TechnicalEnrichment: Effort + risks + dependencies.** When the Coordinator requests enrichment, it spawns a Tech Lead session with a PO proposal as context. The session returns a TechnicalEnrichment with structured fields. The `unassessed` flag on effort is a defined degraded path, not an error.

**Event debouncing: Timer-based batching.** Multiple events within a configurable window (default: 5 minutes) are batched into a single Tech Lead cycle. Uses a simple debounce: first event starts a timer, subsequent events reset it, timer expiry triggers the cycle. Standard `setTimeout`/`clearTimeout` pattern.

**Proposal expiry sweep: Alongside scheduled cycle.** Before each scheduled Tech Lead cycle, the Coordinator sweeps proposals with `expiresAt < now()`. Non-terminal proposals transition to `expired`. No separate cron — piggybacks on the existing schedule.

**Proposal deduplication: Type + affected areas overlap.** Before storing a new proposal, check active proposals with the same `proposalType`. If any have overlapping `affectedAreas` (set intersection > 50%), update the existing proposal's evidence array instead of creating a new one. Prevents proposal churn from repeated analysis cycles.

**Retrospective-to-knowledge flow: Pitfall distillation.** The Tech Lead's retrospective output includes structured pitfall records (artifact patterns, description, severity, root-cause tag). The Coordinator submits these to the Knowledge Service via `storeRecord` with `originType: 'retrospective-tech-lead'`, which enters them as `candidate` status (requiring operator approval before injection). Handled in `retrospective.ts`.

```typescript
// Retrospective output → Knowledge Service candidates
for (const pitfall of retrospectiveOutput.pitfalls) {
  await knowledge.storeRecord({ ...pitfall, recordType: 'technical_pitfall',
    originType: 'retrospective-tech-lead', lifecycleStatus: 'candidate' });
}
```

**Prospective risk check: Pre-batch-planning query.** Before the Batch Planning protocol, the Coordinator queries the Knowledge Service's `queryProspectiveRisks` endpoint with artifact locations of all candidate batch items. High-severity records are included in the Tech Lead's Batch Planning context so it can factor historical failures into effort estimates and risk assessments. This is a read-only query — no hit count increments.

```typescript
// Pre-planning risk check — read-only, no side effects
const batchPaths = candidateItems.flatMap(i => i.artifactPaths);
const risks = await knowledge.queryProspectiveRisks(batchPaths, activeRecords);
// risks are injected into Tech Lead's Batch Planning context
```

**Recurring finding threshold: Systemic proposal trigger.** When the Knowledge Service's periodic maintenance detects that a `rootCauseTag` appears on 3+ active records (configurable via `recurringFindingThreshold`), it generates a `SystemicProposal` (STACK-AC-KNOWLEDGE). The Coordinator routes SystemicProposals to the Tech Lead for refinement — the Tech Lead session receives the related records and proposes a targeted technical debt reduction. The threshold value is shared between the Knowledge Service config and the Coordinator config.

**Metrics computation: Periodic calculation from existing stores.** Metrics are computed by querying Knowledge Service records, Control Plane run data, and proposal history. Each metric is a simple aggregation (counts, ratios, timestamp deltas). Results stored as time-series entries in `state/coordination/tech-lead/metrics.json`. Advisory only — computation failure is logged and skipped.

**Config extension: Added to existing config schema.** New settings in `config.ts` (STACK-AC-CONVENTIONS): `techLeadInterval` (default: 7200 seconds), `techLeadProposalExpiry` (default: 7 days in ms), `recurringFindingThreshold` (default: 3), `driftScanPaths` (default: all L3 code_paths from traceability), `techLeadEventDebounce` (default: 300 seconds), `techLeadLookbackWindow` (default: 48 hours for run outcomes).

**Prompt template: Markdown file in `prompts/tech-lead.md`.** Template with `{{signal_digest}}` placeholder. Rendered via `String.replaceAll()` (STACK-AC-KNOWLEDGE pattern). The template instructs the model to output JSON matching `TechLeadOutputSchema`. Enrichment uses a separate template `prompts/tech-lead-enrichment.md` with `{{proposal}}` placeholder.

## Examples

```typescript
// Proposal lifecycle transition — type-safe, exhaustive
function transitionProposal(proposal: TechnicalProposal, event: ProposalEvent): TechnicalProposal {
  const transition = PROPOSAL_TRANSITIONS[proposal.status]?.[event];
  if (!transition) throw new Error(`Invalid transition: ${proposal.status} + ${event}`);
  return { ...proposal, status: transition.next };
}
```

```typescript
// Event debounce — batch multiple triggers into one cycle
let debounceTimer: NodeJS.Timeout | null = null;
function debounceTechLeadCycle(trigger: CycleTrigger, cfg: TechLeadConfig) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => triggerTechLeadCycle(trigger), cfg.techLeadEventDebounce * 1000);
}
```

```typescript
// Proposal dedup — update evidence if overlapping active proposal exists
function findDuplicate(newProposal: TechnicalProposal, active: TechnicalProposal[]): TechnicalProposal | undefined {
  return active.find(p => p.proposalType === newProposal.proposalType
    && setOverlap(p.affectedAreas, newProposal.affectedAreas) > 0.5);
}
```

## Gotchas

- The Tech Lead session receives the SignalDigest as a JSON string in the prompt context. Large digests (many findings, many runs) may approach token limits. Cap each signal section at a configurable maximum (default: 50 entries) and include a truncation marker if exceeded. Prioritize by severity/recency.
- Drift detection reads `.specify/traceability.yml` on every cycle. Cache the parsed traceability map and invalidate on file change (use `fs.stat` mtime check). The traceability file is small, but parsing YAML on every 2-hour cycle is unnecessary.
- `npm audit --json` may produce stderr warnings that are not part of the JSON output. Capture stdout and stderr separately. Parse stdout only. Non-zero exit codes from `npm audit` indicate vulnerabilities found (expected behavior), not command failure — only treat signal (SIGTERM, timeout) as a failure.
- Proposal files use `{uuid}.json` naming. On expiry sweep, scan the directory and parse each file's `expiresAt` field. For large proposal volumes, this is O(n) per sweep — acceptable given the 2-hour cycle and expected proposal volume (< 100 active at any time).
- The `unassessed` effort flag is a string literal, not a missing field. Always check for `effortEstimate === 'unassessed'` rather than `!effortEstimate`. The Zod schema enforces this with `z.union([z.string(), z.literal('unassessed')])`.
- Protocol trigger requests from the Tech Lead session are advisory. The Coordinator validates them against the current system state before executing — e.g., a retrospective trigger is ignored if no batch has completed. Invalid triggers are logged and discarded.
- The SignalDigest's `deferredWork` scan walks the filesystem. Exclude `node_modules/`, `dist/`, and other build artifacts via a configurable exclude list. Use the same exclude patterns as the project's existing file operations (STACK-AC-CONVENTIONS).
- Metrics are time-series data points stored in a single JSON file. The file grows unboundedly. Apply a retention window (default: 90 days) during the metrics computation step — discard entries older than the window before writing.
- When re-proposing after PO rejection, the new proposal's `priorRejectionId` links to the rejected proposal. The PO session receives this history as context — ensure the prior proposal and its rejection reason are included in the PO's evaluation context, not just the new proposal.
- Tech Lead containment: the AgentConfig for `tech_lead` sessions must include `.specify/` in prohibited path patterns. This is a structural guarantee — the Tech Lead can read specs via the signal digest but cannot write to the spec directory. Verify this in the AgentConfig registration, not at runtime.
- Partial digest failure: if one signal source is unavailable (e.g., `npm audit` times out), assemble the digest with available signals and include a `missingSources: string[]` field in the SignalDigest. The Tech Lead session must check this field — analysis based on incomplete data should note which sources were unavailable.
- Protocol exchange timeout: if an agent session within a protocol exceeds its timeout, the ProtocolExecutor records a partial result in the ProtocolExchange and allows the protocol to complete with whatever output was produced. The Coordinator may fall back to a degraded path (e.g., PO grooms backlog solo if Tech Lead times out during grooming).
- PO unavailable for proposal evaluation: TechnicalProposals remain in `generated` status. If proposals approach their `expiresAt` without PO evaluation, flag them on the dashboard under "Needs Attention" so the operator can intervene.
- Protocol chain halting: if any protocol in a composition chain fails (agent timeout, session failure), the chain halts at the failed step. The partial result is recorded in the ProtocolExchange, remaining steps are logged as skipped, and the operator is notified. Do not silently proceed with the next chain step.
- Tech Lead session failure: the WorkerClaim is set to `failed` (same as any pooled agent failure in STACK-AC-COORDINATION). No proposals are generated from a failed session. The Coordinator retries on the next scheduled cycle — no immediate retry.
