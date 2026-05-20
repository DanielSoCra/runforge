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
};
export type StoreDenied = { ok: false; error: 'denied'; message: string };
export type StoreNotFound = { ok: false; error: 'not-found'; message: string };
export type StoreOk<T = void> = { ok: true; value: T };
export type StoreResult<T = void> =
  | StoreOk<T>
  | StoreUnavailable
  | StoreDenied
  | StoreNotFound;

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
}

export interface RunStore {
  insertRun(run: RunInsert): Promise<StoreResult<Run>>;
  updateRun(
    runId: string,
    changes: Partial<RunInsert>,
  ): Promise<StoreResult<Run>>;
  listRunsUpdatedSince(timestamp: Date): Promise<StoreResult<Run[]>>;
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
  ): Promise<StoreResult<CostEvent>>;
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
