---
id: FUNC-AC-PLUGINS
type: functional
domain: auto-claude
status: draft
version: 3
layer: 1
---

# FUNC-AC-PLUGINS — Plugin, Role Registry & Config Pack Management

> **Spec history (v3, 2026-06-11):** v3 extends the plugin capability for the v-next masterplan (decisions D6, D10, D11): the platform's built-in working-role definitions are lifted out of platform code into a declarative role registry; a complete pipeline configuration (lanes + roles + personas + check sets + steering policy) becomes a versioned, swappable **config pack** carried by this same plugin system; assignment and routing values inside the active configuration become changeable at runtime without redeploying; and the pipeline's phase-transition tables are committed to remaining pure, configuration-loadable data. A visual workflow editor is an explicit exclusion this cycle (see Constraints). All concrete values — which roles exist, which lanes, which thresholds — live in packs; one non-normative example pack is maintained alongside the specifications.

## Problem Statement

The system processes work across multiple repositories, each with different domain conventions and tooling requirements. Without a way to configure domain-specific capabilities per repository, every autonomous session operates with the same generic behavior regardless of what it is building. A frontend repository and a data-pipeline repository require different expertise and conventions. Operators have no mechanism to tailor the system's working behavior to a repository's domain, which leads to lower-quality output and missed conventions that a domain expert would naturally apply.

The same rigidity sits one level deeper. The definitions of the platform's own working roles — what each kind of session is, its instructions, its allowed capabilities, its spending bound, its default capability level — are fixed inside the platform, so reshaping a role or adding one is an engineering act rather than a configuration act. And the configuration that *does* exist is scattered: lanes in one place, roles in another, behavioral guidance in a third, with no way to treat "how this whole pipeline behaves" as one named, versioned thing that can be swapped, compared, or rolled back. Finally, changing any routing or assignment value — which role runs at which capability level, which lane prefers what — requires redeploying the platform, which turns cheap policy adjustments into expensive release events. The Operator needs roles and whole pipeline configurations as declared, versioned data, and needs the values inside the active configuration adjustable while the platform runs.

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

### Declarative Role Registry

**Scenario: Working roles are declared, not coded**
- Given the platform's working roles — its implementers, reviewers, classifiers, and the rest
- When the platform needs a role's definition
- Then it reads it from a declarative registry — the role's instructions, its allowed capabilities and skills, its voice and disposition, its spending bound, and its default capability level — and no role's definition is fixed in the platform itself

**Scenario: A role is added or reshaped by declaration**
- Given an admin wants a new working role, or an existing role changed
- When they add or edit the role's declaration in the registry
- Then future sessions of that role run from the new declaration without any change to the platform, and the change is recorded

**Scenario: Each run records the role versions it used**
- Given a run has executed
- When its details are inspected
- Then they show which role declarations, at which versions, served each part of the run — so behavior can be traced to the exact definitions that produced it

### Config Packs

**Scenario: A complete pipeline configuration is one named, versioned pack**
- Given everything that shapes how a deployment's pipeline behaves — its lane declarations, its role declarations, their personas, its check sets, and its steering policy
- When it is packaged
- Then it forms a single named, versioned config pack carried by this plugin system, adopted and bound per deployment exactly as other plugin capabilities are

**Scenario: Activating a pack swaps the whole behavior coherently**
- Given a deployment is running under one config pack version
- When an admin activates a different pack or pack version for it
- Then future work for that deployment runs under the new pack as a whole — never half the old pack and half the new — while runs already in progress complete under the pack they started with

**Scenario: A pack version can be rolled back**
- Given a newly activated pack version turns out to behave worse
- When the admin reverts to the prior version
- Then the deployment runs under the prior version again, the reversion is recorded, and the bad version is not silently re-activated later

**Scenario: A default pack makes a fresh installation runnable**
- Given a fresh installation with no authored configuration
- When the platform starts
- Then a preconfigured default pack is present so the pipeline can run out of the box, and every value in it is ordinary pack data the admin can edit or replace — none of it lives in the platform

### Runtime Configuration Changes

**Scenario: Routing and assignment values change without redeploying**
- Given the active configuration contains routing, threshold, and assignment values — which capability level serves a role, what a lane prefers, where a boundary sits
- When an admin changes such a value
- Then the change takes effect for future work without redeploying or restarting the platform, and runs already in progress complete under the values they started with

**Scenario: Every runtime change is recorded and reversible**
- Given a runtime configuration change has been made
- When it is examined later
- Then the record shows who changed what, from what to what, and when — and the previous value can be restored the same way

### Workflow Definitions as Data

**Scenario: The pipeline's phase sequences stay pure data**
- Given the sequences of phases a run can travel and the transitions between them
- When the platform executes or evolves them
- Then they remain declarative data loadable from configuration — never logic baked into the platform — so a future configuration surface can compose them without re-engineering

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
- Run details show which plugins were active — and which role declarations and config pack version — supporting reproducibility and debugging
- Plugin activation and deactivation take effect for the next session without requiring a system restart
- No working role's definition lives in the platform: every role is declared in the registry, and adding or reshaping a role is a recorded act of declaration, not an engineering change
- A deployment's complete pipeline behavior is expressible, swappable, and reversible as one versioned config pack; no swap ever leaves a deployment running a mixture of two packs
- Routing, threshold, and assignment values inside the active configuration are changeable while the platform runs, take effect for future work only, and every change is recorded and reversible
- A fresh installation runs on the default pack with no authored configuration, and nothing in the default pack is privileged over an admin-authored pack

## Constraints

- Only Admins may activate, deactivate, or export plugins, edit role declarations, change runtime configuration values, or swap config packs; Viewers may only observe
- Suggestions are generated automatically on repository setup and on demand; they never activate without an explicit Admin action
- Deactivating a plugin, editing a declaration, changing a runtime value, or swapping a pack never affects runs already in progress — in-flight work always completes under the configuration it started with
- Built-in plugin capabilities are defined by the system; role declarations and config packs are data the Admin may author, edit, version, and swap — within the boundaries below
- **Configuration can shape behavior but never weaken safety**: no role declaration, pack, or runtime change can disable or weaken the merge decision's scope verification, the compliance gate, budget enforcement, or containment; packs configure within those floors, never past them
- **Policy lives in packs, mechanisms live in the platform**: every routing, threshold, and assignment value is pack or registry data; the platform defines only how such data is read, applied, versioned, and audited. A single, clearly-marked non-normative example pack is maintained alongside the specifications as illustration; it is data, not specification
- Config packs are **versioned and immutable per version**: a deployment binds to an identified pack version, never to a live-edited pack; changing anything produces a new version, and rollback restores an identified prior version
- The pipeline's phase-transition definitions remain pure, configuration-loadable data; a graphical or interactive workflow-composition surface is **excluded from this capability this cycle** — the data seam exists, the surface does not
- Every pack activation, role-declaration edit, and runtime value change is durably recorded with who, what, from-what, to-what, and when, before it takes effect
