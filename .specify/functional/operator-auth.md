---
id: FUNC-AC-OPERATOR-AUTH
type: functional
domain: runforge
status: draft
version: 1
layer: 1
---

# FUNC-AC-OPERATOR-AUTH — Operator Identity and Authorization Ownership

## Problem Statement

Runforge's dashboard relies on an external hosted provider to sign operators in and on a storage-layer policy mechanism to decide who may change what. It also has a single blunt switch that disables all sign-in entirely, used for single-operator deployments. This couples the project's access control to an outside provider, makes authorization depend on where data happens to be stored rather than on the application's own rules, and the all-or-nothing bypass is easy to leave on by mistake in a real deployment. Until the project owns operator identity and authorization, it cannot guarantee that only authorized operators change critical settings, cannot evolve its access rules independently, and risks weakening security during the move to self-hosted operation.

## Actors

- **Operator** — the person who runs and maintains an Runforge deployment.
- **Administrator** — an operator with full control: repositories, credentials, team, daemon controls, and settings.
- **Viewer** — an operator with read-only visibility and no ability to change anything.

## Behavior

**Scenario: Operator signs in**
- Given an operator with valid access
- When they sign in to the dashboard
- Then they gain authenticated access and see only the views their role permits

**Scenario: Administrator makes a privileged change**
- Given a signed-in Administrator
- When they change repository, credential, team, daemon-control, or system settings
- Then the change is accepted

**Scenario: Viewer is prevented from changing anything**
- Given a signed-in Viewer
- When they attempt to change repository, credential, team, daemon-control, or system settings
- Then the action is refused and nothing changes

**Scenario: Unauthenticated access is refused**
- Given a visitor with no valid authenticated access
- When they attempt to open any operator view or make any change
- Then access is refused

**Scenario: Local single-operator convenience without weakening production**
- Given the system is run by a single operator in an explicitly declared local environment
- When a named local-only convenience access mode is enabled
- Then the operator can work without external sign-in

**Scenario: Convenience mode refused in production**
- Given any indicator that the deployment is a production environment
- When the local-only convenience access mode is requested
- Then it is refused

**Scenario: Existing operators keep access after the move**
- Given operators and their roles existed before the move
- When the project-owned identity system becomes the source of truth
- Then each operator keeps an equivalent role and equivalent access, with documented continuity

**Scenario: First operator bootstrap**
- Given no operator yet holds administrative control in a fresh deployment
- When the first operator is established
- Then that operator receives administrative control, and subsequent operators are admitted only by invitation under administrative control

## Success Criteria

- Operator identity, roles, and sign-in are owned by the project and require no external hosted identity provider.
- The administrator-versus-viewer capability distinction is enforced before any privileged view or change, is decided by the application's own rules rather than by where data is stored, and defaults to refusal.
- The all-or-nothing sign-in bypass is replaced by an explicit, named, local-only convenience mode that cannot activate in a production environment.
- Every operator and role present before the move has documented, verified equivalent access afterward, and no operator capability is weakened relative to the prior system.

## Constraints

- The change must be a security improvement, or at minimum security-neutral; weakening sign-in or authorization is not acceptable.
- Authorization must not depend on the mechanism that stores operational data.
- A production environment must never permit the local-only convenience bypass.
- The meaning of each role — full administrative control versus read-only visibility — must be preserved exactly as operators experience it today.
