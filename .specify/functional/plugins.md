---
id: FUNC-AC-PLUGINS
type: functional
domain: auto-claude
status: draft
version: 2
layer: 1
---

# FUNC-AC-PLUGINS — Plugin & Addon Management

## Problem Statement

The system processes work across multiple repositories, each with different domain conventions and tooling requirements. Without a way to configure domain-specific capabilities per repository, every autonomous session operates with the same generic behavior regardless of what it is building. A frontend repository and a data-pipeline repository require different expertise and conventions. Operators have no mechanism to tailor the system's working behavior to a repository's domain, which leads to lower-quality output and missed conventions that a domain expert would naturally apply.

## Actors

> **Actor mapping:** "Admin" in this spec corresponds to "Operator" in the domain-level specs. "Viewer" is a read-only subset.

- **Admin** — activates and deactivates plugins per repository, reviews and accepts suggestions, triggers re-analysis, exports plugins for interactive use
- **Viewer** — observes which plugins are active for a repository and which were active during a specific run

## Behavior

### Plugin Capabilities

**Scenario: Plugin provides domain-specific session context**
- Given a plugin is active for a repository
- When an autonomous session starts for that repository
- Then the session receives domain-specific instructions, conventions, and expertise from the plugin

**Scenario: Plugin provides specialized validation gates**
- Given a plugin is active for a repository
- When the quality assurance phase runs
- Then additional validation checks defined by the plugin are executed alongside the standard gates

**Scenario: Plugin provides tool configurations**
- Given a plugin includes tool configurations
- When an autonomous session starts
- Then the session has access to additional tools (e.g., domain-specific analysis services) configured by the plugin

**Scenario: Plugin provides specialized agent definitions**
- Given a plugin includes agent definitions
- When the system needs specialized reasoning for a domain
- Then it can use plugin-defined agent profiles alongside the default ones

### Plugin Catalog

**Scenario: View available plugins**
- Given an authenticated user views a repository
- When they navigate to the Plugins section
- Then they see the full catalog of available plugins with names and descriptions

**Scenario: View active plugins for a repository**
- Given an authenticated user views a repository
- When they navigate to the Plugins section
- Then they see which plugins are currently active for that repository, distinct from inactive ones

### Activation

**Scenario: Activate a plugin**
- Given an admin views the Plugins section for a repository
- When they activate a plugin
- Then the plugin is active for that repository and applies to future sessions

**Scenario: Deactivate a plugin**
- Given an admin views the Plugins section for a repository
- When they deactivate an active plugin
- Then the plugin is no longer active for that repository and does not apply to future sessions

**Scenario: Plugin changes do not interrupt active runs**
- Given a run is in progress for a repository
- When an admin activates or deactivates a plugin for that repository
- Then the active run completes with the plugin configuration it started with

### Recommendations

**Scenario: Receive plugin suggestions when a repository is added**
- Given an admin has added a repository
- When setup completes
- Then the system analyzes the repository and surfaces relevant plugin suggestions, each with a reason

**Scenario: View plugin suggestions**
- Given plugin suggestions exist for a repository
- When an admin views the Plugins section
- Then they see suggested plugins grouped separately from the full catalog, each showing the reason it was suggested and a confidence level

**Scenario: Accept a suggested plugin**
- Given an admin sees a plugin suggestion
- When they activate it
- Then the plugin becomes active for the repository

**Scenario: Accept all suggestions at once**
- Given an admin sees one or more plugin suggestions
- When they choose to accept all suggestions
- Then all suggested plugins become active for the repository

**Scenario: Partial failure when accepting all suggestions**
- Given an admin accepts all suggestions
- When one or more plugins fail to activate
- Then the successfully activated plugins remain active and the admin is informed which ones failed

**Scenario: Re-analyze a repository**
- Given an admin views the Plugins section
- When they trigger re-analysis
- Then the system re-evaluates the repository and updates the suggestions without affecting active plugins

**Scenario: Suggestions never auto-activate**
- Given plugin suggestions have been generated for a repository
- When the admin has not explicitly accepted them
- Then no suggested plugin becomes active without an explicit admin action

### Run Transparency

**Scenario: View plugins active during a run**
- Given a user views a completed or in-progress run
- When they inspect the run details
- Then they see which plugins were active when that run began

### Interactive Developer Use

**Scenario: Export a plugin to a repository**
- Given an admin views an active plugin for a repository
- When they choose to export it
- Then the plugin's capabilities are made available for use in that repository outside of the automated system

## Success Criteria

- Operators configure plugins per repository through the dashboard without editing configuration files
- New repositories receive plugin suggestions automatically without manual analysis
- Run details show which plugins were active, supporting reproducibility and debugging
- Plugin activation and deactivation take effect for the next session without requiring a system restart

## Constraints

- Only Admins may activate, deactivate, or export plugins; Viewers may only observe
- Suggestions are generated automatically on repository setup and on demand; they never activate without an explicit Admin action
- Deactivating a plugin does not affect runs already in progress
- Plugins are defined by the system and cannot be created or modified through the dashboard
