---
id: FUNC-AC-RELEASE
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-RELEASE — Operator-Approved Production Release

## Problem Statement

Accepted, verified work accumulates as the platform's canonical, ready state, but what is actually running in production only changes when someone deliberately promotes it. Today there is no controlled, recorded way to make that promotion and no gate reserving it for the Operator. Without one, production can drift from the ready state with no one certain what is live; a release could happen without the Operator's decision; or a release could leave production half-changed after a failure. The Operator needs to decide every production release, to see exactly what a release would change before committing to it, and to have each release recorded — so production never advances without his say, a release can be previewed safely first, and what is live is always knowable.

## Actors

- **Operator** — the human who previews, approves, and triggers each production release.

## Behavior

**Scenario: Preview a release before anything changes**
- Given accepted, verified work is ready to release
- When the Operator asks to preview a release
- Then they are shown what has been accepted since the last release and what releasing would change, and nothing in production is altered

**Scenario: Production changes only on the Operator's approval**
- Given a release has been previewed
- When the Operator approves the release
- Then production is updated to the approved set of work, and the release is recorded

**Scenario: Nothing is released without approval**
- Given any amount of accepted, verified work
- When the Operator has not approved a release
- Then production does not change, no matter how the work qualified or how confident the platform is

**Scenario: A failed release leaves production as it was**
- Given a release is under way
- When any step of it fails
- Then production is left exactly as it was before the release and the failure is surfaced to the Operator, rather than production being left partly changed

**Scenario: Every release is recorded**
- Given the Operator approves a release
- When the release completes
- Then it is recorded with what was released and when, so what is live can always be known

## Success Criteria

- Production never advances without the Operator's per-release approval
- The Operator can preview exactly what a release would change before approving it, with no effect on production
- A failed release never leaves production partly changed — the previously-live state remains intact
- Every completed release is recorded, so what is live is always knowable

## Constraints

- A production release is always a per-event Operator approval — never automatic and never pre-approved, no matter how the work qualified or how high its earned trust (this enacts the L0 boundary that production is never deployed without the Operator's per-event approval)
- A release must be previewable before it is approved, and the preview must never alter what is running
- A failed or interrupted release must leave the previously-live state intact — production is never left half-promoted
- Each release must be recorded with what changed and when
