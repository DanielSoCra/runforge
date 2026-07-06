---
id: STACK-AC-BATCH-CLASSIFIER
type: stack-specific
domain: runforge
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-BATCH-CLASSIFIER
code_paths:
  - packages/daemon/src/control-plane/batch-classifier.ts
  - packages/daemon/src/control-plane/batch-classifier-schema.ts
  - packages/daemon/src/config.ts
  - packages/daemon/src/control-plane/daemon.ts
  - packages/daemon/src/control-plane/phases.ts
  - packages/daemon/src/session-runtime/runtime.ts
  - packages/daemon/src/types.ts
test_paths:
  - packages/daemon/src/config.test.ts
  - packages/daemon/src/control-plane/batch-classifier.test.ts
  - packages/daemon/src/control-plane/batch-classifier-schema.test.ts
  - packages/daemon/src/control-plane/daemon.test.ts
  - packages/daemon/src/control-plane/phases.test.ts
  - packages/daemon/src/session-runtime/runtime.test.ts
---

# STACK-AC-BATCH-CLASSIFIER — Batch Work Classifier (TypeScript)

## Pattern

**Two-block prompt assembly with stable-prefix-first ordering.** The classifier prompt is assembled as two concatenated blocks: a stable governance prefix string built from `BatchClassifierConfig` (criteria, thresholds, spec guidance — content the provider can cache between cycles) followed by a variable issue block built from the per-cycle `ClassificationRequest[]` (summaries, spec refs, scope descriptions). The prefix string is reused verbatim across calls when its fingerprint has not changed, enabling provider-side prompt caching. Ordering is a hard structural rule: the prefix MUST precede the variable block on every call.

**Zod schema for batch output validation.** `batch-classifier-schema.ts` extends the existing `ClassificationSchema` with an `issueNumber` field. The session is invoked with a JSON Schema derived from an array of those items via `z.toJSONSchema(..., { target: 'draft-07' })`. Per-item validation runs after the session returns; invalid items trigger fallback for those specific issues.

```typescript
const prefix = renderGovernancePrefix(config);
const variable = renderIssueBlock(requests);
const prompt = `${prefix}\n\n${variable}`;  // never variable then prefix
```

## Key Decisions

**Result validation per request, not per batch.** `BatchClassificationResult` is built by validating each `ClassificationResult` individually: issue ID match, schema completeness, complexity ∈ {simple, standard, complex}. Failures on one entry do NOT discard the batch — invalid entries trigger fallback for those specific issues. This keeps the batch optimization usable even when the model produces partial results.

```typescript
const valid = results.filter(r => requests.find(q => q.issueId === r.issueId)
  && ['simple', 'standard', 'complex'].includes(r.complexity));
const missing = requests.filter(q => !valid.find(v => v.issueId === q.issueId));
```

**Proportional cost allocation in batch mode; exact cost in fallback mode.** When the batch call returns results for M requests, each request is allocated `sessionCost / M`. Fallback per-issue calls record their actual session cost on the result. This matches ARCH-AC-BATCH-CLASSIFIER §step 8: cost allocation is observable from the result; the daemon never aggregates independently.

```typescript
const perIssue = sessionCost / requests.length;
valid.forEach(r => { r.allocatedCost = perIssue; });
```

**Fingerprint = SHA-256 of prefix string.** The governance fingerprint is the SHA-256 of the rendered prefix string itself, computed at assembly time. The provider's cache invalidates automatically when the prefix content changes (its hash differs); the daemon does not need to call any cache-busting API. Storing the fingerprint on `BatchClassifierConfig` is for daemon-side observability only — for example, logging when a fingerprint flip occurs across cycles.

```typescript
const fingerprint = createHash('sha256').update(prefix, 'utf8').digest('hex');
```

**Single classifier code path covers batch-of-one.** A `ClassificationBatch` containing one `ClassificationRequest` is processed via the same `classifyBatch()` function — no separate single-issue entry point exists. Callers that previously called `classify()` for one issue now call `classifyBatch([request], config)` and receive a `BatchClassificationResult` with one entry. This preserves single-issue cost accuracy (proportional allocation with N=1 equals exact cost) and eliminates a code-duplication risk per ARCH-AC-BATCH-CLASSIFIER §"Single-issue detection".

## Gotchas

- The classify phase handler short-circuits when a pre-classification result is attached to the work request. `classifyBatch()` must complete before work items are passed to `processWorkRequest()`.
- Daily budget or rate-limit safety signals from the batch session must not initiate individual fallback sessions.
- Issue bodies are external content. Use `<work-request>` delimiters and escaped user issue content so one issue cannot pollute another issue's classification context.

## Concerns This Spec Does Not Cover

- Daemon Control Plane's handling of `BatchClassificationResult` (FSM initialization with allocated cost, classify-phase failures) — see STACK-AC-CONTROL-PLANE.
- Session Runtime's classifier session lifecycle, budget enforcement, containment — see STACK-AC-SESSION-RUNTIME.
- Prompt template content for the classifier — see `prompts/classifier.md` (governed by STACK-AC-AGENT-DISCIPLINE-PROMPTS).
