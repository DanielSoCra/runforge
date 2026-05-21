---
id: ARCH-AC-OPERATOR-AUTH
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-OPERATOR-AUTH
---

# ARCH-AC-OPERATOR-AUTH — Operator Authentication and Authorization Service

## Overview

A project-owned **Auth Service** owns operator identity, authenticated sessions, and the authorization model. The Dashboard enforces a server-side session-and-role gate before any privileged read or change, and authorization is decided in the application layer rather than delegated to the data store's own policy engine. An explicit, named local-only convenience mode replaces the prior all-or-nothing sign-in bypass.

## Data Model

- **OperatorIdentity** — one record per operator: a stable identifier, sign-in identity, and verification state.
- **Session** — an authenticated session bound to one OperatorIdentity, with issue and expiry markers and the originating context.
- **AccountLink** — links an OperatorIdentity to a sign-in method and its associated secret material in protected form.
- **Verification** — a short-lived verification record used to confirm a sign-in identity.
- **TeamMembership** — binds one OperatorIdentity to exactly one role: administrator or viewer.
- **Invitation** — a pending grant of a role to a named external handle, with status and expiry.
- **BootstrapState** — records whether a deployment has yet established its first administrator.

These records physically reside in the shared operational data store, but their definition and behavior are semantically owned here. Their physical creation is coordinated through the Data Service's Migration Runner (see ARCH-AC-DATA-PLATFORM System Boundaries).

## API Contract

- **Sign-in** — input: a sign-in identity and proof; output: an authenticated session, or a refusal with reason.
- **Sign-out** — input: an authenticated session; output: the session is invalidated.
- **Session gate** — input: an incoming server-side context; output: the resolved operator and role, or a redirect-to-sign-in or refusal decision. This gate runs before every privileged operation.
- **Role check** — input: a resolved operator and a requested capability; output: allowed or refused; default is refused.
- **Membership lookup** — input: an operator identifier; output: the operator's role, or absent.
- **Invitation accept / first-administrator bootstrap** — input: an invitation or a fresh-deployment bootstrap claim; output: a granted membership; the first-administrator claim succeeds at most once per deployment.
- **Local-only bypass contract** — input: an explicit local-mode declaration plus the absence of any production indicator; output: a synthetic administrator identity only when both hold, otherwise refusal.

## System Boundaries

- The **Auth Service** owns identity, sessions, role assignment, invitations, bootstrap state, and every authorization decision.
- The **Dashboard** enforces the session-and-role gate on the server side before any privileged view or change; it never trusts a role asserted by the client.
- **Agent Service and daemon control operations** are protected by the same administrator-only gate.
- The **Data Service** provides only the shared store instance and the Migration Runner that physically create authorization records. No authorization logic lives in the data store; the data store's own policy engine is not used for access control.
- **Coexistence during the staged transition:** the existing Dashboard architecture remains authoritative for current sign-in behavior until the project-owned replacement lands. This architecture defines the target. Governed paths and the deprecation of superseded stack specifications transfer only in later implementation work, recorded via metadata, never by deletion.

## Event Flows

1. **Sign-in** — An operator presents a sign-in identity; the Auth Service verifies it and issues an authenticated session.
2. **Privileged access** — On every privileged view or change, the Dashboard invokes the session gate, which resolves operator and role before the operation proceeds.
3. **Viewer denial** — A viewer-role operator attempting a change is refused by the role check; no state changes.
4. **Local bypass evaluation** — On startup the Auth Service evaluates the local-only bypass contract; a synthetic administrator is created only when local mode is declared and no production indicator is present.
5. **Membership change** — An administrator grants or revokes a role, or an invitation is accepted; subsequent gate decisions reflect the new role immediately.
6. **First-administrator bootstrap** — In a fresh deployment the first established operator atomically becomes administrator; concurrent attempts resolve to exactly one administrator.

## Error Handling

- **Missing or invalid session** — The gate refuses and redirects to sign-in; no privileged operation runs.
- **Insufficient role** — The role check refuses; no mutation occurs and the refusal is explicit.
- **Ambiguous local mode** — If local mode is declared but a production indicator is present, the bypass is refused and the system fails closed rather than granting access.
- **Stale membership** — A role change invalidates cached authorization; the next decision re-resolves at least privilege.
- **Bootstrap race** — Concurrent first-administrator claims resolve so that exactly one administrator is established; the others are refused.
