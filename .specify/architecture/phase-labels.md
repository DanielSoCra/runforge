---
id: ARCH-AC-PHASE-LABELS
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-PIPELINE
---

# ARCH-AC-PHASE-LABELS — Phase Label Mirroring

## Overview

The Phase Label Mirror extends the Daemon Control Plane to reflect FSM phase transitions as `phase:*` labels on the work request source in real time. Label mirroring is pure observability: labels follow authoritative run state, never drive it. The Control Plane (already the sole writer of labels per ARCH-AC-CONTROL-PLANE) gains a Phase Label Mirror component that performs fire-and-forget label swaps on every FSM phase transition, and label cleanup on terminal transitions (complete, stuck).

## Data Model

**RunState** (extension of the model defined in ARCH-AC-CONTROL-PLANE) gains one field:

- `activePhaseLabel` — the `phase:*` label currently applied to the work request (nullable: absent before the first labeled phase transition). Persisted in RunState so that crash resumption can remove the correct label.

**PhaseLabelMap** is a static value object (not persisted) mapping FSM phase names to their label strings:

| FSM Phase    | Label               |
|-------------|---------------------|
| classify    | `phase:classify`    |
| decompose   | `phase:decompose`   |
| implement   | `phase:implement`   |
| review      | `phase:review`      |
| holdout     | `phase:holdout`     |
| integrate   | `phase:integrate`   |
| deploy      | `phase:deploy`      |
| test        | `phase:test`        |

Phases `detect` and `report` have no corresponding label — they are transient coordination steps with no operator-visible dwell time. Phase labels for `complete` and `stuck` outcomes are handled by the existing label mechanism in ARCH-AC-CONTROL-PLANE and are not duplicated here.

**LabelProvisioningRecord** is a startup-time in-memory record tracking whether the 8 `phase:*` labels have been confirmed to exist on each monitored repository. It contains: repository identifier and a provisioning-confirmed flag. If provisioning fails for a repository, the daemon logs a warning and continues — label writes against an unprovisioned repository will succeed when the source supports implicit provisioning, or fail softly per the fire-and-forget contract.

## API Contract

The Phase Label Mirror exposes no external API. It is an internal component of the Daemon Control Plane.

**Internal interface — Phase Label Mirror:**

- `applyPhaseLabel(workRequestIdentifier, newPhase, runState)` — Derives the new `phase:*` label from PhaseLabelMap. If the phase has no label entry, updates `runState.activePhaseLabel` to absent and returns without making a network call; unlabeled terminal coordination phases use `clearPhaseLabels` when a previous phase label must be removed. Otherwise, removes the previously-applied `phase:*` label from `runState.activePhaseLabel` (if any), applies the new label at the work request source, and updates `runState.activePhaseLabel` to the new label synchronously before the fire-and-forget network call. Errors are caught, logged with work request identifier and phase name, and not propagated to the FSM.

- `clearPhaseLabels(workRequestIdentifier, runState)` — Reads the label stored in `runState.activePhaseLabel` and removes that label from the work request source if one is present, then updates `runState.activePhaseLabel` to absent synchronously before the fire-and-forget network call. Used when entering unlabeled report/completion handling and on stuck transitions. Errors are caught, logged with work request identifier, and not propagated to the FSM.

- `provisionLabels(repositoryIdentifier)` — Ensures the 8 `phase:*` labels exist on the specified repository. Called once per repository on daemon startup. Fire-and-forget: provisioning failure logs a warning but does not block daemon startup or work claiming.

**Atomicity note:** The work request source does not guarantee atomic label swap. The Phase Label Mirror issues a remove-old call followed by an add-new call. A crash between the two leaves the issue without a phase label — this is acceptable because observability gaps are preferable to blocking label state. On crash resumption, RunState.activePhaseLabel carries the intended label; the Control Plane reapplies it during FSM re-entry.

## System Boundaries

- **Control Plane OWNS:** Phase Label Mirror component, RunState.activePhaseLabel, PhaseLabelMap, label provisioning state.
- **Control Plane WRITES:** `phase:*` labels on work requests via the existing label-write channel already used for `in-progress`, `stuck`, and `complete`.
- **Control Plane preserves:** The `in-progress` label applied during work detection remains present alongside `phase:*` labels throughout the run. The Phase Label Mirror never touches `in-progress`, `stuck`, or `complete` labels.
- **No new services, queues, or storage.** Label operations share the same work request source client already available to the Control Plane.
- **Dashboard READS:** `phase:*` labels via the work request source query interface for filtering and display. No new API is required — label queries use the existing work request source filter mechanism.

## Event Flows

**Daemon startup — label provisioning:**
1. For each configured repository, call `provisionLabels(repositoryIdentifier)` asynchronously.
2. Log success or warning per repository. Continue daemon startup regardless of outcome.

**FSM phase transition (after authoritative phase state is written):**
1. Determine the new phase name from the FSM.
2. Call `applyPhaseLabel(workRequestIdentifier, newPhase, runState)` — fire-and-forget.
3. On success: RunState.activePhaseLabel is updated to the new label (or null if the phase has no label entry).
4. On error: log the error with context; FSM continues to the next phase unaffected.

**Stuck transition (during stuck handling in ARCH-AC-CONTROL-PLANE):**
1. Call `clearPhaseLabels(workRequestIdentifier, runState)` — fire-and-forget.
2. Apply existing `stuck` label per the Control Plane's existing flow.

**Completion (during completion flow in ARCH-AC-CONTROL-PLANE):**
1. Call `clearPhaseLabels(workRequestIdentifier, runState)` — fire-and-forget.
2. Apply existing `complete` label per the Control Plane's existing flow.

**Crash resumption:**
1. Control Plane loads RunState from persistent storage. RunState.activePhaseLabel contains the last-applied label (may be stale if crash occurred between remove-old and add-new).
2. The FSM re-enters the saved phase. The Control Plane mirrors the saved phase against the loaded run state: labeled phases call `applyPhaseLabel`, and unlabeled report/completion handling calls `clearPhaseLabels`. This reapplies or removes the correct phase label for the resumed phase, correcting any stale state from before the crash.

**Label query by external tooling (e.g., Dashboard filter by phase):**
- Query the work request source for issues labeled `phase:implement` (or any phase label).
- No daemon involvement required — labels are visible directly on the work request source.

## Error Handling

**Label apply failure:** Caught and logged with structured context (issue number, phase name, error). FSM transition completes normally. The label may be missing from the issue until the next phase transition reapplies.

**Label clear failure:** Caught and logged. The stale `phase:*` label may persist on the issue after completion or stuck. This is an observability gap, not a correctness failure — the authoritative state is RunState.

**Label provisioning failure:** Logged as a warning per repository. Daemon continues. Individual label operations against an unprovisioned repository may fail per the fire-and-forget contract above.

**Crash between remove-old and add-new:** Issue briefly has no `phase:*` label. Corrected on crash resumption when the FSM re-enters the saved phase and calls `applyPhaseLabel`.

**Work request source unavailable:** All label operations fail softly per the fire-and-forget contract. The pipeline is not affected. When the source becomes available again, the next FSM phase transition will resync the label.
