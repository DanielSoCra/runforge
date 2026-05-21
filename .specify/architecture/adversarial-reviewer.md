---
id: ARCH-AC-ADVERSARIAL-REVIEWER
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-QUALITY
---

# ARCH-AC-ADVERSARIAL-REVIEWER — Adversarial Reviewer Persona Policy

## Overview

The Adversarial Reviewer Persona Policy defines the behavioral contract under which all intelligent reviewer sessions operate. Neutral evaluation produces sycophantic approvals — approving code that "looks reasonable" without actively attempting to find failures. This spec establishes an adversarial stance as the default reviewer posture: every reviewer session must assume the implementation is flawed and attempt to break it before approving. The adversarial mandate and gate-specific protocol are structurally prepended before the evaluation rubric in every reviewer session.

This policy governs how reviewer sessions are seeded by the Validation Service (see ARCH-AC-VALIDATION for gate sequencing, rubric definitions, and session orchestration).

## Data Model

**AdversarialMandate** defines the universal instruction set injected into every intelligent reviewer session. It contains three invariants: (1) a posture declaration — the reviewer assumes the implementation is flawed until it has failed to break it; (2) an approval principle — the reviewer may only approve after actively attempting to construct failures, never because nothing obviously wrong was found; (3) a missing-code directive — the reviewer explicitly searches for what is absent (unhandled error paths, untested edge cases, unvalidated assumptions) in addition to what is present.

**GateAdversarialProtocol** defines gate-specific adversarial requirements that extend the universal mandate. One protocol exists per intelligent gate type:

- **SpecComplianceProtocol** (gate 2 — spec compliance): Before evaluating any criterion as met, the reviewer must first attempt to construct a realistic scenario in which the implementation would fail that criterion. If no such scenario can be constructed after genuine effort, the criterion may be marked met. The reviewer may not mark a criterion met solely by absence of visible failure.

- **QualityProtocol** (gate 3 — quality): The reviewer must complete an adversarial checklist before evaluating rubric dimensions: (1) construct at least one realistic breakage scenario for the primary logic path; (2) verify every boundary condition in changed code (off-by-one, empty input, maximum size, missing or absent values); (3) check every error path (missing value checks, unhandled operation failures, missing cleanup on failure); (4) check every concurrent-access pattern in changed code (shared state mutation, TOCTOU races, missing cleanup under concurrent calls). An empty adversarial checklist is a finding in itself. Only after completing the checklist does the reviewer proceed to rubric dimension evaluation.

- **SecurityProtocol** (gate 4 — security): Before evaluating any security dimension, the reviewer must produce an attack surface map: (1) enumerate every external input the changed code accepts; (2) identify every trust boundary crossed (user input accepted, data written to persistent storage, processes spawned, third-party services called); (3) state caller assumptions explicitly (what does this code assume about its inputs and callers?). For each identified assumption, the reviewer must explicitly attempt to violate it. Only after completing the attack surface map does the reviewer proceed to security rubric dimension evaluation. A gate 4 session that produces a verdict without an attack surface map has provided no adversarial security value.

**ReviewerSessionSeed** represents the complete context injected into an intelligent reviewer session. It contains: the AdversarialMandate, the GateAdversarialProtocol for this gate type, the evaluation rubric dimensions (from ARCH-AC-VALIDATION), the implementation diff, and the governing spec content. The mandate and protocol sections are structurally prepended before the rubric — they cannot be repositioned or omitted. The reviewer session cannot alter the mandate or protocol it receives.

## API Contract

This spec governs session-seeding behavior and does not introduce new network endpoints. The Validation Service applies the adversarial persona policy when constructing the ReviewerSessionSeed passed to the Session Runtime for reviewer session spawning.

**Constructing a ReviewerSessionSeed** — when the Validation Service prepares to spawn an intelligent reviewer session for any gate:
1. Include the AdversarialMandate as the first substantive section of the session context.
2. Select the GateAdversarialProtocol for this gate type and include it immediately after the mandate.
3. Append the EvaluationRubric dimensions from ARCH-AC-VALIDATION.
4. Append the implementation diff and governing spec content.

The mandate and protocol cannot be overridden or removed by configuration. They are structural constants, not configurable options.

**Validating protocol compliance in reviewer output** — when the Validation Service receives output from an intelligent reviewer session:
- Gate 3 output must include evidence of adversarial checklist completion (at minimum: one breakage scenario, boundary condition notes, error path notes, concurrency check notes) before rubric dimension findings.
- Gate 4 output must include an attack surface map (at minimum: enumerated external inputs, identified trust boundaries, stated assumptions with violation attempts) before security rubric dimension findings.
- Gate 2 output must not show any criterion as met without a documented attempt to construct a failure scenario for it.
- If a required protocol section is absent: treat as malformed output and apply the malformed output policy from ARCH-AC-VALIDATION (retry once; escalate if absent again).
- If output shows `approved: true` but required protocol evidence is absent: override to `approved: false` and treat as malformed output. An approval verdict is only valid when the required protocol evidence is present.

## System Boundaries

- Validation Service OWNS the AdversarialMandate, all GateAdversarialProtocol definitions, ReviewerSessionSeed construction logic, and protocol compliance validation. The adversarial stance is a system-wide policy — it is not configurable at the individual gate or session level.
- Session Runtime receives a completed ReviewerSessionSeed and spawns the reviewer session. It does not inspect, modify, or reorder seed content.
- The reviewer session may only produce structured output (adversarial evidence, findings, verdict) — it has no mechanism to alter the mandate or protocols it was seeded with.
- Reviewer sessions do NOT receive: implementation plans, decomposition reasoning, worker session context, or previous review round output. This isolation constraint is defined by ARCH-AC-VALIDATION and governs all reviewer sessions, including those seeded under this policy.

## Event Flows

**Reviewer session spawn with adversarial seeding:**
1. Validation Service determines the gate type for the next reviewer session.
2. Validation Service constructs a ReviewerSessionSeed: AdversarialMandate first, GateAdversarialProtocol second, EvaluationRubric third, diff and specs last.
3. Validation Service passes the seed to Session Runtime to spawn the reviewer session.
4. Reviewer session reads mandate and gate protocol before proceeding to rubric evaluation.
5. Reviewer session produces structured output with: (a) adversarial protocol evidence (checklist for gate 3, attack surface map for gate 4, failure-scenario attempts for gate 2), (b) rubric dimension findings, (c) summary, (d) approval verdict.
6. Validation Service receives output and validates protocol compliance before accepting the verdict.

**Malformed output path (protocol evidence absent):**
1. Validation Service detects absent protocol section in reviewer output.
2. If approval is present but protocol evidence absent: override approval to false.
3. Retry the reviewer session once with the same seed.
4. If second attempt also lacks required protocol evidence: escalate to stuck. Do not pass the gate — an approval produced without adversarial evidence provides no assurance value.

## Error Handling

**Missing adversarial checklist (gate 3):** Treat as malformed output. Retry once. If absent on retry: escalate. The gate may not pass without evidence of checklist completion.

**Missing attack surface map (gate 4):** Treat as malformed output. Retry once. If absent on retry: escalate. A security approval without an attack surface map is meaningless — the security gate exists to catch what the adversarial protocol surfaces.

**Approval without protocol evidence (any gate):** Override approval to false. Treat as malformed output. Proceed to retry. The approval is structurally invalid until protocol evidence is present.

**Protocol findings conflict with rubric scoring (gate 3 or 4):** Protocol evidence takes precedence. If the adversarial checklist found an unhandled error path but rubric dimensions scored acceptably, the unhandled error path is a finding that must be resolved before the gate can pass.
