import type {
  ActivityEvent,
  Briefing,
  CostEvent,
  GlobalSettings,
  GitHubConnection,
  GitHubOrg,
  PluginGlobalSettings,
  RepoPlugin,
  Repository,
  RepositoryInsert,
  Run,
  RunInsert,
} from './schema.js';

export type StoreUnavailable = {
  ok: false;
  error: 'unavailable';
  message: string;
  category: 'unreachable' | 'rejected';
  cause: { class: string; code: string | null; message: string };
};
export type StoreDenied = { ok: false; error: 'denied'; message: string };
export type StoreNotFound = { ok: false; error: 'not-found'; message: string };
export type StoreOk<T = void> = { ok: true; value: T };
export type StoreResult<T = void> =
  | StoreOk<T>
  | StoreUnavailable
  | StoreDenied
  | StoreNotFound;

/** Display identity for a project (repository), for spend attribution views. */
export interface ProjectName {
  id: string;
  /** `owner/name` display identity. */
  name: string;
}

export interface RepoStore {
  listEnabledRepositories(): Promise<StoreResult<Repository[]>>;
  upsertRepository(
    repository: RepositoryInsert,
  ): Promise<StoreResult<Repository>>;
  setCredentialStatus(
    repositoryId: string,
    status: 'ok' | 'error',
    error?: string,
  ): Promise<StoreResult>;
  /**
   * Narrow, read-only reader for the spend projection
   * (STACK-AC-SPEND-OBSERVABILITY): display names for the requested project
   * ids. Ids with no matching repository are absent from the result.
   */
  namesFor(projectIds: string[]): Promise<StoreResult<ProjectName[]>>;
}

/**
 * The run→project/completion-time join surface the spend projection uses to
 * attribute a cost record to a project. `projectId` is null for runs that
 * were never linked to a repository record — surfaced as unattributed.
 */
export interface RunAttribution {
  runId: string;
  projectId: string | null;
  completedAt: Date | null;
}

export interface RunStore {
  insertRun(run: RunInsert): Promise<StoreResult<Run>>;
  updateRun(
    runId: string,
    changes: Partial<RunInsert>,
  ): Promise<StoreResult<Run>>;
  listRunsUpdatedSince(timestamp: Date): Promise<StoreResult<Run[]>>;
  countStuckRunsForIssue(input: {
    repoOwner: string;
    repoName: string;
    issueNumber: number;
  }): Promise<StoreResult<number>>;
  markInProgressRunsStuck(completedAt: Date): Promise<StoreResult<string[]>>;
  /**
   * Narrow, read-only reader for the spend projection
   * (STACK-AC-SPEND-OBSERVABILITY): per-run project identity and completion
   * time. Ids with no matching run are absent from the result.
   */
  attributionFor(runIds: string[]): Promise<StoreResult<RunAttribution[]>>;
}

/** Half-open time window `[from, to)` over `recordedAt`. */
export interface CostEventWindow {
  from: Date;
  to: Date;
}

/**
 * Optional spend attribution captured at record time. Absent values mean the
 * caller does not know them — the row stays unattributed on that dimension
 * (never guessed, never defaulted to a real-looking value).
 */
export interface CostEventAttribution {
  /** The model-provider the session ran on (FUNC-AC-RUNTIME-ADAPTERS). */
  provider?: string;
  /** Runtime-reported total token count for the session, when available. */
  usageUnits?: number;
}

export interface CostEventStore {
  recordCostEvent(
    runId: string,
    sessionType:
      | 'planning'
      | 'implementation'
      | 'validation'
      | 'diagnosis'
      | 'fix',
    amount: number,
    attribution?: CostEventAttribution,
  ): Promise<StoreResult<CostEvent>>;
  /**
   * Narrow, read-only reader for the spend projection
   * (STACK-AC-SPEND-OBSERVABILITY): cost events with `recordedAt` in
   * `[window.from, window.to)`, ordered by recording time. An empty window
   * is the success state: `ok` with an empty list.
   */
  listForWindow(window: CostEventWindow): Promise<StoreResult<CostEvent[]>>;
}

export interface CredentialMetadata {
  kind: 'source-control' | 'model-provider' | 'webhook-secret';
  updatedAt: Date;
}

export interface CredentialStore {
  storeConnectionCredential(
    connection: Omit<GitHubConnection, 'id' | 'encryptedToken' | 'createdAt'>,
    plaintext: string,
  ): Promise<StoreResult<string>>;
  readConnectionCredential(connectionId: string): Promise<StoreResult<string>>;
  setConnectionStatus(
    connectionId: string,
    status: string,
  ): Promise<StoreResult>;
  storeRepoCredential(
    repositoryId: string,
    kind: CredentialMetadata['kind'],
    plaintext: string,
  ): Promise<StoreResult>;
  readRepoCredential(
    repositoryId: string,
    kind: CredentialMetadata['kind'],
  ): Promise<StoreResult<string>>;
  listRepoCredentialMetadata(
    repositoryId: string,
  ): Promise<StoreResult<CredentialMetadata[]>>;
}

export interface PluginStore {
  listActivePlugins(repositoryId: string): Promise<StoreResult<RepoPlugin[]>>;
  listRepositoryPlugins(
    repositoryId: string,
  ): Promise<StoreResult<RepoPlugin[]>>;
  setPluginActivation(
    repositoryId: string,
    pluginId: string,
    active: boolean,
  ): Promise<StoreResult>;
  readRepoPluginConfig(
    repositoryId: string,
    pluginId: string,
  ): Promise<StoreResult<Record<string, unknown>>>;
  updateRepoPluginConfig(
    repositoryId: string,
    pluginId: string,
    config: Record<string, unknown>,
  ): Promise<StoreResult<Record<string, unknown>>>;
  recordPluginRecommendation(
    repositoryId: string,
    pluginId: string,
    recommendation: { recommended: boolean; reason?: string },
  ): Promise<StoreResult>;
  readPluginGlobalSettings(
    pluginId: string,
  ): Promise<StoreResult<PluginGlobalSettings>>;
  updatePluginGlobalSettings(
    pluginId: string,
    changes: Partial<PluginGlobalSettings>,
  ): Promise<StoreResult<PluginGlobalSettings>>;
}

export interface BriefingStore {
  readLatestBriefing(): Promise<StoreResult<Briefing>>;
  appendBriefing(
    briefing: Omit<Briefing, 'id' | 'generatedAt'>,
  ): Promise<StoreResult<Briefing>>;
  appendActivityEvents(
    events: Omit<ActivityEvent, 'id'>[],
  ): Promise<StoreResult<ActivityEvent[]>>;
  listRunsForSignals(since: Date): Promise<StoreResult<Run[]>>;
  countNotificationChannels(): Promise<StoreResult<number>>;
}

export interface SettingsAccess {
  readGlobalSettings(): Promise<StoreResult<GlobalSettings>>;
  updateGlobalSettings(
    changes: Partial<GlobalSettings>,
  ): Promise<StoreResult<GlobalSettings>>;
}

export interface GitHubConnectionStore {
  listOrganizations(connectionId: string): Promise<StoreResult<GitHubOrg[]>>;
}

export type OperatorRole = 'admin' | 'viewer';

export interface OperatorMembership {
  userId: string;
  role: OperatorRole;
  grantedAt: Date;
}

export interface OperatorAuthStore {
  readMembership(userId: string): Promise<StoreResult<OperatorMembership>>;
  setMembership(
    userId: string,
    role: OperatorRole,
  ): Promise<StoreResult<OperatorMembership>>;
  bootstrapFirstAdmin(
    userId: string,
  ): Promise<StoreResult<OperatorMembership>>;
}
