---
id: ARCH-AC-PLUGINS
type: architecture
domain: runforge
status: draft
version: 1
layer: 2
references: FUNC-AC-PLUGINS
---

# ARCH-AC-PLUGINS — Plugin & Addon Management

## Overview

The plugin system adds domain-specific expertise to autonomous sessions on a per-repository basis. A Plugin Registry — part of the Daemon's codebase — defines the available plugin catalog. The Database stores which plugins are active per repository. When the Daemon spawns a session, it reads active plugin identifiers from its cached config, assembles a composite context from the Plugin Registry, and injects it into the initial session prompt. The Dashboard Backend handles plugin activation, recommendation generation, and export.

## Data Model

A **Plugin** is defined by the Plugin Registry, not stored in the Database. It has a unique identifier, a name, a version, a description, and a list of tags. A plugin contains: skill documents (behavioral guides), agent documents (specialized subagent prompts), MCP server configurations, validation gate scripts, and a prompt-injection document. Plugins are owned by the system and cannot be created or modified through the Dashboard.

A **RepoPlugin** joins one Repository to one Plugin by identifier. It records whether the plugin is active for that repository, whether it was surfaced by the recommendation system, the reason it was recommended, and timestamps for when it was recommended and when it was activated. The active and activated-at fields are never overwritten by the recommendation system — only by explicit Admin action.

The **Run** entity (defined in ARCH-AC-DASHBOARD) gains an active-plugins field: a list of plugin identifiers recording which plugins were active at the time the run began. This is a best-effort snapshot that may lag behind the Database by up to one config sync interval; it is a transparency record, not an authoritative audit trail.

## API Contract

All Dashboard mutations use Server Actions. No new daemon proxy routes are required — the Daemon reads plugin state via the existing config sync.

**`togglePlugin(repoId, pluginId, active)`** — Admin only. Validates the plugin identifier against the Plugin Registry. Upserts the RepoPlugin record: sets active and activated-at (when enabling) or clears activated-at (when disabling). Returns an error if the plugin identifier is not found in the Plugin Registry.

**`enableAllSuggested(repoId)`** — Admin only. Independently upserts each RepoPlugin record where recommended is true and active is false. Best-effort: each activation is attempted independently. Failures are collected and returned as a list; successful activations are not rolled back.

**`triggerRecommendation(repoId, repoOwner, repoName)`** — Admin only. Dispatches a background recommendation task and returns immediately. `repoOwner` and `repoName` are passed to the Model Provider prompt to identify the repository. The caller receives no result from the task; results arrive via Realtime when the Database is updated.

**`exportPlugin(repoId, pluginId)`** — Admin only. Reads plugin content from the Plugin Registry and writes the plugin's skill documents to the repository's local context store, making them available for interactive developer use outside of the automated system.

**Read operations** are performed by Server Components at page render time: the plugin catalog is read from the Plugin Registry; RepoPlugin rows are read from the Database for the requested repository.

## System Boundaries

**Plugin Registry** — owns plugin definitions: catalog metadata, skill documents, agent documents, MCP server configurations, gate scripts, and prompt-injection documents. Read by the Dashboard Backend at render time and by the Daemon at startup and during config sync. Never written to by the Dashboard or Database.

**Database** — owns per-repository plugin activation state (RepoPlugin records) and the active-plugins field on Run records. Written by the Dashboard Backend (Server Actions) and by the Daemon (Run INSERT). Read by the Dashboard Backend and the Daemon during config sync.

**Dashboard Backend** — owns the recommendation flow: fingerprints the repository, calls the Model Provider, validates results against the Plugin Registry, and writes RepoPlugin rows to the Database. Also owns plugin activation, export, and all Server Actions for this feature.

**Dashboard Frontend** — subscribes to Realtime events on the RepoPlugin table for the current repository. Updates the Suggested section when recommendation rows arrive without a page reload.

**Daemon** — owns session injection: reads active plugin identifiers from its cached config, assembles the CompositeContext from the Plugin Registry, and injects it into the initial session prompt. Writes active plugin identifiers into the Run record at INSERT. The Daemon does not write to the Plugin Registry.

**Model Provider** (external) — receives the repository fingerprint and Plugin Registry catalog; returns ranked plugin recommendations with confidence levels and reasons.

## Event Flows

**Flow 1: Repository added → recommendations generated**

1. Admin adds a repository; Dashboard Backend creates the Repository record in the Database and returns success immediately.
2. Dashboard Backend dispatches a background recommendation task (fire-and-forget).
3. Background task fingerprints the repository using its stored credentials: scans file extensions for dominant languages, inspects dependency manifests for frameworks, checks for existing context documents, and extracts a short description.
4. Background task sends the fingerprint and the Plugin Registry catalog (identifier, name, description, tags per plugin) to the Model Provider.
5. Model Provider returns a ranked list of plugin identifiers with confidence levels and reasons.
6. Background task validates each returned identifier against the Plugin Registry; unknown identifiers are dropped silently.
7. Background task upserts RepoPlugin rows in the Database: sets recommended, recommendation-reason, and recommended-at. Never overwrites active or activated-at.
8. Database broadcasts a Realtime event on the RepoPlugin table.
9. Dashboard Frontend receives the Realtime event and updates the Suggested section without a page reload.

**Flow 2: Admin activates or deactivates a plugin**

1. Admin toggles a plugin in the Dashboard.
2. Dashboard Frontend applies an optimistic update immediately.
3. Dashboard Backend Server Action validates the plugin identifier against the Plugin Registry.
4. Dashboard Backend upserts the RepoPlugin record in the Database.
5. Database broadcasts a Realtime event confirming the change.

**Flow 3: Config sync → active plugins cached in Daemon**

1. On startup and at each sync interval, the Daemon queries the Database for all enabled repositories and their active plugin identifiers.
2. Daemon updates its in-memory config cache with the active plugin list per repository.

**Flow 4: Session spawn → CompositeContext assembled and injected**

1. Daemon reads active plugin identifiers from its cached config for the target repository.
2. Daemon reads skill documents, agent documents, MCP configurations, gate scripts, and prompt-injection documents from the Plugin Registry for each active plugin.
3. Daemon assembles the CompositeContext:
   - Prompt-injection documents are concatenated in activation order (earliest first).
   - Skill and agent documents are merged; filename collisions are resolved by activation order — first-activated plugin wins.
   - MCP server configurations are unioned by server name; first-activated wins on duplicate names.
   - Gate scripts are additive alongside the repository's configured validation commands.
4. Daemon applies the content budget: if total injected content exceeds the token limit, content is truncated by priority — prompt-injection documents are preserved first; skills are dropped before agents; within each type, content from the last-activated plugins is dropped first.
5. Daemon writes the active plugin identifiers into the Run record in the Database at INSERT.
6. Daemon injects the CompositeContext into the initial session prompt.

**Flow 5: Admin re-analyzes a repository**

1. Admin triggers re-analysis from the Dashboard.
2. Dashboard Backend dispatches a background recommendation task and returns immediately.
3. Task follows steps 3–9 of Flow 1. Existing active plugins are unaffected.

## Error Handling

**Recommendation task — Model Provider failure:** If the Model Provider call fails for any reason (timeout, rate limit, error response), the task fails silently. The repository remains fully functional with no recommendations. The Admin can trigger re-analysis manually from the Dashboard.

**Recommendation task — Database write failure:** The task retries once. If the retry fails, no recommendation rows are written and the failure is logged. The Admin can trigger re-analysis manually.

**Server Action — unknown plugin identifier:** If the supplied plugin identifier is not found in the Plugin Registry, the Server Action returns an error to the Dashboard. The RepoPlugin record is not written.

**Enable All Suggested — partial failure:** Each plugin activation is attempted independently. If one or more fail (for example, due to a transient Database error), the successful activations remain and the Dashboard surfaces the list of failed plugins to the Admin.

**Daemon — Database unreachable during config sync:** The Daemon uses its cached config, including the last-known active plugin list. Sessions spawned during an outage use the cached list, which may be stale by up to one sync interval.

**Daemon — orphaned RepoPlugin row:** If a plugin identifier in the cached config is not found in the Plugin Registry at spawn time (for example, because a plugin was removed from the codebase after the row was created), the Daemon logs a warning and skips that plugin. The session continues without it and does not fail.

**Daemon — content budget exceeded:** The Daemon logs a warning identifying which plugins were truncated and injects the reduced CompositeContext. The session continues with the available content.
