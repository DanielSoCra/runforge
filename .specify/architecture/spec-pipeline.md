---
id: ARCH-AC-SPEC-PIPELINE
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-PIPELINE
---

# ARCH-AC-SPEC-PIPELINE — Spec-Driven Pipeline Variant

## Overview

The Spec-Driven Pipeline Variant extends the Daemon Control Plane with a pipeline variant that drives features from approved specifications through autonomous design, generation, implementation, and delivery. It migrates the Phase 1 shell-script orchestration into the native control plane FSM, replacing label-based shell polling with typed FSM phases, replacing skill invocations with registered session types, and replacing bash exponential backoff with the control plane's rate limiting.

This variant introduces one new architectural concept: **gated phases** — FSM phases that produce a deliverable, request external approval, park the run, and resume when the gate condition is met. Gated phases enable human approval checkpoints within an otherwise autonomous pipeline.

This architecture replaces the Phase 1 shell-script orchestration. Phase 1 skills become registered session types (AgentDefinitions), label checks become gate phase evaluations, and bash backoff becomes the existing rate limiter. The migration is a cutover — once the native variant is registered, the shell script is retired. Work requests in progress at cutover time are completed by whichever system claimed them (the instance lock prevents overlap).

## Data Model

**PhaseType** classifies how the FSM executes a phase. Three types exist:

- **Session** — The control plane spawns a session via Session Runtime, waits for completion, and transitions based on the result. Used for autonomous work (L2 design, L3 generation, compliance checking, reporting).
- **Gate** — The control plane checks an external condition (a label or approval state on the work request). If the condition is met, the FSM transitions forward. If feedback is present, the FSM transitions backward to repeat the preceding session phase. If neither, the run is parked — it remains in RunState but is not actively executing. Parked runs consume no sessions or budget. The poll loop re-evaluates parked runs on each cycle.
- **Delegated** — The control plane delegates execution to another service (Implementation Coordinator for decompose/implement, Validation Service for review/holdout). Used for phases that require multi-session orchestration or specialized execution models.

**SpecPipelineDefinition** is the pipeline variant registered in the control plane's variant registry. It contains:

- Variant name: `spec-driven`
- Phase sequence: detect, l2-design, l2-gate, l3-generate, l3-compliance, implement, review, holdout, integrate, report
- Per-phase configuration:
  - Phase type (session, gate, or delegated)
  - Owning service (Control Plane, Session Runtime, Implementation Coordinator, or Validation Service)
  - Transition rules (success target, failure target, feedback target for gated phases)
  - Retryable flag and max retry count
  - For session phases: the session type name (references an AgentDefinition in Session Runtime)
  - For gate phases: the approval condition and feedback condition
  - For delegated phases: the target service and operation name

**SpecWorkRequest** extends the base WorkRequest with spec-driven fields:

- Spec chain: an ordered list of spec layer references (L1 spec identifier and location, L2 spec identifier and location once generated, L3 spec identifier and location once generated). The chain grows as the pipeline progresses — L2 and L3 entries are appended after their respective generation phases.
- Current spec layer: which layer the pipeline is currently working on (l2, l3, or implementation).
- Gate history: an array of gate events (gate phase name, timestamp, outcome: approved or feedback, feedback summary if applicable). Used for crash resumption and reporting.

**ParkState** extends RunState for parked runs. It adds:

- Parked-at timestamp
- Gate phase name
- Deliverable reference (the artifact produced before parking — a spec file path, a pull request identifier, or both)
- Expected approval condition (what label or state change unparks the run)
- Expected feedback condition (what label or state change triggers a feedback loop)

## API Contract

The Spec-Driven Pipeline Variant does not expose its own API. It is registered as a pipeline variant in the Daemon Control Plane and executes through the existing control plane FSM. The control plane's existing operator commands (status, pause, resume, retry) apply to spec-driven runs identically to other variants.

**Variant registration** — On daemon startup, the spec-driven variant is loaded into the pipeline variant registry alongside the existing feature, feature-simple, and bug variants. Selection criteria: work requests with spec-chain references and a spec-driven indicator are routed to this variant.

**Phase execution contract** — Each phase type has a defined execution contract:

- Session phases call Session Runtime's spawn operation with the phase's session type and assembled context. The context includes: the current spec chain (all layers generated so far), the work request body, and any feedback from previous gate iterations.
- Gate phases read the work request's current label state. Three outcomes: approved (transition forward), feedback (transition to the preceding session phase with feedback context), or unchanged (remain parked).
- Delegated phases call the target service's operation (e.g., Implementation Coordinator's decompose and implement operations, Validation Service's review and holdout operations) with the full spec chain as context.

## System Boundaries

- Spec-Driven Pipeline Variant OWNS: the spec-driven phase sequence definition, gate evaluation logic, spec chain assembly, park state management.
- Spec-Driven Pipeline Variant IS PART OF: Daemon Control Plane (it is a pipeline variant, not a separate service).
- Spec-Driven Pipeline Variant CALLS: Session Runtime (for l2-design, l3-generate, l3-compliance, and report phases), Implementation Coordinator (for implement phase), Validation Service (for review and holdout phases).
- Daemon Control Plane WRITES: work request labels on every phase transition (the label reflects the current phase, enabling external visibility). Label names map directly to phase names. The control plane is the sole label writer — sessions never write labels.
- Spec-Driven Pipeline Variant READS: work request labels during gate phases only (to detect approval or feedback).

## Event Flows

**Work detection and variant selection:**
1. The daemon poll loop detects a work request labeled for the spec-driven pipeline.
2. The control plane parses the request body, extracts the spec chain (initially containing only the L1 reference), and creates a RunState.
3. The variant selector routes the request to the `spec-driven` pipeline variant based on the presence of spec-chain references and the spec-driven indicator.
4. The FSM enters the first phase (detect/claim).

**L2 design phase (session type: l2-designer):**
1. The FSM enters the l2-design phase.
2. The control plane assembles context: L0 vision, L1 spec content (read from the spec chain), existing L2 specs in the architecture directory (for pattern consistency), and any feedback from a prior l2-gate iteration.
3. The control plane spawns an `l2-designer` session via Session Runtime.
4. The session reads specs, self-brainstorms architectural approaches, writes the L2 spec file, and updates traceability. It does not create branches, commits, labels, comments, or review proposals.
5. On session completion: the control plane packages the changed artifacts through Controlled Artifact Delivery, appends the L2 spec reference and PhaseArtifact to RunState, writes the review-pending label, and transitions to the l2-gate phase.

**L2 gate phase (gate type):**
1. The FSM enters the l2-gate phase. The run is now parked.
2. On each poll cycle, the control plane checks the work request's label state:
   - If the approval label is present: transition to l3-generate. Record the gate event in gate history.
   - If the feedback label is present: read feedback from work request comments and review comments since the last gate event. Transition back to l2-design with the feedback assembled into the session context. Record the gate event.
   - If neither: remain parked. No cost incurred.
3. Parked runs do not block other work — the control plane can claim and process other work requests concurrently.

**L3 generation phase (session type: l3-generator):**
1. The FSM enters the l3-generate phase.
2. The control plane assembles context: L1 spec, approved L2 spec (from the spec chain), existing L3 specs (for pattern consistency), and traceability map.
3. The control plane spawns an `l3-generator` session via Session Runtime.
4. The session generates L3 spec files and updates traceability with code paths and test paths. It does not create branches, commits, labels, comments, or review proposals.
5. On session completion: the control plane packages the changed artifacts through Controlled Artifact Delivery, appends the L3 spec reference and PhaseArtifact to RunState, and transitions to l3-compliance.

**L3 compliance phase (session type: spec-compliance-reviewer):**
1. The FSM enters the l3-compliance phase.
2. The control plane spawns a `spec-compliance-reviewer` session with the full spec chain.
3. The session checks L3 against L2 and L1 for contradictions, verifies traceability linkages, and returns a pass/fail result with findings.
4. On pass: merge the L3 spec branch, transition to implement.
5. On fail: if the findings are fixable, transition back to l3-generate with the findings as context (up to max retries). If the findings indicate an L2 contradiction that cannot be resolved at L3, create a suggestion issue and transition to stuck.

**Implementation phase (delegated to Implementation Coordinator):**
1. The FSM enters the implement phase.
2. The control plane delegates to Implementation Coordinator with: the full spec chain (L1, L2, L3), traceability map, and work request body.
3. The Implementation Coordinator decomposes (if standard/complex) or creates a single unit (if simple), then executes using its standard batch workflow.
4. On completion: transition to review.

**Review and holdout phases (delegated to Validation Service):**
1. Standard delegation to Validation Service as defined in ARCH-AC-CONTROL-PLANE and ARCH-AC-VALIDATION.
2. The spec chain is included in the review context so reviewers can verify spec compliance alongside code quality.

**Integration and reporting:**
1. Standard integration flow as defined in ARCH-AC-CONTROL-PLANE (acquire lock, rebase, create proposal, review diff, merge).
2. Reporter session includes spec chain summary in the completion report.

**Feedback loop mechanics:**
When a gate phase detects feedback, the FSM re-enters the preceding session phase with augmented context:
1. The original session context (spec chain, existing deliverable).
2. The feedback content (extracted from work request comments and review comments posted since the last gate event).
3. The deliverable reference (so the session can update rather than recreate).

The session operates in the prepared workspace and updates the spec file rather than creating a new delivery proposal. After the session returns, the Control Plane updates the recorded PhaseArtifact and review proposal. The FSM then transitions back to the gate phase for re-evaluation.

**Crash resumption for parked runs:**
1. On startup, the control plane scans for incomplete RunStates as usual.
2. If a RunState is at a gate phase with a ParkState, the FSM resumes in parked mode — it checks the gate condition on the next poll cycle.
3. If a RunState is at a session phase mid-execution (the session was interrupted), the FSM restarts the session phase from scratch (session work is not resumable).
4. Gate history in the RunState prevents re-processing of already-acknowledged approvals or feedback.

## Error Handling

**Session failure in a session phase:** Retry up to the phase's max retry count. Each retry re-executes the full session. After max retries, transition to stuck.

**Gate timeout:** If a run remains parked for longer than a configurable maximum duration (e.g., 7 days), the control plane posts a reminder comment on the work request and notifies the Operator. The run remains parked — it does not transition to stuck, because the delay is external (awaiting human review), not a system failure.

**L3 compliance failure after max retries:** Transition to stuck. The Operator reviews and either adjusts the L2 spec or provides guidance.

**Feedback loop cycling:** If a gate phase cycles through feedback more than a configurable maximum number of times (e.g., 5 iterations), transition to stuck. This prevents infinite design iteration loops.

**Spec chain integrity:** Before entering each phase, the control plane validates that the spec chain is complete for the current layer — L2-design requires L1, l3-generate requires L1+L2, implement requires L1+L2+L3. Missing entries indicate a corrupted RunState; transition to stuck.
