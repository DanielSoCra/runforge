---
id: FUNC-AC-DATA-PLATFORM
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-DATA-PLATFORM — Self-Hosted Operational Data Ownership

## Problem Statement

Auto-Claude keeps all of its operational records — which repositories are watched, the history of runs, what each run cost, stored access credentials, plugin activation, briefings, and activity — with an external hosted provider. Because the project does not own this data, the operator cannot back it up or restore it with ordinary self-hosted tooling, cannot guarantee continuity if the provider is unavailable, and cannot independently control how the shape of stored information evolves. This last gap has already caused real harm: the running system once expected a piece of stored information that the live provider did not actually have, and work stalled with no early warning. Until the project owns and controls its own operational data, the operator cannot promise recoverability, continuity, or controlled evolution of what the system remembers.

## Actors

- **Operator** — the person who runs and maintains an Auto-Claude deployment.
- **Administrator** — an operator with full control over configuration and stored data.
- **Viewer** — an operator with read-only visibility into the system.

## Behavior

**Scenario: Operational records stay intact during the transition**
- Given the system is being moved to project-owned operation
- When operational records are served from the project's own data
- Then every repository, run, cost record, stored credential, plugin state, briefing, and activity record the operator could previously see remains visible and unchanged

**Scenario: Cutover without loss**
- Given parity with the previous data has been verified
- When the operator switches the running system fully to the project-owned data
- Then no historical run, cost, configuration, or credential is lost and ongoing work continues uninterrupted

**Scenario: Recover from a backup**
- Given the operator has taken a backup using ordinary self-hosted operational tooling
- When the operational data is restored from that backup
- Then the system resumes with all previously stored records intact

**Scenario: Controlled change to what is stored**
- Given a change to the shape of stored operational information is required
- When the change is delivered as a versioned change artifact kept in the project's own source repository
- Then the running system and its stored information stay consistent and no silent drift occurs

**Scenario: Drift is surfaced, never silent**
- Given the running system expects a specific piece of stored information
- When that information is absent from the project-owned data
- Then the discrepancy is surfaced as an explicit, observable failure rather than silently degrading

**Scenario: Store unreachability is distinguishable from store rejection**
- Given an operation against the project-owned operational data has failed
- When the failure is surfaced to the Operator
- Then the surfaced record names whether the store was unreachable (transient, expected to recover) or rejected the operation (such as a stored-shape, authentication, or permission mismatch), and includes the underlying reason in Operator-readable form — so the Operator can choose between waiting for recovery and intervening on stored shape or access

**Scenario: Hosted dependency removed after parity**
- Given the project-owned data has reached verified parity and cutover is complete
- When the transition is finalized
- Then the system no longer depends on the external hosted provider and runs with no hosted-provider account or keys

## Success Criteria

- The operator can run, back up, restore, and move the system's operational data using ordinary self-hosted operational tooling, with no hosted third-party data provider account or keys required.
- Every repository, run, cost record, stored credential, plugin state, briefing, and activity record available before the transition remains available, with identical meaning, after cutover.
- Changes to the shape of stored operational information are governed by versioned change artifacts kept in the project's own source repository, and any mismatch between what the running system expects and what is actually stored surfaces as an explicit, observable failure.
- After cutover, no operator workflow — repository configuration, run monitoring, cost tracking, credential resolution, plugin activation, briefing — loses any capability it had before.

## Constraints

- The transition is staged: a parity period where behavior is preserved, an explicit cutover, then removal of the hosted dependency. The system must never be left in a state where operational data is partly project-owned and partly hosted with no defined source of truth.
- No operator-visible capability may regress during or after the transition.
- Stored credentials must remain protected at rest and must never be exposed in readable form outside the boundary that needs them.
- Backup and restore must be possible with ordinary self-hosted operational tooling, without proprietary export facilities.
