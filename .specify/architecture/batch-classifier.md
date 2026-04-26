---
id: ARCH-AC-BATCH-CLASSIFIER
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-PIPELINE
---

# ARCH-AC-BATCH-CLASSIFIER — Batch Work Classifier

## Overview

The Batch Work Classifier groups multiple feature work requests detected in a single poll cycle into a single intelligent session call for complexity classification. A stable governance prefix (classification criteria, spec references, configured thresholds) is assembled once per batch and placed at the top of the call context, followed by the variable per-issue data — a structure that maximizes provider-side context caching and eliminates per-issue re-transmission of governance content. The output per work request is structurally identical to single-issue classification; batching is a call-efficiency optimization that is invisible to downstream consumers.

## Data Model

A **ClassificationRequest** represents one work request pending classification. It records the issue identifier, the work request summary, the list of referenced spec identifiers (each entry carries a spec ID, layer, and location string), and an estimated scope description. This is the same information currently sent for individual classification — batching aggregates multiple requests rather than changing their content.

A **ClassificationBatch** is the unit of work sent to the classifier session. It groups an ordered list of ClassificationRequests (one to the configured maximum batch size), and records the batch sequence identifier used for tracing.

A **ClassificationResult** records the outcome for a single work request. It carries the issue identifier (matching the corresponding request), the assessed complexity level (simple, standard, or complex), a reasoning summary, the estimated unit count, and the estimated artifact count. This schema is identical to the output produced by single-issue classification — no consumer of classification results needs to know whether batching was used.

A **BatchClassificationResult** is the return value from one batch call. It carries an ordered list of ClassificationResults (one per request, preserving input order), the total session cost for the call, the batch sequence identifier, and a result status (complete, or partial — partial signals that one or more results are missing or invalid and fallback is required for those issues).

A **BatchClassifierConfig** holds the configuration governing batch behavior. It records the maximum batch size (default 10), a fallback-on-failure flag (default true), and a governance context fingerprint used to detect when the stable prefix content has changed between poll cycles.

## API Contract

The Batch Work Classifier is an internal component called synchronously by the Daemon Control Plane. It does not expose a network interface.

**classifyBatch** — invoked by the Daemon Control Plane after claiming one or more feature work requests and before entering the pipeline FSM.

Input: a ClassificationBatch and the active BatchClassifierConfig.

Output: a BatchClassificationResult. If the batch call succeeds and all results are valid, the status is complete. If the batch call fails or produces one or more invalid results, the status is partial and the Batch Work Classifier executes fallback classification for the affected issues before returning — the caller always receives a single unified result set.

The Batch Work Classifier calls the Session Runtime's spawn-session operation with:
- Session type: classifier
- Context: the assembled batch context, with the stable governance prefix block (classification criteria, thresholds, spec guidance) preceding the variable issue-data block (ordered issue summaries, spec references, scope descriptions). The stable prefix must precede the variable block in all cases — this ordering is a structural requirement for provider-side caching to be effective.
- Workspace: none required (classification is stateless).

The Session Runtime returns a session result containing the structured output (a JSON array of ClassificationResult objects), the session cost, and an exit status.

## System Boundaries

- Batch Work Classifier OWNS: batch formation logic, stable-prefix/variable-suffix prompt assembly, result parsing and validation, per-issue cost allocation, fallback orchestration.
- Batch Work Classifier IS CALLED BY: Daemon Control Plane (during work detection, after issues are claimed and before FSM initialization).
- Batch Work Classifier CALLS: Session Runtime (to spawn a single classifier session for the full batch; to spawn individual classifier sessions during fallback).
- Daemon Control Plane OWNS: work request claiming, applying classification results to FSM initialization, per-run budget management, and handling classification-failed outcomes as phase failures with the standard retry and stuck logic.
- Session Runtime OWNS: session lifecycle, containment enforcement, per-session and daily cost totals, rate limit state. The Batch Work Classifier receives cost figures from the Session Runtime; it does not track totals independently.
- The Daemon Control Plane is the sole system that writes labels and comments on work requests. The Batch Work Classifier returns classification results only; it does not interact with the work request source.

## Event Flows

**Batch classification flow:**
1. Daemon Control Plane completes a poll cycle and has claimed one or more feature work requests awaiting classification.
2. Daemon Control Plane passes up to the maximum batch size (from BatchClassifierConfig) of pending ClassificationRequests to the Batch Work Classifier. Requests exceeding the batch size limit remain in the claimed queue and are classified in the next poll cycle.
3. Batch Work Classifier assembles the ClassificationBatch. It builds the context in two blocks: the stable governance prefix (classification criteria, configurable complexity thresholds, spec guidance) followed by the variable issue block (ordered list of issue identifiers, summaries, spec references, scope descriptions). The prefix precedes the variable block without exception.
4. Batch Work Classifier checks the governance context fingerprint. If the prefix content has changed since the last call, the fingerprint is updated — the provider's caching layer invalidates automatically when prefix content changes; no explicit cache-busting step is required.
5. Batch Work Classifier calls Session Runtime to spawn a single classifier session with the assembled context.
6. Session Runtime enforces budget and rate limit checks, applies containment constraints, and returns the BatchClassificationResult along with the session cost.
7. Batch Work Classifier validates each ClassificationResult: confirms the issue identifier matches the request, confirms the schema is complete, and confirms the complexity level is one of the three valid values.
8. For each valid result: Batch Work Classifier allocates a proportional share of the session cost (total session cost divided by the number of issues in the batch) and attaches it to the ClassificationResult.
9. Batch Work Classifier returns the complete BatchClassificationResult to the Daemon Control Plane.
10. Daemon Control Plane initializes each issue's FSM with its ClassificationResult and allocated cost, then begins pipeline execution per the standard control plane flow (defined in ARCH-AC-CONTROL-PLANE).

**Fallback classification flow:**
1. Triggered when: the batch session exits with a non-success status, or the BatchClassificationResult is partial (one or more ClassificationResults are missing or invalid).
2. Batch Work Classifier identifies the affected issues — those without a valid ClassificationResult.
3. For each affected issue, Batch Work Classifier calls Session Runtime to spawn an individual classifier session using the single-issue classification protocol. Each call is independent.
4. Each individual result is attached to the BatchClassificationResult with its actual session cost (not a proportional allocation — the cost is exact for a single-issue call).
5. If an individual fallback call also fails, the affected issue is returned with a classification-failed status in the BatchClassificationResult. The Daemon Control Plane treats this as a classify phase failure and applies the standard retry and stuck logic.
6. Once all fallback calls are complete, the Batch Work Classifier returns the unified BatchClassificationResult to the Daemon Control Plane. The caller receives one result set regardless of whether the batch path, the fallback path, or a mix of both was used.

**Single-issue detection (batch of one):**
The batch flow is followed without modification. A ClassificationBatch containing one ClassificationRequest is valid and produces a BatchClassificationResult containing one ClassificationResult. No separate code path exists for single-issue detection.

## Error Handling

**Batch session timeout:** Session Runtime returns a timeout status. Batch Work Classifier initiates the fallback flow for every issue in the batch. Timeout does not consume a retry attempt at the classify phase level — the Daemon Control Plane's retry counter applies to classify phase failures returned by the Batch Work Classifier, not to individual session outcomes internal to the batch.

**Batch session budget-exceeded (daily):** Session Runtime returns a budget-exceeded signal and notifies the Daemon Control Plane directly to pause. Batch Work Classifier does not initiate fallback — the pause takes effect and the issues remain in the claimed queue until the budget resets or the Operator intervenes.

**Batch session budget-exceeded (per-session cap):** Session Runtime returns a budget-exceeded status for the session. Batch Work Classifier initiates the fallback flow, spawning individual sessions for each issue. Per-session budget caps are independent of the daily budget; individual fallback sessions each have their own cap.

**Partial output (missing or malformed results):** Batch Work Classifier validates every result. For each issue without a valid result, it initiates individual fallback classification. Issues with valid results are not re-classified.

**Invalid complexity level:** If a ClassificationResult contains an unrecognized complexity level, Batch Work Classifier treats it as missing and initiates individual fallback classification for that issue.

**Fallback disabled (fallback-on-failure = false):** All affected issues are returned with classification-failed status. The Daemon Control Plane applies standard retry and stuck logic. This mode is intended for environments where individual session spawning is not available (e.g., budget exhausted at the daily level).

**Governance prefix fingerprint mismatch across a single batch:** Not possible within a single call — the prefix is assembled once per batch before the session is spawned. Fingerprint changes between poll cycles are handled by natural cache invalidation.
