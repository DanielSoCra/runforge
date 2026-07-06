---
id: ARCH-AC-DATA-PLATFORM
type: architecture
domain: runforge
status: draft
version: 2
layer: 2
references: FUNC-AC-DATA-PLATFORM
---

# ARCH-AC-DATA-PLATFORM — Self-Hosted Data Service

## Overview

A project-owned **Data Service** replaces the external hosted data provider. It comprises a self-hosted operational data store, a set of bounded data-access contracts (Stores) consumed by the Dashboard, the Agent Service, and the Briefing component, a project-owned **Migration Runner** that controls every change to the structure of stored data, and a **Backup/Restore boundary**. A staged strategy keeps behavior at parity, performs one explicit cutover, then removes the hosted dependency.

## Data Model

The target data model must be derived from the **full historical sequence of structure-change artifacts**, not from a single live snapshot, and must preserve every existing field, relationship, default, constraint, enumerated value, derived behavior, and backward-compatible access pattern.

Entities (plain language):

- **GlobalSettings** — one record of system-wide limits (concurrency, daily budget, default model).
- **Repository** — a watched repository: owner, name, enabled flag, soft-deletion marker, budget and concurrency limits, polling cadence, staging and production branch names, a link to the GitHub connection that authorizes it, credential status plus credential error, and a health status both for its autonomous matrix and for its GitHub connection.
- **Run** — one pipeline execution for a repository and issue: current phase, outcome (including a failed outcome), pipeline variant, total cost, fix attempts, the ordered phase records, the report, the active plugins, and started/completed/updated timestamps.
- **CostEvent** — a single cost amount attributed to a Run and a session type, optionally carrying the provider that incurred it (the model-provider the session ran on) and the usage quantity the runtime reported for the session. Both attribution values are optional: records written before attribution existed, and records from runtimes that cannot report a value, carry neither — consumers surface such records as unattributed and never invent a value for them.
- **RepoPlugin** — activation and recommendation state linking a Repository to a plugin, including a per-repository plugin configuration document.
- **PluginGlobalSettings** — configuration for a plugin shared across all repositories.
- **ApiKey** — a per-repository stored credential identified by its kind (one of: source-control, model-provider, webhook-secret), kept in protected form, written by administrators but never returned to operators in readable form.
- **GitHubConnection** — an authorized connection holding an access credential kept in protected form, never exposed in readable form outside the boundary that needs it, with status and expiry.
- **GitHubOrg** — an organization reachable through a connection, with selection state.
- **Briefing** — a generated status summary with its signal snapshot.
- **ActivityEvent** — a recorded event with type, severity, summary, and links.
- **NotificationChannelConfig** — a configured delivery channel and the events it covers.

Identity, membership, and invitation records are **not** owned here; they are owned by the Operator Authorization architecture. This Data Service only provides the shared store instance and the Migration Runner through which those records are physically created.

## API Contract

The Data Service exposes bounded Store contracts. Each operation states its inputs, its returned shape, and its failure outcomes. No caller depends on storage internals.

- **RepoStore** — `listEnabledRepositories() → repositories`; `upsertRepository(repository) → repository`; `setCredentialStatus(repositoryId, status, error?) → ok | not-found`; `namesFor(projectIds) → display names for the requested projects` (read-only; requested identifiers with no matching record are simply absent from the result).
- **RunStore** — `insertRun(run) → run`; `updateRun(runId, changes) → run | not-found`; `listRunsUpdatedSince(timestamp) → runs`; `countStuckRunsForIssue(repository identity, work request identifier) → count`; `markInProgressRunsStuck(completedAt) → affected run identifiers`; `attributionFor(runIds) → per-run project identity and completion time` (read-only; the join surface the spend projection uses to attribute cost records to projects).
- **CostEventStore** — `recordCostEvent(runId, sessionType, amount, attribution?) → ok | run-not-found`, where the optional attribution names the provider that incurred the cost and the usage quantity the runtime reported (either may be absent); `listForWindow(window) → cost events recorded within the window` (read-only, ordered by recording time).
- **CredentialStore** — `storeConnectionCredential(connection, plaintext) → connectionId`; `readConnectionCredential(connectionId) → plaintext (within boundary only) | denied`; `setConnectionStatus(connectionId, status) → ok`; `storeRepoCredential(repositoryId, kind, plaintext) → ok`; `readRepoCredential(repositoryId, kind) → plaintext (within boundary only) | denied`; `listRepoCredentialMetadata(repositoryId) → [{ kind, updatedAt }] | not-found` — returns no plaintext, covers the source-control, model-provider, and webhook-secret kinds, and is what callers use to show credential presence and gate repository enablement.
- **PluginStore** — `listActivePlugins(repositoryId) → plugins`; `listRepositoryPlugins(repositoryId) → repoPlugin records (active, recommended, recommendation reason and time, activation time, configuration)`; `setPluginActivation(repositoryId, pluginId, active) → ok`; `readRepoPluginConfig(repositoryId, pluginId) → config`; `updateRepoPluginConfig(repositoryId, pluginId, config) → config | not-found`; `recordPluginRecommendation(repositoryId, pluginId, recommendation) → ok | not-found`; `readPluginGlobalSettings(pluginId) → settings`; `updatePluginGlobalSettings(pluginId, changes) → settings`.
- **BriefingStore** — `readLatestBriefing() → briefing | not-found`; `appendBriefing(briefing) → ok`; `appendActivityEvents(events) → ok`; `listRunsForSignals(since) → runs`; `countNotificationChannels() → count`.
- **SettingsAccess** — `readGlobalSettings() → settings`; `updateGlobalSettings(changes) → settings`.

Every operation returns an explicit not-found, denied, or unavailable outcome rather than an ambiguous empty result. Read outcomes carry the complete record shape defined by the Data Model.

## System Boundaries

- The **Data Service** owns the operational data store instance, its connection lifecycle, the Migration Runner, the ordering of structure-change application, drift detection, and the Backup/Restore boundary.
- The **Dashboard**, **Agent Service**, and **Briefing component** consume Store contracts only. They never reach the operational data store directly.
- The **Credential Store** is a sub-boundary that owns protection of stored credentials at rest and scoped retrieval. Readable credentials never cross a service boundary; only the boundary that must call an external service receives a readable credential.
- **Cross-chain coordination:** the Data Service owns the shared operational data store instance, its connection lifecycle, and the structure-change execution mechanism, including ordering. The Operator Authorization architecture owns the definition and behavior of identity, membership, and authorization records; their physical creation is coordinated through the Data Service's Migration Runner. Shared infrastructure ownership does not transfer semantic ownership of authorization data to the Data Service.
- **Coexistence during the staged transition:** the existing Dashboard and Control Plane architectures remain authoritative for current runtime behavior and the data paths they govern today. This architecture defines the target contracts. Concrete governed paths transfer to it only as replacement modules land in later implementation work, at which point traceability moves those paths and the superseded stack specifications are marked deprecated by their own metadata — never deleted.

## Event Flows

1. **Parity read** — A consumer requests data through a Store contract. During parity the contract may read while the hosted provider remains the source of truth; the observable result is identical to before.
2. **Parity write** — A consumer writes through a Store contract. During parity writes remain reconcilable with the hosted source of truth until cutover.
3. **Cutover** — The operator promotes the project-owned data to sole source of truth. Store contracts thereafter read and write only the project-owned data.
4. **Structure-change execution** — On startup the Migration Runner applies every pending structure-change artifact before the Dashboard, Agent Service, or Briefing component serve traffic. Startup ordering guarantees the store is reachable and all changes are applied before any consumer runs. *Consumer traffic* here means operational reads and writes through the Store contracts — it does not include a consumer's own observability surface (such as a health or status endpoint reporting that the store is currently unreachable), which is allowed to be live before the store is ready so the unavailability is visible.
5. **Drift detection** — If an expected field or structure is absent, the Data Service raises an explicit failure instead of degrading.
6. **Backup and restore** — The operator triggers a backup at the Backup/Restore boundary using ordinary self-hosted tooling; a restore reconstitutes the complete operational data.
7. **Hosted removal** — After verified parity and cutover, the hosted-provider integration is removed and the system runs with no hosted-provider account or keys.

## Error Handling

- **Structure-change failure** — Startup aborts; the system refuses to serve traffic against partially changed stored data.
- **Drift** — An expected field or structure that is missing produces an explicit, operator-visible failure, never a silent partial result.
- **Store unreachable** — Consumers fail closed with an explicit unavailable outcome. After cutover there is no silent fall back to the hosted provider. The unavailable outcome carries an Operator-readable message that names the underlying reason (driver-level cause such as connection refusal, authentication denial, or query rejection); collapsing the cause to the SQL text alone is not sufficient. The unavailable outcome must also carry a categorical reason — at minimum *unreachable* (transient, retry-eligible) versus *rejected* (such as schema or permission mismatch, not retry-eligible) — so consumers can pick a recovery policy without parsing message text.
- **Credential retrieval failure** — The operation is denied and surfaced; no readable credential is leaked, and no partial credential is returned.
- **Backup or restore failure** — The failure is explicit and operator-visible; a failed restore never leaves the system believing data is intact.
