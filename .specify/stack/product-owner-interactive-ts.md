---
id: STACK-AC-PRODUCT-OWNER-INTERACTIVE
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-PRODUCT-OWNER
code_paths:
  - packages/daemon/src/coordination/product-owner/interactive-session-context.ts
  - packages/daemon/src/coordination/product-owner/shared-po-state.ts
  - packages/daemon/src/coordination/product-owner/interactive-schemas.ts
  - prompts/product-owner-interactive.md
test_paths:
  - packages/daemon/src/coordination/product-owner/interactive-session-context.test.ts
  - packages/daemon/src/coordination/product-owner/shared-po-state.test.ts
---

# STACK-AC-PRODUCT-OWNER-INTERACTIVE — Interactive PO Sessions (TypeScript)

## Pattern

**Interactive session as an agentic multi-turn Session Runtime spawn.** The operator invokes an interactive PO session via a CLI command or Dashboard action. The system reads SharedPOState from disk, assembles an interactive context, and spawns a PO session through Session Runtime in agentic (multi-turn conversational) mode with the interactive prompt overlay. Same agent identity and tools as autonomous mode — only the prompt template and execution mode differ (per L0-AC-VISION and ARCH-AC-PRODUCT-OWNER).

**SharedPOState as a versioned JSON file with optimistic concurrency.** SharedPOState is persisted as a single JSON file at `state/coordination/product-owner/shared-po-state.json`. Every write includes the expected `version` number. If the on-disk version differs from the expected version, the write is rejected (version conflict). The writer must re-read, merge, and retry. This follows the project's file-based persistence pattern (STACK-AC-CONVENTIONS) while satisfying the L2 concurrency requirement.

**Additive-only writes for safe concurrency.** Autonomous cycle writes add new NeedsDiscussionItems and AutonomousDecisionRecords. Interactive session writes mark items as `decided` or `reviewed`. These operations never conflict on the same field — a merge on conflict is always safe. Maximum 3 retries on conflict before reporting failure to the operator.

**InteractiveSessionRecords as individual JSON files.** Each completed session is persisted as `state/coordination/product-owner/sessions/{id}.json`. Written once at session end. The PO reads recent sessions on startup for continuity awareness. Follows the same one-file-per-entity pattern as WorkerClaims in STACK-AC-COORDINATION.

**Prompt template with interactive overlay.** `prompts/product-owner-interactive.md` is a dedicated template with `{{shared_po_state}}`, `{{active_proposals}}`, and `{{backlog_summary}}` placeholders. The template instructs the model to proactively surface items, confirm decisions before executing, and generate a session summary on close. Rendered via `String.replaceAll()` (STACK-AC-KNOWLEDGE pattern).

**CLI entry point via MCP tool on the terminal server.** The interactive session is exposed as a `start_po_session` MCP tool on the Coordination Service's terminal server (STACK-AC-COORDINATION). When invoked, it reads SharedPOState, assembles the context, spawns the session, and streams the conversation. The terminal server already runs as an MCP server over stdio — the interactive session tool extends it.

## Key Decisions

**SharedPOState schema.** Single Zod schema with embedded NeedsDiscussionItem and AutonomousDecisionRecord arrays. The `version` field is an integer incremented on every successful write.

```typescript
const NeedsDiscussionItemSchema = z.object({
  id: z.string(), sourceType: z.enum(['finding', 'proposal', 'escalation', 'general']),
  sourceRef: z.string(), contextSummary: z.string(),
  status: z.enum(['pending', 'decided', 'deferred']),
  operatorDecision: z.string().nullable(), decisionTimestamp: z.string().datetime().nullable(),
  poCycleId: z.string(), createdAt: z.string().datetime(),
});
```

```typescript
const AutonomousDecisionRecordSchema = z.object({
  id: z.string(),
  decisionType: z.enum(['finding_approved', 'finding_rejected', 'proposal_generated',
    'proposal_forwarded', 'proposal_rejected', 'priority_changed']),
  description: z.string(), affectedEntityRef: z.string(),
  poCycleId: z.string(), reviewed: z.boolean(), createdAt: z.string().datetime(),
});
```

```typescript
const SharedPOStateSchema = z.object({
  needsDiscussion: z.array(NeedsDiscussionItemSchema).default([]),
  autonomousDecisions: z.array(AutonomousDecisionRecordSchema).default([]),
  triageQueue: z.array(z.object({ findingRef: z.string(), summary: z.string() })).default([]),
  version: z.number().int().min(0),
  lastUpdated: z.string().datetime(),
});
```

**InteractiveSessionRecord schema.** Written once at session end. Captures decisions made, items reviewed, and PO-generated summary.

```typescript
const SessionDecisionEntrySchema = z.object({
  itemId: z.string(), decision: z.string(), timestamp: z.string().datetime(),
});
```

```typescript
const InteractiveSessionRecordSchema = z.object({
  id: z.string(), startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(), endReason: z.enum(['explicit_close', 'timeout', 'error']),
  sessionRuntimeId: z.string(), decisions: z.array(SessionDecisionEntrySchema).default([]),
  autonomousDecisionsReviewed: z.number().int(), needsDiscussionResolved: z.number().int(),
  summary: z.string(),
});
```

**Optimistic concurrency: read-check-write with retry.** The `writeSharedPOState` function accepts the full state object and the expected version. It reads the current file, compares versions, writes atomically (temp-then-rename per STACK-AC-CONVENTIONS) if versions match, or returns a version conflict error.

```typescript
async function writeSharedPOState(
  state: SharedPOState, expectedVersion: number,
): Promise<Result<void, 'version_conflict' | 'io_error'>> {
  const current = await readSharedPOState();
  if (current.version !== expectedVersion) return { ok: false, error: 'version_conflict' };
  await writeJsonSafe(SHARED_PO_STATE_PATH, { ...state, version: expectedVersion + 1 });
  return { ok: true, value: undefined };
}
```

**Interactive context assembly.** The `assembleInteractiveContext` function reads SharedPOState, active proposals from the PO proposal store, and a backlog summary from the Coordinator's dispatch queue. Returns a structured context object that the prompt template consumes.

```typescript
async function assembleInteractiveContext(): Promise<InteractiveSessionContext> {
  const state = await readSharedPOState();
  const proposals = await readActiveProposals();
  const backlog = await readBacklogSummary();
  return { sharedState: state, activeProposals: proposals, backlogSummary: backlog };
}
```

**Session spawn: agentic mode via Session Runtime.** The interactive session uses Session Runtime's spawn with multi-turn conversational mode. The session receives the assembled context serialized into the prompt. Inactivity timeout is configurable (default: 30 minutes). The session has the same tools as autonomous PO sessions (label changes, issue updates) but NOT spec-write tools (L0 boundary enforced by containment).

**Daemon deferral check.** Before the Coordinator spawns an autonomous PO cycle, it checks for active interactive sessions by scanning for InteractiveSessionRecords with `endedAt: null`. If an active session exists, the autonomous cycle is deferred. This prevents confusing overlapping decisions on the same items. Protocol rounds (where the PO responds to a Tech Lead protocol) are NOT deferred — only standalone analysis cycles are gated.

```typescript
function hasActiveInteractiveSession(): boolean {
  const sessions = readSessionRecords();
  return sessions.some(s => s.endedAt === null);
}
```

**Orphaned session detection.** On daemon startup (or periodic GC), scan for InteractiveSessionRecords with `endedAt: null`. Check if the Session Runtime process is still alive (PID check via the session runtime ID). If not alive, mark the record with `endReason: 'error'` and set `endedAt` to the current time. This handles interactive session crashes.

**Config extension.** New settings in `config.ts` (STACK-AC-CONVENTIONS): `poInteractiveTimeout` (default: 1800 seconds — 30 minutes of inactivity), `poSharedStateRetentionDays` (default: 7 — how long to keep autonomous decisions), `poMaxWriteRetries` (default: 3 — optimistic concurrency retry limit).

## Examples

```typescript
// Two-path decision execution: external action + shared state update
async function executeDecision(itemId: string, decision: string, state: SharedPOState) {
  await applyExternalAction(itemId, decision); // path 1: immediate (labels, issues)
  const updated = markItemDecided(state, itemId, decision);
  return writeWithRetry(updated, state.version); // path 2: persisted state
}
```

```typescript
// Surfacing logic — groups items by priority for the operator
function surfaceItems(state: SharedPOState): SurfacingOrder {
  return {
    needsDiscussion: state.needsDiscussion.filter(i => i.status === 'pending'),
    unreviewedDecisions: state.autonomousDecisions.filter(d => !d.reviewed),
    triageQueue: state.triageQueue,
  };
}
```

```typescript
// Retry on version conflict — re-read, merge additive decisions, retry write
async function writeWithRetry(state: SharedPOState, version: number) {
  const result = await writeSharedPOState(state, version);
  if (result.ok) return result;
  const fresh = await readSharedPOState();
  return writeSharedPOState(mergeInteractiveDecisions(fresh, state), fresh.version);
}
```

## Gotchas

- SharedPOState file access is not locked at the filesystem level. The optimistic concurrency check (version comparison) runs in user space. On the same machine with two Node processes (daemon + interactive CLI), the read-compare-write is safe because each step is fast and conflicts are resolved by retry. Do not introduce file locking — it adds complexity without benefit given the low write frequency.
- Interactive sessions share the same agent definition as autonomous sessions (same `product_owner` type in the agent pool). The containment rules are identical — the PO cannot write specs or source files in either mode. The only difference is the prompt template and execution mode (multi-turn vs single-shot).
- The `assembleInteractiveContext` reads SharedPOState once at session start. The context is a point-in-time snapshot — it does not live-update during the session. If the daemon's autonomous cycle adds new items to SharedPOState during the session (which is deferred, but possible if the check races), the interactive session will not see them until a re-read.
- Session timeout (default 30 minutes) is inactivity-based, not wall-clock. The timer resets on each operator message. Session Runtime tracks this via its existing timeout mechanism (STACK-AC-SESSION-RUNTIME). No custom timer needed in the interactive session code.
- Decisions the operator makes during an interactive session take effect in two places: externally (labels, issues — immediate) and in SharedPOState (persisted). If the external action succeeds but the state write fails (after retries), the external action is orphaned — it took effect but SharedPOState does not reflect it. The PO informs the operator; the next autonomous cycle may detect the inconsistency.
- InteractiveSessionRecord is written at session end, not during. If the session crashes, no record is written (`endedAt` stays null). The orphaned session detector handles this on the next daemon startup or GC cycle.
- The `mergeInteractiveDecisions` function resolves version conflicts by re-applying the operator's interactive decisions (mark-decided, mark-reviewed) onto the freshly-read state. This is safe because interactive writes are additive (setting statuses from pending→decided, reviewed→true) and do not conflict with autonomous writes (which append new items). Do not attempt to merge autonomous cycle additions — just re-read and re-apply.
- The `start_po_session` MCP tool on the terminal server spawns the interactive session as a long-lived process. The MCP tool call does not block — it returns a session handle. The operator's terminal connects to the session stream. If the terminal disconnects, the session continues until the inactivity timeout fires.
- The daily cap for PO finding approvals (FUNC-AC-PRODUCT-OWNER) applies only to autonomous cycles. Operator decisions during interactive sessions are not capped — the operator has full authority to approve any number of findings.
