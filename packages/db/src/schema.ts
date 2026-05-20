import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue | undefined }
  | JsonValue[];

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const runOutcomeEnum = pgEnum('run_outcome', [
  'in-progress',
  'complete',
  'stuck',
  'escalated',
  'failed',
]);
export const teamRoleEnum = pgEnum('team_role', ['admin', 'viewer']);
export const keyTypeEnum = pgEnum('key_type', [
  'source-control',
  'model-provider',
  'webhook-secret',
]);
export const sessionTypeEnum = pgEnum('session_type', [
  'planning',
  'implementation',
  'validation',
  'diagnosis',
  'fix',
]);
export const inviteStatusEnum = pgEnum('invite_status', [
  'pending',
  'accepted',
]);
export const matrixStatusEnum = pgEnum('matrix_status', [
  'ok',
  'degraded',
  'failed',
]);
export const activityEventTypeEnum = pgEnum('activity_event_type', [
  'state-transition',
  'merge',
  'error',
  'heartbeat',
  'completion',
]);
export const activitySeverityEnum = pgEnum('activity_severity', [
  'info',
  'warning',
  'error',
]);
export const notificationChannelTypeEnum = pgEnum('notification_channel_type', [
  'web-push',
  'slack',
  'macos',
  'webhook',
]);
export const notificationEventKindEnum = pgEnum('notification_event_kind', [
  'attention-required',
  'work-completed',
  'error',
  'digest',
]);

export const globalSettings = pgTable('global_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  concurrencyLimit: integer('concurrency_limit').notNull().default(3),
  dailyBudgetLimit: numeric('daily_budget_limit', {
    precision: 10,
    scale: 4,
    mode: 'number',
  }),
  defaultModel: text('default_model').notNull().default('claude-sonnet-4-6'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const authUsers = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    name: text('name').notNull().default(''),
    image: text('image'),
    role: teamRoleEnum('role').notNull().default('viewer'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    emailUnique: uniqueIndex('users_email_key').on(table.email),
    roleIdx: index('idx_users_role').on(table.role),
  }),
);

export const authSessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tokenUnique: uniqueIndex('sessions_token_key').on(table.token),
    userIdx: index('idx_sessions_user_id').on(table.userId),
  }),
);

export const authAccounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    providerAccountUnique: uniqueIndex('accounts_provider_account_key').on(
      table.providerId,
      table.accountId,
    ),
    userIdx: index('idx_accounts_user_id').on(table.userId),
  }),
);

export const authVerifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    identifierIdx: index('idx_verifications_identifier').on(table.identifier),
  }),
);

export const githubConnections = pgTable('github_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  githubLogin: text('github_login').notNull(),
  avatarUrl: text('avatar_url'),
  connectionType: text('connection_type').notNull().default('oauth_token'),
  encryptedToken: bytea('encrypted_token').notNull(),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scopes: text('scopes'),
  status: text('status').notNull().default('active'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const repos = pgTable(
  'repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    stagingBranch: text('staging_branch').notNull().default('staging'),
    productionBranch: text('production_branch').notNull().default('main'),
    budgetLimit: numeric('budget_limit', {
      precision: 10,
      scale: 4,
      mode: 'number',
    }),
    concurrencyLimit: integer('concurrency_limit').notNull().default(1),
    pollIntervalMs: integer('poll_interval_ms'),
    connectionId: uuid('connection_id').references(() => githubConnections.id, {
      onDelete: 'set null',
    }),
    githubStatus: text('github_status').notNull().default('ok'),
    matrixStatus: matrixStatusEnum('matrix_status').notNull().default('ok'),
    credentialStatus: text('credential_status').notNull().default('ok'),
    credentialError: text('credential_error'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    ownerNameUnique: uniqueIndex('repos_owner_name_key').on(
      table.owner,
      table.name,
    ),
    enabledIdx: index('idx_repos_enabled')
      .on(table.enabled)
      .where(sql`${table.deletedAt} IS NULL`),
    connectionIdx: index('idx_repos_connection_id')
      .on(table.connectionId)
      .where(sql`${table.connectionId} IS NOT NULL`),
    credentialStatusCheck: check(
      'repos_credential_status_check',
      sql`${table.credentialStatus} IN ('ok', 'error')`,
    ),
  }),
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    keyType: keyTypeEnum('key_type').notNull(),
    encryptedValue: bytea('encrypted_value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    repoKindUnique: uniqueIndex('api_keys_repo_id_key_type_key').on(
      table.repoId,
      table.keyType,
    ),
  }),
);

export const teamMembers = pgTable(
  'team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    role: teamRoleEnum('role').notNull().default('viewer'),
    grantedAt: timestamp('granted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userUnique: uniqueIndex('team_members_user_id_key').on(table.userId),
  }),
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerHandle: text('provider_handle').notNull(),
    role: teamRoleEnum('role').notNull().default('viewer'),
    invitedBy: uuid('invited_by'),
    status: inviteStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    providerStatusUnique: uniqueIndex(
      'invitations_provider_handle_status_key',
    ).on(table.providerHandle, table.status),
  }),
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id').references(() => repos.id, {
      onDelete: 'set null',
    }),
    repoOwner: text('repo_owner').notNull(),
    repoName: text('repo_name').notNull(),
    issueNumber: integer('issue_number').notNull(),
    issueTitle: text('issue_title').notNull(),
    pipelineVariant: text('pipeline_variant').notNull().default('standard'),
    currentPhase: text('current_phase'),
    outcome: runOutcomeEnum('outcome').notNull().default('in-progress'),
    totalCost: numeric('total_cost', {
      precision: 10,
      scale: 6,
      mode: 'number',
    })
      .notNull()
      .default(0),
    phases: jsonb('phases').$type<JsonValue>().notNull().default([]),
    fixAttempts: integer('fix_attempts').notNull().default(0),
    report: text('report'),
    activePlugins: text('active_plugins')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    repoIdx: index('idx_runs_repo_id').on(table.repoId),
    startedAtIdx: index('idx_runs_started_at').on(table.startedAt.desc()),
    updatedAtIdx: index('idx_runs_updated_at').on(table.updatedAt.desc()),
  }),
);

export const costEvents = pgTable(
  'cost_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sessionType: sessionTypeEnum('session_type').notNull(),
    cost: numeric('cost', {
      precision: 10,
      scale: 6,
      mode: 'number',
    }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runIdx: index('idx_cost_events_run_id').on(table.runId),
    recordedAtIdx: index('idx_cost_events_recorded_at').on(
      table.recordedAt.desc(),
    ),
  }),
);

export const repoPlugins = pgTable(
  'repo_plugins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    pluginId: text('plugin_id').notNull(),
    active: boolean('active').notNull().default(false),
    recommended: boolean('recommended').notNull().default(false),
    recommendationReason: text('recommendation_reason'),
    recommendedAt: timestamp('recommended_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    config: jsonb('config')
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default({}),
  },
  (table) => ({
    repoPluginUnique: uniqueIndex('repo_plugins_repo_id_plugin_id_key').on(
      table.repoId,
      table.pluginId,
    ),
    repoIdx: index('idx_repo_plugins_repo_id').on(table.repoId),
    activeIdx: index('idx_repo_plugins_active')
      .on(table.repoId, table.active)
      .where(sql`${table.active} = true`),
  }),
);

export const pluginGlobalSettings = pgTable(
  'plugin_global_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pluginId: text('plugin_id').notNull(),
    settings: jsonb('settings')
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => ({
    pluginIdUnique: uniqueIndex('plugin_global_settings_plugin_id_key').on(
      table.pluginId,
    ),
    pluginIdIdx: index('idx_plugin_global_settings_plugin_id').on(
      table.pluginId,
    ),
  }),
);

export const githubOrgs = pgTable(
  'github_orgs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => githubConnections.id, { onDelete: 'cascade' }),
    githubId: bigint('github_id', { mode: 'number' }).notNull(),
    login: text('login').notNull(),
    name: text('name'),
    avatarUrl: text('avatar_url'),
    isSelected: boolean('is_selected').notNull().default(false),
  },
  (table) => ({
    connectionGithubUnique: uniqueIndex(
      'github_orgs_connection_id_github_id_key',
    ).on(table.connectionId, table.githubId),
    connectionIdx: index('idx_github_orgs_connection_id').on(
      table.connectionId,
    ),
  }),
);

export const briefings = pgTable(
  'briefings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    statusLine: text('status_line').notNull(),
    changes: jsonb('changes').$type<JsonValue>().notNull().default([]),
    attention: jsonb('attention').$type<JsonValue>().notNull().default([]),
    forecast: text('forecast').notNull(),
    signalSnapshot: jsonb('signal_snapshot')
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default({}),
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    generatedAtIdx: index('idx_briefings_generated_at').on(
      table.generatedAt.desc(),
    ),
  }),
);

export const activityEvents = pgTable(
  'activity_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    eventType: activityEventTypeEnum('event_type').notNull(),
    severity: activitySeverityEnum('severity').notNull().default('info'),
    summary: text('summary').notNull(),
    links: jsonb('links').$type<JsonValue>().notNull().default([]),
  },
  (table) => ({
    occurredAtIdx: index('idx_activity_events_occurred_at').on(
      table.occurredAt.desc(),
    ),
  }),
);

export const notificationChannelConfigs = pgTable(
  'notification_channel_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelType: notificationChannelTypeEnum('channel_type').notNull(),
    target: text('target').notNull().default(''),
    events: notificationEventKindEnum('events')
      .array()
      .notNull()
      .default(sql`'{}'::notification_event_kind[]`),
  },
);

export type GlobalSettings = typeof globalSettings.$inferSelect;
export type Repository = typeof repos.$inferSelect;
export type RepositoryInsert = typeof repos.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type RunInsert = typeof runs.$inferInsert;
export type CostEvent = typeof costEvents.$inferSelect;
export type RepoPlugin = typeof repoPlugins.$inferSelect;
export type PluginGlobalSettings = typeof pluginGlobalSettings.$inferSelect;
export type GitHubConnection = typeof githubConnections.$inferSelect;
export type GitHubOrg = typeof githubOrgs.$inferSelect;
export type Briefing = typeof briefings.$inferSelect;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type AuthAccount = typeof authAccounts.$inferSelect;
export type AuthSession = typeof authSessions.$inferSelect;
export type AuthUser = typeof authUsers.$inferSelect;
export type AuthVerification = typeof authVerifications.$inferSelect;
