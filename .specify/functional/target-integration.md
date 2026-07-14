---
id: FUNC-AC-TARGET-INTEGRATION
type: functional
domain: runforge
status: draft
version: 1
layer: 1
---

# FUNC-AC-TARGET-INTEGRATION — Target Repository Integration Contract

## Problem Statement

The platform can automate only a repository whose working conventions happen to match its own: the exact label names that mark work as ready, the fixed wording of proposal titles, one governance layout for governing specifications, and one built-in patience window for a repository's own quality checks. A maintainer whose repository names, workflows, or review conventions differ cannot adopt the platform without forking it, and cannot find out in advance whether adoption would be safe — the first sign of incompatibility is a wrong or destructive action in their repository.

The integration boundary between the platform and a target repository must therefore express semantic roles ("this label means work is ready") rather than one repository's naming conventions, must be declared explicitly rather than guessed, and must stop autonomous work when the declaration is missing, ambiguous, or rejected by the repository host — never improvising a convention and never reporting an action as successful when the host did not confirm it.

## Actors

- **Maintainer** — owns a target repository and decides whether and how the platform may work in it
- **Operator** — configures the platform for a target repository and answers escalations when the integration contract blocks work

## Behavior

**Scenario: Conventions are declared, not assumed**
- Given a target repository whose workflow label names differ from the platform's native ones
- When the Operator declares the repository's conventions as an integration profile that maps each semantic role to the repository's own names
- Then work discovery, state transitions, and status reporting follow the declared names, without any change to the platform itself

**Scenario: Native conventions remain a built-in profile**
- Given a repository that already follows the platform's native conventions
- When the Operator selects the built-in profile
- Then the platform behaves exactly as it does today, and existing installations keep working through a documented migration path

**Scenario: Compatibility preflight before any work**
- Given a configured target repository
- When the Operator runs the compatibility check
- Then they receive a deterministic verdict — compatible, configuration missing, or unsafe — with each missing or conflicting item named, and the check changes nothing in the repository

**Scenario: Incomplete contract stops autonomous work**
- Given an integration declaration that is invalid, ambiguous, or incomplete
- When the platform would otherwise claim available work in that repository
- Then no work is claimed and the blocking reason is visible to the Operator

**Scenario: Proposal wording follows the profile**
- Given a repository whose contribution rules require particular proposal titles or descriptions
- When the platform submits a change proposal
- Then the proposal's title and description follow the wording declared in the integration profile, with the platform's current wording used by the built-in profile

**Scenario: Repository check patience is declared per repository**
- Given a repository whose own quality checks regularly take longer than the platform's default patience window
- When the Operator declares a longer waiting policy for that repository
- Then the platform waits accordingly before judging the checks, without any change to the platform itself

**Scenario: Governance layout is a selectable profile**
- Given a repository that organizes its governing documents differently from the platform's native methodology
- When the Operator selects a governance profile for that repository
- Then the platform reads governing documents and enforces protected areas according to that profile, with the native methodology remaining available as a built-in profile

**Scenario: Repository instructions may only tighten protection**
- Given a target repository that ships its own working instructions
- When the platform works in that repository
- Then those instructions may narrow what the platform is allowed to touch but can never widen it beyond the declared profile, unless the Operator has explicitly marked the repository as trusted for that purpose

**Scenario: Unconfirmed actions are never reported as success**
- Given the repository host rejects or does not confirm a requested transition
- When the platform records the outcome
- Then the work item is parked with the host's stated reason rather than recorded as completed

## Success Criteria

- A repository whose label names differ from the platform's native conventions can be onboarded by declaration alone — demonstrated without forking or patching the platform
- The compatibility check gives the same verdict for the same repository state on every run, names every missing item, and performs no action a repository audit trail would record as a change
- With an incomplete or invalid integration declaration, the number of autonomous actions taken in the target repository is zero
- An existing installation continues to operate unchanged after upgrading, following the documented migration path
- A repository whose checks conclude after the platform's default patience window can still be integrated by declaration alone

## Constraints

- The integration declaration is explicit and versioned; unrecognized or contradictory declarations are rejected as a whole rather than partially honored
- Declared wording for proposals is fixed-text substitution of named values only; a declaration can never cause the platform to execute instructions of any kind
- The compatibility check is strictly read-only toward the target repository
- Records produced during configuration and preflight never reveal credentials or other secrets
- Repository-supplied instructions can only narrow the platform's permitted working area; widening requires the Operator's explicit trust decision
- Protections that isolate held-back verification material and the platform's methodology remain in force under every profile
