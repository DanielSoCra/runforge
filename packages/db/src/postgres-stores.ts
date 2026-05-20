import { randomUUID } from 'node:crypto';

import { and, count, desc, eq, gte, isNull } from 'drizzle-orm';

import type { AutoClaudeDb } from './client.js';
import {
  decryptCredential,
  encryptCredential,
  readCredentialKey,
  type CredentialEnvelope,
} from './credential-crypto.js';
import {
  activityEvents,
  apiKeys,
  briefings,
  costEvents,
  githubConnections,
  githubOrgs,
  globalSettings,
  notificationChannelConfigs,
  pluginGlobalSettings,
  repoPlugins,
  repos,
  runs,
  type JsonValue,
} from './schema.js';
import type {
  BriefingStore,
  CostEventStore,
  CredentialMetadata,
  CredentialStore,
  GitHubConnectionStore,
  PluginStore,
  RepoStore,
  RunStore,
  SettingsAccess,
  StoreResult,
} from './stores.js';

export interface AutoClaudeStores {
  repos: RepoStore;
  runs: RunStore;
  costs: CostEventStore;
  credentials: CredentialStore;
  plugins: PluginStore;
  briefings: BriefingStore;
  settings: SettingsAccess;
  githubConnections: GitHubConnectionStore;
}

export interface PostgresStoreOptions {
  credentialKey?: Buffer;
}

export function createPostgresStores(
  db: AutoClaudeDb,
  options: PostgresStoreOptions = {},
): AutoClaudeStores {
  const credentialKey = () => options.credentialKey ?? readCredentialKey();

  return {
    repos: new PostgresRepoStore(db),
    runs: new PostgresRunStore(db),
    costs: new PostgresCostEventStore(db),
    credentials: new PostgresCredentialStore(db, credentialKey),
    plugins: new PostgresPluginStore(db),
    briefings: new PostgresBriefingStore(db),
    settings: new PostgresSettingsAccess(db),
    githubConnections: new PostgresGitHubConnectionStore(db),
  };
}

export class PostgresRepoStore implements RepoStore {
  constructor(private readonly db: AutoClaudeDb) {}

  async listEnabledRepositories() {
    return unavailableOnThrow(async () => {
      const rows = await this.db
        .select()
        .from(repos)
        .where(and(eq(repos.enabled, true), isNull(repos.deletedAt)))
        .orderBy(repos.owner, repos.name);
      return ok(rows);
    });
  }

  async upsertRepository(repository: typeof repos.$inferInsert) {
    return unavailableOnThrow(async () => {
      const { id: _id, createdAt: _createdAt, ...updatable } = repository;
      const [row] = await this.db
        .insert(repos)
        .values(repository)
        .onConflictDoUpdate({
          target: [repos.owner, repos.name],
          set: {
            ...withoutUndefined(updatable),
            updatedAt: new Date(),
          },
        })
        .returning();
      return row ? ok(row) : unavailable('repository upsert returned no row');
    });
  }

  async setCredentialStatus(
    repositoryId: string,
    status: 'ok' | 'error',
    error?: string,
  ) {
    return unavailableOnThrow(async () => {
      const [row] = await this.db
        .update(repos)
        .set({
          credentialStatus: status,
          credentialError: error ?? null,
          updatedAt: new Date(),
        })
        .where(eq(repos.id, repositoryId))
        .returning({ id: repos.id });
      return row ? ok() : notFound(`repository ${repositoryId} was not found`);
    });
  }
}

export class PostgresRunStore implements RunStore {
  constructor(private readonly db: AutoClaudeDb) {}

  async insertRun(run: typeof runs.$inferInsert) {
    return unavailableOnThrow(async () => {
      const [row] = await this.db.insert(runs).values(run).returning();
      return row ? ok(row) : unavailable('run insert returned no row');
    });
  }

  async updateRun(runId: string, changes: Partial<typeof runs.$inferInsert>) {
    return unavailableOnThrow(async () => {
      const { id: _id, startedAt: _startedAt, ...updatable } = changes;
      const [row] = await this.db
        .update(runs)
        .set({ ...withoutUndefined(updatable), updatedAt: new Date() })
        .where(eq(runs.id, runId))
        .returning();
      return row ? ok(row) : notFound(`run ${runId} was not found`);
    });
  }

  async listRunsUpdatedSince(timestamp: Date) {
    return unavailableOnThrow(async () => {
      const rows = await this.db
        .select()
        .from(runs)
        .where(gte(runs.updatedAt, timestamp))
        .orderBy(runs.updatedAt);
      return ok(rows);
    });
  }

  async countStuckRunsForIssue(input: {
    repoOwner: string;
    repoName: string;
    issueNumber: number;
  }) {
    return unavailableOnThrow(async () => {
      const [row] = await this.db
        .select({ value: count() })
        .from(runs)
        .where(
          and(
            eq(runs.repoOwner, input.repoOwner),
            eq(runs.repoName, input.repoName),
            eq(runs.issueNumber, input.issueNumber),
            eq(runs.outcome, 'stuck'),
          ),
        );
      return ok(row?.value ?? 0);
    });
  }

  async markInProgressRunsStuck(completedAt: Date) {
    return unavailableOnThrow(async () => {
      const rows = await this.db
        .update(runs)
        .set({
          outcome: 'stuck',
          completedAt,
          updatedAt: new Date(),
        })
        .where(eq(runs.outcome, 'in-progress'))
        .returning({ id: runs.id });
      return ok(rows.map((row) => row.id));
    });
  }
}

export class PostgresCostEventStore implements CostEventStore {
  constructor(private readonly db: AutoClaudeDb) {}

  async recordCostEvent(
    runId: string,
    sessionType: typeof costEvents.$inferInsert.sessionType,
    amount: number,
  ) {
    return unavailableOnThrow(async () => {
      if (!(await runExists(this.db, runId))) {
        return notFound(`run ${runId} was not found`);
      }

      const [row] = await this.db
        .insert(costEvents)
        .values({ runId, sessionType, cost: amount })
        .returning();
      return row ? ok(row) : unavailable('cost event insert returned no row');
    });
  }
}

export class PostgresCredentialStore implements CredentialStore {
  constructor(
    private readonly db: AutoClaudeDb,
    private readonly credentialKey: () => Buffer,
  ) {}

  async storeConnectionCredential(
    connection: Omit<
      typeof githubConnections.$inferSelect,
      'id' | 'encryptedToken' | 'createdAt'
    >,
    plaintext: string,
  ) {
    return unavailableOnThrow(async () => {
      const id = randomUUID();
      const encryptedToken = encodeCredentialEnvelope(
        encryptCredential(plaintext, this.credentialKey(), id),
      );
      const [row] = await this.db
        .insert(githubConnections)
        .values({ ...connection, id, encryptedToken })
        .returning({ id: githubConnections.id });
      return row
        ? ok(row.id)
        : unavailable('connection insert returned no row');
    });
  }

  async readConnectionCredential(connectionId: string) {
    const selected = await unavailableOnThrow(async () => {
      const [row] = await this.db
        .select({ encryptedToken: githubConnections.encryptedToken })
        .from(githubConnections)
        .where(eq(githubConnections.id, connectionId))
        .limit(1);
      return row
        ? ok(row.encryptedToken)
        : notFound(`GitHub connection ${connectionId} was not found`);
    });
    if (!selected.ok) return selected;

    try {
      return ok(
        decryptCredential(
          decodeCredentialEnvelope(selected.value),
          this.credentialKey(),
          connectionId,
        ),
      );
    } catch (error) {
      return denied(
        `GitHub connection ${connectionId} credential could not be decrypted: ${errorMessage(error)}`,
      );
    }
  }

  async setConnectionStatus(connectionId: string, status: string) {
    return unavailableOnThrow(async () => {
      const [row] = await this.db
        .update(githubConnections)
        .set({ status })
        .where(eq(githubConnections.id, connectionId))
        .returning({ id: githubConnections.id });
      return row
        ? ok()
        : notFound(`GitHub connection ${connectionId} was not found`);
    });
  }

  async storeRepoCredential(
    repositoryId: string,
    kind: CredentialMetadata['kind'],
    plaintext: string,
  ) {
    return unavailableOnThrow(async () => {
      if (!(await repositoryExists(this.db, repositoryId))) {
        return notFound(`repository ${repositoryId} was not found`);
      }

      const encryptedValue = encodeCredentialEnvelope(
        encryptCredential(
          plaintext,
          this.credentialKey(),
          repoCredentialAad(repositoryId, kind),
        ),
      );

      const [row] = await this.db
        .insert(apiKeys)
        .values({ repoId: repositoryId, keyType: kind, encryptedValue })
        .onConflictDoUpdate({
          target: [apiKeys.repoId, apiKeys.keyType],
          set: { encryptedValue, updatedAt: new Date() },
        })
        .returning({ id: apiKeys.id });
      return row
        ? ok()
        : unavailable('repository credential upsert returned no row');
    });
  }

  async readRepoCredential(
    repositoryId: string,
    kind: CredentialMetadata['kind'],
  ) {
    const selected = await unavailableOnThrow(async () => {
      const [row] = await this.db
        .select({ encryptedValue: apiKeys.encryptedValue })
        .from(apiKeys)
        .where(and(eq(apiKeys.repoId, repositoryId), eq(apiKeys.keyType, kind)))
        .limit(1);
      return row
        ? ok(row.encryptedValue)
        : notFound(
            `repository ${repositoryId} ${kind} credential was not found`,
          );
    });
    if (!selected.ok) return selected;

    try {
      return ok(
        decryptCredential(
          decodeCredentialEnvelope(selected.value),
          this.credentialKey(),
          repoCredentialAad(repositoryId, kind),
        ),
      );
    } catch (error) {
      return denied(
        `repository ${repositoryId} ${kind} credential could not be decrypted: ${errorMessage(error)}`,
      );
    }
  }

  async listRepoCredentialMetadata(repositoryId: string) {
    return unavailableOnThrow(async () => {
      if (!(await repositoryExists(this.db, repositoryId))) {
        return notFound(`repository ${repositoryId} was not found`);
      }

      const rows = await this.db
        .select({ kind: apiKeys.keyType, updatedAt: apiKeys.updatedAt })
        .from(apiKeys)
        .where(eq(apiKeys.repoId, repositoryId))
        .orderBy(apiKeys.keyType);
      return ok(rows);
    });
  }
}

export class PostgresPluginStore implements PluginStore {
  constructor(private readonly db: AutoClaudeDb) {}

  async listActivePlugins(repositoryId: string) {
    return unavailableOnThrow(async () => {
      if (!(await repositoryExists(this.db, repositoryId))) {
        return notFound(`repository ${repositoryId} was not found`);
      }

      const rows = await this.db
        .select()
        .from(repoPlugins)
        .where(
          and(
            eq(repoPlugins.repoId, repositoryId),
            eq(repoPlugins.active, true),
          ),
        )
        .orderBy(repoPlugins.pluginId);
      return ok(rows);
    });
  }

  async listRepositoryPlugins(repositoryId: string) {
    return unavailableOnThrow(async () => {
      if (!(await repositoryExists(this.db, repositoryId))) {
        return notFound(`repository ${repositoryId} was not found`);
      }

      const rows = await this.db
        .select()
        .from(repoPlugins)
        .where(eq(repoPlugins.repoId, repositoryId))
        .orderBy(repoPlugins.pluginId);
      return ok(rows);
    });
  }

  async setPluginActivation(
    repositoryId: string,
    pluginId: string,
    active: boolean,
  ) {
    return unavailableOnThrow(async () => {
      if (!(await repositoryExists(this.db, repositoryId))) {
        return notFound(`repository ${repositoryId} was not found`);
      }

      const activatedAt = active ? new Date() : null;
      const [row] = await this.db
        .insert(repoPlugins)
        .values({ repoId: repositoryId, pluginId, active, activatedAt })
        .onConflictDoUpdate({
          target: [repoPlugins.repoId, repoPlugins.pluginId],
          set: { active, activatedAt },
        })
        .returning({ id: repoPlugins.id });
      return row
        ? ok()
        : unavailable('plugin activation upsert returned no row');
    });
  }

  async readRepoPluginConfig(repositoryId: string, pluginId: string) {
    return unavailableOnThrow(async () => {
      const [row] = await this.db
        .select({ config: repoPlugins.config })
        .from(repoPlugins)
        .where(
          and(
            eq(repoPlugins.repoId, repositoryId),
            eq(repoPlugins.pluginId, pluginId),
          ),
        )
        .limit(1);
      return row
        ? ok(asUnknownRecord(row.config))
        : notFound(
            `plugin ${pluginId} was not found for repository ${repositoryId}`,
          );
    });
  }

  async updateRepoPluginConfig(
    repositoryId: string,
    pluginId: string,
    config: Record<string, unknown>,
  ) {
    return unavailableOnThrow(async () => {
      const [row] = await this.db
        .update(repoPlugins)
        .set({ config: asJsonRecord(config) })
        .where(
          and(
            eq(repoPlugins.repoId, repositoryId),
            eq(repoPlugins.pluginId, pluginId),
          ),
        )
        .returning({ config: repoPlugins.config });
      return row
        ? ok(asUnknownRecord(row.config))
        : notFound(
            `plugin ${pluginId} was not found for repository ${repositoryId}`,
          );
    });
  }

  async recordPluginRecommendation(
    repositoryId: string,
    pluginId: string,
    recommendation: { recommended: boolean; reason?: string },
  ) {
    return unavailableOnThrow(async () => {
      if (!(await repositoryExists(this.db, repositoryId))) {
        return notFound(`repository ${repositoryId} was not found`);
      }

      const recommendedAt = recommendation.recommended ? new Date() : null;
      const recommendationReason = recommendation.recommended
        ? (recommendation.reason ?? null)
        : null;
      const [row] = await this.db
        .insert(repoPlugins)
        .values({
          repoId: repositoryId,
          pluginId,
          recommended: recommendation.recommended,
          recommendationReason,
          recommendedAt,
        })
        .onConflictDoUpdate({
          target: [repoPlugins.repoId, repoPlugins.pluginId],
          set: {
            recommended: recommendation.recommended,
            recommendationReason,
            recommendedAt,
          },
        })
        .returning({ id: repoPlugins.id });
      return row
        ? ok()
        : unavailable('plugin recommendation upsert returned no row');
    });
  }

  async readPluginGlobalSettings(pluginId: string) {
    return unavailableOnThrow(async () => {
      const [row] = await this.db
        .select()
        .from(pluginGlobalSettings)
        .where(eq(pluginGlobalSettings.pluginId, pluginId))
        .limit(1);
      return row
        ? ok(row)
        : notFound(`plugin global settings ${pluginId} were not found`);
    });
  }

  async updatePluginGlobalSettings(
    pluginId: string,
    changes: Partial<typeof pluginGlobalSettings.$inferSelect>,
  ) {
    return unavailableOnThrow(async () => {
      const [existing] = await this.db
        .select()
        .from(pluginGlobalSettings)
        .where(eq(pluginGlobalSettings.pluginId, pluginId))
        .limit(1);
      const settings =
        changes.settings === undefined
          ? (existing?.settings ?? {})
          : asJsonRecord(changes.settings);
      const updatedAt = new Date();

      if (existing) {
        const [row] = await this.db
          .update(pluginGlobalSettings)
          .set(
            withoutUndefined({
              settings,
              updatedAt,
              updatedBy: changes.updatedBy,
            }),
          )
          .where(eq(pluginGlobalSettings.id, existing.id))
          .returning();
        return row
          ? ok(row)
          : unavailable('plugin global settings update returned no row');
      }

      const [row] = await this.db
        .insert(pluginGlobalSettings)
        .values({ pluginId, settings, updatedAt, updatedBy: changes.updatedBy })
        .returning();
      return row
        ? ok(row)
        : unavailable('plugin global settings insert returned no row');
    });
  }
}

export class PostgresBriefingStore implements BriefingStore {
  constructor(private readonly db: AutoClaudeDb) {}

  async readLatestBriefing() {
    return unavailableOnThrow(async () => {
      const [row] = await this.db
        .select()
        .from(briefings)
        .orderBy(desc(briefings.generatedAt))
        .limit(1);
      return row ? ok(row) : notFound('latest briefing was not found');
    });
  }

  async appendBriefing(
    briefing: Omit<typeof briefings.$inferSelect, 'id' | 'generatedAt'>,
  ) {
    return unavailableOnThrow(async () => {
      const [row] = await this.db
        .insert(briefings)
        .values(briefing)
        .returning();
      return row ? ok(row) : unavailable('briefing insert returned no row');
    });
  }

  async appendActivityEvents(
    events: Omit<typeof activityEvents.$inferSelect, 'id'>[],
  ) {
    return unavailableOnThrow(async () => {
      if (events.length === 0) return ok([]);

      const rows = await this.db
        .insert(activityEvents)
        .values(events)
        .returning();
      return ok(rows);
    });
  }

  async listRunsForSignals(since: Date) {
    return unavailableOnThrow(async () => {
      const rows = await this.db
        .select()
        .from(runs)
        .where(gte(runs.updatedAt, since))
        .orderBy(runs.updatedAt);
      return ok(rows);
    });
  }

  async countNotificationChannels() {
    return unavailableOnThrow(async () => {
      const rows = await this.db
        .select({ id: notificationChannelConfigs.id })
        .from(notificationChannelConfigs);
      return ok(rows.length);
    });
  }
}

export class PostgresSettingsAccess implements SettingsAccess {
  constructor(private readonly db: AutoClaudeDb) {}

  async readGlobalSettings() {
    return unavailableOnThrow(async () => {
      const [row] = await this.db.select().from(globalSettings).limit(1);
      return row ? ok(row) : notFound('global settings were not found');
    });
  }

  async updateGlobalSettings(
    changes: Partial<typeof globalSettings.$inferSelect>,
  ) {
    return unavailableOnThrow(async () => {
      const [existing] = await this.db
        .select({ id: globalSettings.id })
        .from(globalSettings)
        .limit(1);
      if (!existing) return notFound('global settings were not found');

      const { id: _id, createdAt: _createdAt, ...updatable } = changes;
      const [row] = await this.db
        .update(globalSettings)
        .set({ ...withoutUndefined(updatable), updatedAt: new Date() })
        .where(eq(globalSettings.id, existing.id))
        .returning();
      return row
        ? ok(row)
        : unavailable('global settings update returned no row');
    });
  }
}

export class PostgresGitHubConnectionStore implements GitHubConnectionStore {
  constructor(private readonly db: AutoClaudeDb) {}

  async listOrganizations(connectionId: string) {
    return unavailableOnThrow(async () => {
      if (!(await connectionExists(this.db, connectionId))) {
        return notFound(`GitHub connection ${connectionId} was not found`);
      }

      const rows = await this.db
        .select()
        .from(githubOrgs)
        .where(eq(githubOrgs.connectionId, connectionId))
        .orderBy(githubOrgs.login);
      return ok(rows);
    });
  }
}

export function encodeCredentialEnvelope(envelope: CredentialEnvelope): Buffer {
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

export function decodeCredentialEnvelope(value: Buffer): CredentialEnvelope {
  const parsed = JSON.parse(value.toString('utf8')) as CredentialEnvelope;
  if (parsed.v !== 1) {
    throw new Error(
      `unsupported credential envelope version: ${String(parsed.v)}`,
    );
  }
  return parsed;
}

function repoCredentialAad(
  repositoryId: string,
  kind: CredentialMetadata['kind'],
): string {
  return `${repositoryId}:${kind}`;
}

async function repositoryExists(
  db: AutoClaudeDb,
  repositoryId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.id, repositoryId))
    .limit(1);
  return Boolean(row);
}

async function runExists(db: AutoClaudeDb, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return Boolean(row);
}

async function connectionExists(
  db: AutoClaudeDb,
  connectionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: githubConnections.id })
    .from(githubConnections)
    .where(eq(githubConnections.id, connectionId))
    .limit(1);
  return Boolean(row);
}

async function unavailableOnThrow<T>(
  operation: () => Promise<StoreResult<T>>,
): Promise<StoreResult<T>> {
  try {
    return await operation();
  } catch (error) {
    return unavailable(errorMessage(error));
  }
}

function ok(): StoreResult;
function ok<T>(value: T): StoreResult<T>;
function ok<T>(value?: T): StoreResult<T | void> {
  return { ok: true, value };
}

function notFound(message: string): StoreResult<never> {
  return { ok: false, error: 'not-found', message };
}

function denied(message: string): StoreResult<never> {
  return { ok: false, error: 'denied', message };
}

function unavailable(message: string): StoreResult<never> {
  return { ok: false, error: 'unavailable', message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asJsonRecord(
  value: Record<string, unknown>,
): Record<string, JsonValue> {
  return value as Record<string, JsonValue>;
}

function asUnknownRecord(
  value: Record<string, JsonValue>,
): Record<string, unknown> {
  return value;
}

function withoutUndefined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
