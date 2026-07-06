---
id: FUNC-AC-DASHBOARD
type: functional
domain: runforge
status: approved
version: 4
layer: 1
---

# FUNC-AC-DASHBOARD — Dashboard and Multi-Repo Management

## Problem Statement

An autonomous system that processes work across multiple repositories needs a management surface where operators can configure which repositories to monitor, manage credentials and team access, set budgets, track costs, control the daemon, and approve production releases — without editing config files or SSH-ing into a server.

This is the **management plane only**. It is deliberately not where the operator steers the live fleet: the operator's steering experience — the decisions waiting on them, the daily briefing, what needs attention, and the activity of the work — lives in one place, the single operator steering surface, so the operator is never asked to look in two places for the same thing. This surface may *render* state the steering surface has already produced, but it never *re-summarizes* it, never produces its own interpretation of what changed or what needs attention, and never offers a steering action or a queue of pending operator decisions. Without that boundary held as a rule rather than a habit, a management surface naturally regrows attention-grabbing affordances — a "what changed" summary, a "needs attention" list, suggested next actions — and quietly becomes a second, competing place to operate the fleet, splitting the operator's attention and letting the two surfaces disagree about what is true.

## Actors

> **Actor mapping:** "Admin" in this spec corresponds to "Operator" in the domain-level specs (FUNC-AC-PIPELINE, FUNC-AC-SAFETY, FUNC-AC-LEARNING, etc.). Admin has full Operator capabilities. "Viewer" is a read-only subset — they can monitor but cannot change configuration or approve work.

- **Admin** — installs the system, manages repositories, API keys, team members, budgets, and global settings
- **Viewer** — monitors runs, views cost reports, and sees repository status but cannot change configuration
- **Daemon** — the background process that polls for work and dispatches workers

## Behavior

### Authentication

**Scenario: Sign in with external identity**
- Given a user has an account with a supported identity provider
- When they visit the dashboard
- Then they can authenticate without creating a separate account

**Scenario: First user becomes admin**
- Given no users exist in the system
- When the first user signs in
- Then they are automatically assigned the admin role

**Scenario: Unauthorized access**
- Given an unauthenticated user
- When they attempt to access any dashboard page
- Then they are redirected to the sign-in page

### Repository Management

**Scenario: Add a repository**
- Given an authenticated admin
- When they add a repository by specifying the owner and name
- Then the repository is created in a disabled state pending credential setup

**Scenario: Enable a repository**
- Given an admin has added a repository and provided its credentials
- When they enable the repository
- Then the system begins monitoring it for work requests on the next poll cycle

**Scenario: Configure repository settings**
- Given an admin viewing a repository
- When they update settings (branches, budget limit, maximum concurrency)
- Then the daemon applies the new settings on its next poll cycle

**Scenario: Disable a repository**
- Given an admin viewing a repository
- When they disable it
- Then the daemon stops monitoring it for work requests without deleting configuration or history

**Scenario: Remove a repository**
- Given an admin viewing a disabled repository
- When they remove it
- Then it is logically removed — run history is preserved, and configuration is retained for audit purposes but the repository no longer appears in the UI or daemon sync

### Credential Management

**Scenario: Store repository credentials**
- Given an admin adding or editing a repository
- When they provide access tokens
- Then the credentials are stored encrypted and are never displayed again in the UI

**Scenario: Rotate repository credentials**
- Given credentials are already stored for a repository
- When an admin provides new credentials for the same key type
- Then the new credentials replace the old ones and the repository continues operating with the updated credentials

**Scenario: Credential isolation**
- Given credentials are stored for a repository
- When the daemon uses them
- Then each repository's credentials are used only for that repository

### Run Monitoring

> **Boundary note:** These are render-only management views of run state. This surface displays the runs and links into the operator's steering surface for any action on them; it never ranks them as "needs attention," never derives a summary of what changed, and never offers a steering control here. Deciding what a run needs and acting on it happens in the single operator steering surface, not here.

**Scenario: View active runs**
- Given work is in progress
- When an authenticated user views the dashboard
- Then they see all active runs with: repository, issue, current phase, cost so far, and elapsed time

**Scenario: View run history**
- Given completed runs exist
- When an authenticated user views the runs page
- Then they see historical runs filterable by repository, outcome, and date range

**Scenario: View run details**
- Given a user selects a specific run
- When the detail view loads
- Then they see: every phase executed, duration per phase, cost breakdown, fix attempts, and the final report

**Scenario: Live updates**
- Given a user is viewing the dashboard
- When a run changes phase or completes
- Then the dashboard updates without requiring a page refresh

### Cost Tracking

**Scenario: View daily cost**
- Given an authenticated user
- When they view the dashboard
- Then they see today's total cost across all repositories

**Scenario: View cost history**
- Given an authenticated user views the cost page
- When they select a time range
- Then they see cost broken down by day and by repository

**Scenario: Budget enforcement visibility**
- Given a repository has a budget limit
- When the run cost reaches 80% of the limit, and again when it reaches 100%
- Then the dashboard indicates the budget status visually with a distinct warning and exceeded state
- Note: budget limits are enforced by the daemon (see FUNC-AC-SAFETY). The dashboard surfaces the enforcement state. The default warning threshold is 80%; making it configurable is deferred to a future iteration.

### Team Management

**Scenario: Invite a team member**
- Given an admin
- When they create an invitation by specifying a provider username (e.g. GitHub handle) and a role
- Then the invitation is stored pending, and when that user next signs in they are automatically granted access with the specified role
- Note: matching on provider username is accepted for private deployments; provider usernames can change, which is a known tradeoff. Future hardening may match on immutable provider user ID instead.

**Scenario: Change a member's role**
- Given an admin viewing the team page
- When they change a member's role from viewer to admin (or vice versa)
- Then the member's permissions update immediately

**Scenario: Remove a team member**
- Given an admin viewing the team page
- When they remove a member
- Then that member can no longer access the dashboard

**Scenario: Last admin protection**
- Given only one admin exists
- When that admin attempts to change their own role to viewer or remove themselves
- Then the operation is rejected with an explanation that at least one admin must remain

### Daemon Control

**Scenario: View daemon status**
- Given an authenticated user
- When they view the dashboard
- Then they see whether the daemon is running, paused, or offline

**Scenario: Pause the daemon**
- Given an admin
- When they pause the daemon
- Then the daemon stops accepting new work but allows active runs to complete

**Scenario: Resume the daemon**
- Given an admin with a paused daemon
- When they resume it
- Then the daemon begins accepting new work again

### Steering, briefing, and attention live elsewhere

> **Boundary note:** The briefing, the "what changed since I was away" summary, the prioritized list of what needs human attention, the queue of upcoming work, and the activity feed are **not** part of this management surface. They are owned and produced once, by the single operator steering surface (FUNC-AC-OPERATOR-SURFACE). There is exactly one producer of the briefing and the needs-attention view, so the two surfaces can never disagree about what is true or what needs the operator. This surface may render durable state the steering surface has already produced, but it never re-summarizes that state, never produces its own interpretation of what changed, and never assembles its own needs-attention or pending-decision list.

**Scenario: The management surface never re-summarizes system state**
- Given the operator's briefing and needs-attention view are produced by the single steering surface
- When the operator opens this management surface
- Then it shows only management state — repositories, credentials, team, budgets, costs, daemon status, run records, and pending production releases — and presents no summary of what changed, no list of items needing attention, and no queue of upcoming work
- And any operator steering decision is therefore discovered in exactly one place — the steering surface — never surfaced a second time here

### Notifications

> **Ownership note:** Delivery of operator notifications is owned by FUNC-AC-OPERATOR-SURFACE together with the analysis that decides what is worth surfacing (the briefing and needs-attention pass). This management surface does not generate notifications and does not run an attention-analysis pass of its own; it is a destination the operator manages, not a second source of what the operator should look at. Other specs (FUNC-AC-PIPELINE, FUNC-AC-SAFETY) that reference "Operator notification" depend on that single producer, not on this surface.

### Production Releases

> **Boundary note:** Production-release approval is a management-plane gate and is discovered here, on this surface — not duplicated as a steering-inbox item. The release notes shown are the records the platform already produced for the accumulated work; this surface renders and carries the approval, it does not author its own summary of the release.

**Scenario: View pending releases**
- Given completed work exists in pre-production
- When an Admin views the releases page
- Then they see the accumulated work items ready for production together with the release notes the platform already recorded for that work

**Scenario: Approve production release**
- Given an Admin reviews a pending release
- When they approve it
- Then the system proceeds with the production deployment (see FUNC-AC-PIPELINE for the release workflow)

### Concurrency Configuration

**Scenario: Set global concurrency limit**
- Given an admin on the settings page
- When they set the maximum number of concurrent workers
- Then the daemon enforces this limit across all repositories

**Scenario: Set per-repository concurrency limit**
- Given an admin editing a repository
- When they set a per-repository concurrency limit
- Then the daemon enforces both the global and per-repository limits — whichever is reached first

## Success Criteria

- Operators manage repositories through a web interface, not config files
- Credentials are encrypted at rest and never exposed in the UI after initial entry
- Run status updates appear in the dashboard within seconds of phase changes
- Cost tracking provides accurate historical data for budgeting decisions
- Team members can view status without being able to change configuration

## Constraints

- **This is the management plane, not a steering surface.** It owns repositories, credentials, team, budgets, cost, daemon control, and production-release approval. It does not own — and must not grow — the briefing, the needs-attention view, the upcoming-work queue, or any steering control over a run. Those belong to the single operator steering surface, and adding any of them here is a change to this specification, not a styling choice.
- **Each operator decision is discovered in exactly one surface.** A steering decision is found in the operator's decision inbox; a management or production-release decision is found here. No operator decision is surfaced in both places, so the operator never has to look in two surfaces for the same thing and the two surfaces can never disagree about what awaits the operator.
- **This surface renders state but never re-summarizes it.** Anything it shows about live work is a read-only projection of records the platform already produced; it never runs its own analysis pass to decide what changed, what needs attention, or what to do next, and it never presents a summary, an attention list, an approval queue, or a suggested action derived that way. There is exactly one producer of the briefing and the needs-attention view, and it is not this surface.
- **Links lead out to the owning surface, never to a second copy of it.** Where a management view shows a run or a piece of work, acting on it links into the operator's steering surface; this surface never offers an in-place steering action that would make it a second place to operate the fleet.
- Authentication must use an external identity provider — the system does not manage passwords
- The dashboard must work without the daemon running (shows last-known state)
- Removing a repository preserves its run history
- The first user to sign in has full admin access — no manual bootstrap required
- Credentials stored for one repository are never used for another
