---
id: FUNC-AC-DASHBOARD
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-DASHBOARD — Dashboard and Multi-Repo Management

## Problem Statement

An autonomous system that processes work across multiple repositories needs a central control surface where operators can configure which repositories to monitor, view active and historical runs, track costs, manage team access, and control the daemon — without editing config files or SSH-ing into a server.

## Actors

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
- Then its configuration is deleted but run history is preserved

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
- Note: the 80% threshold is implementation-defined and may be made configurable in a later iteration

### Team Management

**Scenario: Invite a team member**
- Given an admin
- When they create an invitation by specifying a provider username (e.g. GitHub handle) and a role
- Then the invitation is stored pending, and when that user next signs in they are automatically granted access with the specified role

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

- Authentication must use an external identity provider — the system does not manage passwords
- The dashboard must work without the daemon running (shows last-known state)
- Removing a repository preserves its run history
- The first user to sign in has full admin access — no manual bootstrap required
- Credentials stored for one repository are never used for another
