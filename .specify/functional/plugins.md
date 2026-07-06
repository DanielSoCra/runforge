---
id: FUNC-AC-PLUGINS
type: functional
domain: runforge
status: approved
version: 4
layer: 1
---

# FUNC-AC-PLUGINS — Plugin, Role Registry & Config Pack Management

> **Spec history (v3, 2026-06-11):** v3 extends the plugin capability for the v-next masterplan (decisions D6, D10, D11): the platform's built-in working-role definitions are lifted out of platform code into a declarative role registry; a complete pipeline configuration (lanes + roles + personas + check sets + steering policy) becomes a versioned, swappable **config pack** carried by this same plugin system; assignment and routing values inside the active configuration become changeable at runtime without redeploying; and the pipeline's phase-transition tables are committed to remaining pure, configuration-loadable data. A visual workflow editor is an explicit exclusion this cycle (see Constraints). All concrete values — which roles exist, which lanes, which thresholds — live in packs; one non-normative example pack is maintained alongside the specifications.
>
> **Spec history (v4, 2026-06-24, L0/L1 hardening ratification):** The Operator ratifies three hardening decisions and this sets `status: approved`. **(1) Non-configurable minimum-classification floor (classification-floor):** enumerated risky change kinds — authentication or security, data migrations, sensitive-data handling, and regulated paths — carry a minimum risk classification a config pack can only **raise**, never lower; the floor is implemented by extending the existing escalate-only markings and always-escalate set (not a parallel rule), the kind list is an L0-owned append-only invariant, and detection is **semantic** (by what the change actually is or touches), never path-pattern-only. **(2) The non-weakening floor is enumerated as a closed list (plugins-draft-approval):** the "never weaken safety" floor is extended to name the verifier-gate boundary and the always-escalate set explicitly, expressed as a closed, mechanism-derived enumeration with an amendment rule, not an open-ended catch-all. **(3) Two-tier runtime values (runtime-floor-values):** runtime-changeable values are split — a small **closed allowlist** of soft values (display, model/lane *preference* among pre-approved verifier-equivalent options, debounce within safe ranges, notification cadence) may be hot-swapped, while everything else, including which verifier or lane actually runs, sampling strategy, promotion/earn-in timing, retry/fix cadence, and every named scalar floor, is frozen per pack version and changeable only by a recorded pack-version change. The hardening through-line: a safety claim is a non-configurable, fail-closed mechanism; configuration may only ratchet more cautious, never relabel risk down or cross a floor.

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

**Scenario: A pack may raise a risky change kind's classification but never lower it**
- Given a change whose nature falls in an enumerated risky kind — authentication or security, a data migration, sensitive-data handling, or a regulated path
- When a config pack's classification rules are applied to it
- Then the pack may classify it as more cautious than its minimum, but a pack that would classify it below its minimum has no effect on the floor — the platform still treats it at no less than the minimum, so a risky change always reaches a human by construction regardless of how a pack labels it

**Scenario: A risky change kind is recognized by what it is, not only by where it sits**
- Given a change in an enumerated risky kind that a pack has not marked as risky — for instance authentication or migration logic composed across an ordinary-looking set of files
- When the platform classifies the change
- Then it recognizes the kind from what the change actually is or touches, not from file location alone, and applies the minimum classification — a change cannot escape the floor by avoiding a flagged path

**Scenario: The enumerated risky kinds are an append-only platform invariant**
- Given the set of risky change kinds that carry a minimum classification
- When the platform or a deployment evolves
- Then no pack, profile, or runtime change can remove a kind from the set or shrink the floor; the set is owned at the platform's highest level and may only be added to, never narrowed

### Runtime Configuration Changes

**Scenario: Soft routing and preference values change without redeploying**
- Given a value belongs to the closed soft tier — display and presentation, a lane's or role's *preference* among pre-approved capability options that are equivalent in safety, debounce or pacing within safe ranges, or notification cadence
- When an admin changes such a value
- Then the change takes effect for future work without redeploying or restarting the platform, and runs already in progress complete under the values they started with

**Scenario: A floor value cannot be changed live**
- Given a value belongs to the frozen tier — any sampling minimum, fix-cycle cap, risk threshold, earn-in bar, or any other value an approved safety specification declares a floor; and likewise any value that governs *which* verifier or lane actually runs, the sampling strategy or mode, promotion or earn-in timing, or retry and fix-cycle cadence
- When an admin attempts to change such a value at runtime
- Then the platform refuses the live change: a frozen value moves only by adopting a different, recorded config-pack version, never by a runtime tweak

**Scenario: The soft tier is a closed allowlist, deny-by-default**
- Given a value whose tier is not on the platform's known soft allowlist — including any value owned by a pack or any unrecognized value
- When an admin attempts to change it at runtime
- Then it is treated as frozen by construction and cannot be hot-swapped; only values explicitly on the soft allowlist are runtime-changeable, everything else is frozen per pack version

**Scenario: A runtime change that would cross a floor is rejected**
- Given a soft-tier change whose effect would move a deployment's safety posture below a floor — for example switching to a faster but not-verifier-equivalent option, or pacing a check below its minimum
- When the change is submitted
- Then the platform rejects it rather than applying it: no runtime change may relabel risk downward or carry any value across a floor, and the rejection is recorded

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
- Only values on the closed soft allowlist are changeable while the platform runs; they take effect for future work only and every change is recorded and reversible. Floor values and the interaction levers that govern which verifier or lane runs, sampling strategy, and promotion timing are frozen per pack version, and any runtime change that would cross a floor or relabel risk downward is rejected
- An enumerated risky change kind — authentication or security, a data migration, sensitive-data handling, or a regulated path — always reaches a human by construction: a pack may only raise its classification, never lower it; the kind is recognized by what the change is or touches, not by path alone; and the set of risky kinds can only be added to, never narrowed
- The non-weakening floor names a closed, mechanism-derived set of safety boundaries — scope verification, the compliance gate, budget, containment, the verifier-gate boundary, and the always-escalate set — extended only by spec amendment when a new floor is ratified, never by an open-ended reference
- A fresh installation runs on the default pack with no authored configuration, and nothing in the default pack is privileged over an admin-authored pack

## Constraints

- Only Admins may activate, deactivate, or export plugins, edit role declarations, change runtime configuration values, or swap config packs; Viewers may only observe
- Suggestions are generated automatically on repository setup and on demand; they never activate without an explicit Admin action
- Deactivating a plugin, editing a declaration, changing a runtime value, or swapping a pack never affects runs already in progress — in-flight work always completes under the configuration it started with
- Built-in plugin capabilities are defined by the system; role declarations and config packs are data the Admin may author, edit, version, and swap — within the boundaries below
- **Configuration can shape behavior but never weaken safety**: no role declaration, pack, or runtime change can disable or weaken any non-configurable safety floor owned by an approved safety specification — including but not limited to the scope verification, the compliance gate, budget enforcement, containment, the verifier-gate boundary (no autonomous action without a falsifying verifier), and the always-escalate set; packs configure within those floors, never past them. This enumeration is closed and mechanism-derived rather than open-ended: it is extended only by spec amendment whenever a new non-configurable floor is ratified — a pack may add behavior, never subtract a floor
- **Risky change kinds carry a non-configurable minimum classification**: changes whose nature is authentication or security, a data migration, sensitive-data handling, or a regulated path carry a minimum risk classification a pack may only **raise**, never lower — extending the escalate-only markings already defined for the merge decision rather than introducing a separate rule, so these changes reach a human by construction however a pack labels them. The kind is recognized **semantically**, by what the change actually is or touches, not by file path alone; and the set of risky kinds is a platform-level, **append-only invariant** — a pack, profile, or runtime change may never remove a kind or shrink the floor
- **Runtime-changeable values are a closed soft allowlist; floor values are frozen per pack version**: only values explicitly on the platform's soft allowlist — display and presentation, a lane's or role's preference among pre-approved capability options equivalent in safety, debounce or pacing within safe ranges, and notification cadence — may be hot-swapped at runtime. Everything else is frozen by construction and deny-by-default, including every pack-owned or unrecognized value and every value an approved safety specification names a floor — sampling minimums, fix-cycle caps, risk thresholds, and earn-in bars — and the interaction levers that change effective safety posture: which verifier or lane actually runs, the sampling strategy or mode, promotion or earn-in timing, and retry or fix-cycle cadence. A frozen value moves only by adopting a different, recorded config-pack version, never by a live tweak, and any runtime change that would carry a value across a floor or relabel risk downward is rejected and the rejection recorded
- **Policy lives in packs, mechanisms live in the platform**: every routing, threshold, and assignment value is pack or registry data; the platform defines only how such data is read, applied, versioned, and audited. A single, clearly-marked non-normative example pack is maintained alongside the specifications as illustration; it is data, not specification
- Config packs are **versioned and immutable per version**: a deployment binds to an identified pack version, never to a live-edited pack; changing anything produces a new version, and rollback restores an identified prior version
- The pipeline's phase-transition definitions remain pure, configuration-loadable data; a graphical or interactive workflow-composition surface is **excluded from this capability this cycle** — the data seam exists, the surface does not
- Every pack activation, role-declaration edit, and runtime value change is durably recorded with who, what, from-what, to-what, and when, before it takes effect
