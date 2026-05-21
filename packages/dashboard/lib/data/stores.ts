import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import {
  decryptCredential,
  encryptCredential,
  readCredentialKey,
  type CredentialEnvelope,
} from '../../../db/src/credential-crypto';
import { readDatabaseUrl } from '../../../db/src/env';
import {
  apiKeys,
  authUsers,
  costEvents,
  githubConnections,
  githubOrgs,
  globalSettings,
  invitations,
  repoPlugins,
  repos,
  runs,
  teamMembers,
  type GlobalSettings,
  type Run,
} from '../../../db/src/schema';

type StoreUnavailable = {
  ok: false;
  error: 'unavailable';
  message: string;
};
type StoreNotFound = { ok: false; error: 'not-found'; message: string };
type StoreConflict = { ok: false; error: 'conflict'; message: string };
type StoreDenied = { ok: false; error: 'denied'; message: string };
type StoreOk<T = void> = { ok: true; value: T };
type StoreResult<T = void> =
  | StoreOk<T>
  | StoreUnavailable
  | StoreNotFound
  | StoreConflict
  | StoreDenied;

interface DashboardSettingsAccess {
  readGlobalSettings(): Promise<StoreResult<GlobalSettings>>;
  updateGlobalSettings(
    changes: Partial<GlobalSettings>,
  ): Promise<StoreResult<GlobalSettings>>;
}

type DashboardRepoCredentialKind =
  | 'source-control'
  | 'model-provider'
  | 'webhook-secret';

interface DashboardCredentialAccess {
  storeRepoCredential(
    repositoryId: string,
    kind: DashboardRepoCredentialKind,
    plaintext: string,
  ): Promise<StoreResult>;
}

export interface DashboardCostEvent {
  cost: number;
  recordedAt: Date;
  sessionType: string;
  repoOwner: string | null;
  repoName: string | null;
}

interface DashboardCostAccess {
  listCostEventsSince(
    since: Date,
  ): Promise<StoreResult<DashboardCostEvent[]>>;
}

export interface DashboardRunRow {
  id: string;
  repo_id: string | null;
  repo_owner: string;
  repo_name: string;
  issue_number: number;
  issue_title: string;
  pipeline_variant: string;
  current_phase: string | null;
  outcome: Run['outcome'];
  total_cost: number;
  phases: Run['phases'];
  fix_attempts: number;
  report: string | null;
  active_plugins: string[];
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

export interface DashboardOverview {
  activeRuns: number;
  todayCost: number;
  totalRepos: number;
  recentRuns: DashboardRunRow[];
  budgetByRepoId: Record<string, number | null>;
}

interface DashboardOverviewAccess {
  readOverview(todayUtc: Date): Promise<StoreResult<DashboardOverview>>;
}

export interface DashboardRunHistoryFilters {
  since: Date;
  repoId?: string;
  outcome?: Run['outcome'];
  limit?: number;
}

export interface DashboardRunFilterRepo {
  id: string;
  name: string;
  owner: string;
}

export interface DashboardRunHistory {
  runs: DashboardRunRow[];
  repos: DashboardRunFilterRepo[];
  budgetByRepoId: Record<string, number | null>;
}

export interface DashboardRunDetail {
  run: DashboardRunRow;
  budgetLimit: number | null;
}

interface DashboardRunAccess {
  listRunHistory(
    filters: DashboardRunHistoryFilters,
  ): Promise<StoreResult<DashboardRunHistory>>;
  listCompletedRuns(limit?: number): Promise<StoreResult<DashboardRunRow[]>>;
  readRunDetail(runId: string): Promise<StoreResult<DashboardRunDetail>>;
}

export interface DashboardIssueRepo {
  id: string;
  owner: string;
  name: string;
  connectionId: string | null;
}

export interface DashboardIssueRunRecord {
  issue_number: number;
  repo_owner: string;
  repo_name: string;
  issue_title: string;
  outcome: Run['outcome'];
  current_phase: string | null;
}

export interface DashboardIssueBoardInputs {
  repos: DashboardIssueRepo[];
  runs: DashboardIssueRunRecord[];
}

interface DashboardIssueAccess {
  listBoardInputs(): Promise<StoreResult<DashboardIssueBoardInputs>>;
}

export interface DashboardRepositoryListItem {
  id: string;
  owner: string;
  name: string;
  enabled: boolean;
  budget_limit: number | null;
  connection_id: string | null;
  github_status: string;
  credential_status: string;
  credential_error: string | null;
  github_connections: {
    display_name: string;
    github_login: string;
  } | null;
}

export interface DashboardRepositoryDetailItem {
  id: string;
  owner: string;
  name: string;
  enabled: boolean;
  staging_branch: string;
  production_branch: string;
  budget_limit: number | null;
  concurrency_limit: number;
}

export interface DashboardRepositoryCredentialMetadata {
  key_type: DashboardRepoCredentialKind;
  updated_at: string;
}

export interface DashboardRepositoryConnectionItem {
  id: string;
  display_name: string;
  github_login: string;
  status: string;
}

export interface DashboardRepositoryList {
  repos: DashboardRepositoryListItem[];
  connections: DashboardRepositoryConnectionItem[];
  activeCostByRepoId: Record<string, number>;
}

export interface DashboardRepositoryDetail {
  repo: DashboardRepositoryDetailItem;
  credentials: DashboardRepositoryCredentialMetadata[];
}

interface DashboardRepositoryAccess {
  listRepositories(): Promise<StoreResult<DashboardRepositoryList>>;
  readRepository(
    repositoryId: string,
  ): Promise<StoreResult<DashboardRepositoryDetail>>;
}

export interface DashboardTeamMember {
  id: string;
  role: 'admin' | 'viewer';
  granted_at: string;
  user: {
    email: string;
    name: string;
    image: string | null;
  } | null;
}

export interface DashboardPendingInvitation {
  id: string;
  provider_handle: string;
  role: 'admin' | 'viewer';
  created_at: string;
}

export interface DashboardTeamPageData {
  members: DashboardTeamMember[];
  invitations: DashboardPendingInvitation[];
}

export interface DashboardCreateInvitationInput {
  providerHandle: string;
  role: 'admin' | 'viewer';
  invitedBy: string;
}

interface DashboardTeamAccess {
  readTeamPage(options?: {
    includePendingInvitations?: boolean;
  }): Promise<StoreResult<DashboardTeamPageData>>;
  createInvitation(
    input: DashboardCreateInvitationInput,
  ): Promise<StoreResult>;
  changeMemberRole(
    memberId: string,
    newRole: 'admin' | 'viewer',
  ): Promise<StoreResult>;
  removeMember(memberId: string): Promise<StoreResult>;
}

export interface DashboardPluginRepo {
  id: string;
  owner: string;
  name: string;
}

export interface DashboardRepoPluginRecord {
  plugin_id: string;
  active: boolean;
  recommended: boolean;
  recommendation_reason: string | null;
  recommended_at: string | null;
  activated_at: string | null;
}

export interface DashboardRepositoryPlugins {
  repo: DashboardPluginRepo;
  plugins: DashboardRepoPluginRecord[];
}

interface DashboardPluginAccess {
  readRepositoryPlugins(
    repositoryId: string,
  ): Promise<StoreResult<DashboardRepositoryPlugins>>;
}

export interface DashboardGitHubConnection {
  id: string;
  displayName: string;
  githubLogin: string;
  avatarUrl: string | null;
  status: string;
  createdAt: Date;
  organizations: Array<{ login: string }>;
}

export interface DashboardGitHubOrg {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  isSelected: boolean;
}

export interface DashboardRepositoryImport {
  owner: string;
  name: string;
}

export interface DashboardGitHubOAuthOrg {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface DashboardGitHubOAuthConnection {
  displayName: string;
  githubLogin: string;
  avatarUrl: string | null;
  connectionType: string;
  scopes: string | null;
  createdBy: string;
  organizations: DashboardGitHubOAuthOrg[];
}

export interface DashboardGitHubCredential {
  githubLogin: string;
  token: string;
}

interface DashboardGitHubConnectionAccess {
  listConnections(): Promise<StoreResult<DashboardGitHubConnection[]>>;
  listOwnerOptions(): Promise<StoreResult<string[]>>;
  listOrganizations(
    connectionId: string,
  ): Promise<StoreResult<DashboardGitHubOrg[]>>;
  readCredential(
    connectionId: string,
  ): Promise<StoreResult<DashboardGitHubCredential>>;
  storeOAuthConnection(
    connection: DashboardGitHubOAuthConnection,
    plaintextToken: string,
  ): Promise<StoreResult<string>>;
  removeConnection(
    connectionId: string,
  ): Promise<StoreResult<{ disableError?: string }>>;
  importRepositories(
    connectionId: string,
    repositories: DashboardRepositoryImport[],
  ): Promise<StoreResult>;
  removeRepository(repoId: string, connectionId: string): Promise<StoreResult>;
}

export interface DashboardStores {
  settings: DashboardSettingsAccess;
  overview: DashboardOverviewAccess;
  runs: DashboardRunAccess;
  issues: DashboardIssueAccess;
  repositories: DashboardRepositoryAccess;
  team: DashboardTeamAccess;
  plugins: DashboardPluginAccess;
  costs: DashboardCostAccess;
  credentials: DashboardCredentialAccess;
  githubConnections: DashboardGitHubConnectionAccess;
}

type DashboardDb = ReturnType<typeof createDashboardDbClient>['db'];

const OPERATOR_MEMBERSHIP_LOCK_NAME = 'auto_claude_operator_membership';

let dashboardStores: DashboardStores | undefined;

export function getDashboardStores(): DashboardStores {
  if (!dashboardStores) {
    const db = getDashboardDbClient().db;
    dashboardStores = {
      settings: new DashboardSettingsStore(db),
      overview: new DashboardOverviewStore(db),
      runs: new DashboardRunStore(db),
      issues: new DashboardIssueStore(db),
      repositories: new DashboardRepositoryStore(db),
      team: new DashboardTeamStore(db),
      plugins: new DashboardPluginStore(db),
      costs: new DashboardCostStore(db),
      credentials: new DashboardCredentialStore(db),
      githubConnections: new DashboardGitHubConnectionStore(db),
    };
  }
  return dashboardStores;
}

class DashboardSettingsStore implements DashboardSettingsAccess {
  constructor(private readonly db: DashboardDb) {}

  async readGlobalSettings() {
    return unavailableOnThrow(async () => {
      const [row] = await this.db.select().from(globalSettings).limit(1);
      return row ? ok(row) : notFound('global settings were not found');
    });
  }

  async updateGlobalSettings(changes: Partial<GlobalSettings>) {
    return unavailableOnThrow(async () => {
      const [existing] = await this.db
        .select({ id: globalSettings.id })
        .from(globalSettings)
        .limit(1);
      if (!existing) return notFound('global settings were not found');

      const updatable = withoutUndefined({
        concurrencyLimit: changes.concurrencyLimit,
        dailyBudgetLimit: changes.dailyBudgetLimit,
        defaultModel: changes.defaultModel,
      });
      const [row] = await this.db
        .update(globalSettings)
        .set({ ...updatable, updatedAt: new Date() })
        .where(eq(globalSettings.id, existing.id))
        .returning();
      return row
        ? ok(row)
        : unavailable('global settings update returned no row');
    });
  }
}

class DashboardOverviewStore implements DashboardOverviewAccess {
  constructor(private readonly db: DashboardDb) {}

  async readOverview(todayUtc: Date) {
    return unavailableOnThrow(async () => {
      const [
        enabledRepoCount,
        recentRuns,
        todayCosts,
        activeRunCount,
        repoBudgets,
      ] = await Promise.all([
        this.db
          .select({ value: count() })
          .from(repos)
          .where(and(isNull(repos.deletedAt), eq(repos.enabled, true))),
        this.db.select().from(runs).orderBy(desc(runs.startedAt)).limit(10),
        this.db
          .select({ cost: costEvents.cost })
          .from(costEvents)
          .where(gte(costEvents.recordedAt, todayUtc)),
        this.db
          .select({ value: count() })
          .from(runs)
          .where(eq(runs.outcome, 'in-progress')),
        this.db
          .select({ id: repos.id, budgetLimit: repos.budgetLimit })
          .from(repos)
          .where(isNull(repos.deletedAt)),
      ]);

      const budgetByRepoId: Record<string, number | null> = {};
      for (const repo of repoBudgets) {
        budgetByRepoId[repo.id] = repo.budgetLimit;
      }

      return ok({
        activeRuns: activeRunCount[0]?.value ?? 0,
        todayCost: todayCosts.reduce(
          (sum, event) => sum + Number(event.cost),
          0,
        ),
        totalRepos: enabledRepoCount[0]?.value ?? 0,
        recentRuns: recentRuns.map(toDashboardRunRow),
        budgetByRepoId,
      });
    });
  }
}

class DashboardPluginStore implements DashboardPluginAccess {
  constructor(private readonly db: DashboardDb) {}

  async readRepositoryPlugins(repositoryId: string) {
    return unavailableOnThrow(async () => {
      const [repo] = await this.db
        .select({
          id: repos.id,
          owner: repos.owner,
          name: repos.name,
        })
        .from(repos)
        .where(and(eq(repos.id, repositoryId), isNull(repos.deletedAt)))
        .limit(1);
      if (!repo) return notFound(`repository ${repositoryId} was not found`);

      const plugins = await this.db
        .select({
          pluginId: repoPlugins.pluginId,
          active: repoPlugins.active,
          recommended: repoPlugins.recommended,
          recommendationReason: repoPlugins.recommendationReason,
          recommendedAt: repoPlugins.recommendedAt,
          activatedAt: repoPlugins.activatedAt,
        })
        .from(repoPlugins)
        .where(eq(repoPlugins.repoId, repositoryId));

      return ok({
        repo,
        plugins: plugins.map((plugin) => ({
          plugin_id: plugin.pluginId,
          active: plugin.active,
          recommended: plugin.recommended,
          recommendation_reason: plugin.recommendationReason,
          recommended_at: plugin.recommendedAt?.toISOString() ?? null,
          activated_at: plugin.activatedAt?.toISOString() ?? null,
        })),
      });
    });
  }
}

class DashboardTeamStore implements DashboardTeamAccess {
  constructor(private readonly db: DashboardDb) {}

  async readTeamPage(options: { includePendingInvitations?: boolean } = {}) {
    return unavailableOnThrow(async () => {
      const [memberRows, invitationRows] = await Promise.all([
        this.db
          .select({
            id: teamMembers.id,
            role: teamMembers.role,
            grantedAt: teamMembers.grantedAt,
            userEmail: authUsers.email,
            userName: authUsers.name,
            userImage: authUsers.image,
          })
          .from(teamMembers)
          .leftJoin(authUsers, eq(teamMembers.userId, authUsers.id))
          .orderBy(asc(teamMembers.grantedAt)),
        options.includePendingInvitations
          ? this.db
              .select({
                id: invitations.id,
                providerHandle: invitations.providerHandle,
                role: invitations.role,
                createdAt: invitations.createdAt,
              })
              .from(invitations)
              .where(eq(invitations.status, 'pending'))
              .orderBy(desc(invitations.createdAt))
          : Promise.resolve([]),
      ]);

      return ok({
        members: memberRows.map((member) => ({
          id: member.id,
          role: member.role,
          granted_at: member.grantedAt.toISOString(),
          user: member.userEmail
            ? {
                email: member.userEmail,
                name: member.userName ?? '',
                image: member.userImage,
              }
            : null,
        })),
        invitations: invitationRows.map((invitation) => ({
          id: invitation.id,
          provider_handle: invitation.providerHandle,
          role: invitation.role,
          created_at: invitation.createdAt.toISOString(),
        })),
      });
    });
  }

  async createInvitation(input: DashboardCreateInvitationInput) {
    return unavailableOnThrow(async () => {
      const [row] = await this.db
        .insert(invitations)
        .values({
          providerHandle: input.providerHandle,
          role: input.role,
          invitedBy: input.invitedBy,
          status: 'pending',
        })
        .onConflictDoNothing({
          target: [invitations.providerHandle, invitations.status],
        })
        .returning({ id: invitations.id });

      return row
        ? ok(undefined)
        : conflict('pending invitation already exists for this provider handle');
    });
  }

  async changeMemberRole(memberId: string, newRole: 'admin' | 'viewer') {
    return unavailableOnThrow(async () =>
      this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${OPERATOR_MEMBERSHIP_LOCK_NAME}))`,
        );

        const [member] = await tx
          .select({
            id: teamMembers.id,
            userId: teamMembers.userId,
            role: teamMembers.role,
          })
          .from(teamMembers)
          .where(eq(teamMembers.id, memberId))
          .limit(1);
        if (!member) return notFound('team member was not found');

        if (member.role === 'admin' && newRole === 'viewer') {
          const [adminCount] = await tx
            .select({ value: count() })
            .from(teamMembers)
            .where(eq(teamMembers.role, 'admin'));
          if ((adminCount?.value ?? 0) <= 1) {
            return conflict('at least one admin must remain');
          }
        }

        const [updated] = await tx
          .update(teamMembers)
          .set({ role: newRole })
          .where(eq(teamMembers.id, memberId))
          .returning({ id: teamMembers.id });
        if (!updated) return notFound('team member was not found');

        await tx
          .update(authUsers)
          .set({ role: newRole, updatedAt: new Date() })
          .where(eq(authUsers.id, member.userId));

        return ok(undefined);
      }),
    );
  }

  async removeMember(memberId: string) {
    return unavailableOnThrow(async () =>
      this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${OPERATOR_MEMBERSHIP_LOCK_NAME}))`,
        );

        const [member] = await tx
          .select({
            id: teamMembers.id,
            userId: teamMembers.userId,
            role: teamMembers.role,
          })
          .from(teamMembers)
          .where(eq(teamMembers.id, memberId))
          .limit(1);
        if (!member) return notFound('team member was not found');

        if (member.role === 'admin') {
          const [adminCount] = await tx
            .select({ value: count() })
            .from(teamMembers)
            .where(eq(teamMembers.role, 'admin'));
          if ((adminCount?.value ?? 0) <= 1) {
            return conflict('at least one admin must remain');
          }
        }

        const [removed] = await tx
          .delete(teamMembers)
          .where(eq(teamMembers.id, memberId))
          .returning({ id: teamMembers.id });
        if (!removed) return notFound('team member was not found');

        await tx
          .update(authUsers)
          .set({ role: 'viewer', updatedAt: new Date() })
          .where(eq(authUsers.id, member.userId));

        return ok(undefined);
      }),
    );
  }
}

class DashboardRepositoryStore implements DashboardRepositoryAccess {
  constructor(private readonly db: DashboardDb) {}

  async listRepositories() {
    return unavailableOnThrow(async () => {
      const [repoRows, connectionRows, activeRuns] = await Promise.all([
        this.db
          .select()
          .from(repos)
          .where(isNull(repos.deletedAt))
          .orderBy(desc(repos.createdAt)),
        this.db
          .select({
            id: githubConnections.id,
            displayName: githubConnections.displayName,
            githubLogin: githubConnections.githubLogin,
            status: githubConnections.status,
          })
          .from(githubConnections)
          .orderBy(githubConnections.createdAt),
        this.db
          .select({
            repoId: runs.repoId,
            totalCost: runs.totalCost,
          })
          .from(runs)
          .where(eq(runs.outcome, 'in-progress')),
      ]);

      const connectionById = new Map(
        connectionRows.map((connection) => [connection.id, connection]),
      );
      const activeCostByRepoId: Record<string, number> = {};
      for (const run of activeRuns) {
        if (!run.repoId) continue;
        const cost = Number(run.totalCost ?? 0);
        const current = activeCostByRepoId[run.repoId] ?? 0;
        if (cost > current) activeCostByRepoId[run.repoId] = cost;
      }

      return ok({
        repos: repoRows.map((repo) => {
          const connection = repo.connectionId
            ? connectionById.get(repo.connectionId)
            : undefined;
          return {
            id: repo.id,
            owner: repo.owner,
            name: repo.name,
            enabled: repo.enabled,
            budget_limit: repo.budgetLimit,
            connection_id: repo.connectionId,
            github_status: repo.githubStatus,
            credential_status: repo.credentialStatus,
            credential_error: repo.credentialError,
            github_connections: connection
              ? {
                  display_name: connection.displayName,
                  github_login: connection.githubLogin,
                }
              : null,
          };
        }),
        connections: connectionRows.map((connection) => ({
          id: connection.id,
          display_name: connection.displayName,
          github_login: connection.githubLogin,
          status: connection.status,
        })),
        activeCostByRepoId,
      });
    });
  }

  async readRepository(repositoryId: string) {
    return unavailableOnThrow(async () => {
      const [repo] = await this.db
        .select()
        .from(repos)
        .where(and(eq(repos.id, repositoryId), isNull(repos.deletedAt)))
        .limit(1);
      if (!repo) return notFound(`repository ${repositoryId} was not found`);

      const credentials = await this.db
        .select({
          keyType: apiKeys.keyType,
          updatedAt: apiKeys.updatedAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.repoId, repositoryId));

      return ok({
        repo: {
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
          enabled: repo.enabled,
          staging_branch: repo.stagingBranch,
          production_branch: repo.productionBranch,
          budget_limit: repo.budgetLimit,
          concurrency_limit: repo.concurrencyLimit,
        },
        credentials: credentials.map((credential) => ({
          key_type: credential.keyType,
          updated_at: credential.updatedAt.toISOString(),
        })),
      });
    });
  }
}

class DashboardIssueStore implements DashboardIssueAccess {
  constructor(private readonly db: DashboardDb) {}

  async listBoardInputs() {
    return unavailableOnThrow(async () => {
      const [repoRows, runRows] = await Promise.all([
        this.db
          .select({
            id: repos.id,
            owner: repos.owner,
            name: repos.name,
            connectionId: repos.connectionId,
          })
          .from(repos)
          .where(and(eq(repos.enabled, true), isNull(repos.deletedAt)))
          .orderBy(asc(repos.owner), asc(repos.name)),
        this.db
          .select({
            issueNumber: runs.issueNumber,
            repoOwner: runs.repoOwner,
            repoName: runs.repoName,
            issueTitle: runs.issueTitle,
            outcome: runs.outcome,
            currentPhase: runs.currentPhase,
          })
          .from(runs)
          .orderBy(desc(runs.startedAt)),
      ]);

      return ok({
        repos: repoRows,
        runs: runRows.map((run) => ({
          issue_number: run.issueNumber,
          repo_owner: run.repoOwner,
          repo_name: run.repoName,
          issue_title: run.issueTitle,
          outcome: run.outcome,
          current_phase: run.currentPhase,
        })),
      });
    });
  }
}

class DashboardRunStore implements DashboardRunAccess {
  constructor(private readonly db: DashboardDb) {}

  async listRunHistory(filters: DashboardRunHistoryFilters) {
    return unavailableOnThrow(async () => {
      const conditions = [gte(runs.startedAt, filters.since)];
      if (filters.repoId) {
        conditions.push(eq(runs.repoId, filters.repoId));
      }
      if (filters.outcome) {
        conditions.push(eq(runs.outcome, filters.outcome));
      }

      const [runRows, repoRows] = await Promise.all([
        this.db
          .select()
          .from(runs)
          .where(and(...conditions))
          .orderBy(desc(runs.startedAt))
          .limit(filters.limit ?? 100),
        this.db
          .select({
            id: repos.id,
            name: repos.name,
            owner: repos.owner,
            budgetLimit: repos.budgetLimit,
          })
          .from(repos)
          .where(isNull(repos.deletedAt))
          .orderBy(asc(repos.owner), asc(repos.name)),
      ]);

      const budgetByRepoId: Record<string, number | null> = {};
      for (const repo of repoRows) {
        budgetByRepoId[repo.id] = repo.budgetLimit;
      }

      return ok({
        runs: runRows.map(toDashboardRunRow),
        repos: repoRows.map(({ id, name, owner }) => ({ id, name, owner })),
        budgetByRepoId,
      });
    });
  }

  async readRunDetail(runId: string) {
    return unavailableOnThrow(async () => {
      const [run] = await this.db
        .select()
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      if (!run) return notFound(`run ${runId} was not found`);

      let budgetLimit: number | null = null;
      if (run.repoId) {
        const [repo] = await this.db
          .select({ budgetLimit: repos.budgetLimit })
          .from(repos)
          .where(eq(repos.id, run.repoId))
          .limit(1);
        budgetLimit = repo?.budgetLimit ?? null;
      }

      return ok({ run: toDashboardRunRow(run), budgetLimit });
    });
  }

  async listCompletedRuns(limit = 100) {
    return unavailableOnThrow(async () => {
      const runRows = await this.db
        .select()
        .from(runs)
        .where(eq(runs.outcome, 'complete'))
        .orderBy(desc(runs.completedAt))
        .limit(limit);

      return ok(runRows.map(toDashboardRunRow));
    });
  }
}

class DashboardCostStore implements DashboardCostAccess {
  constructor(private readonly db: DashboardDb) {}

  async listCostEventsSince(since: Date) {
    return unavailableOnThrow(async () => {
      const rows = await this.db
        .select({
          cost: costEvents.cost,
          recordedAt: costEvents.recordedAt,
          sessionType: costEvents.sessionType,
          repoOwner: runs.repoOwner,
          repoName: runs.repoName,
        })
        .from(costEvents)
        .leftJoin(runs, eq(costEvents.runId, runs.id))
        .where(gte(costEvents.recordedAt, since))
        .orderBy(costEvents.recordedAt);

      return ok(rows);
    });
  }
}

class DashboardCredentialStore implements DashboardCredentialAccess {
  constructor(private readonly db: DashboardDb) {}

  async storeRepoCredential(
    repositoryId: string,
    kind: DashboardRepoCredentialKind,
    plaintext: string,
  ) {
    return unavailableOnThrow(async () => {
      if (!(await repositoryExists(this.db, repositoryId))) {
        return notFound(`repository ${repositoryId} was not found`);
      }

      const encryptedValue = encodeCredentialEnvelope(
        encryptCredential(
          plaintext,
          readCredentialKey(),
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
        ? ok(undefined)
        : unavailable('repository credential upsert returned no row');
    });
  }
}

class DashboardGitHubConnectionStore
  implements DashboardGitHubConnectionAccess
{
  constructor(private readonly db: DashboardDb) {}

  async listConnections() {
    return unavailableOnThrow(async () => {
      const connections = await this.db
        .select({
          id: githubConnections.id,
          displayName: githubConnections.displayName,
          githubLogin: githubConnections.githubLogin,
          avatarUrl: githubConnections.avatarUrl,
          status: githubConnections.status,
          createdAt: githubConnections.createdAt,
        })
        .from(githubConnections)
        .orderBy(githubConnections.createdAt);

      if (connections.length === 0) return ok([]);

      const orgs = await this.db
        .select({
          connectionId: githubOrgs.connectionId,
          login: githubOrgs.login,
        })
        .from(githubOrgs)
        .where(
          inArray(
            githubOrgs.connectionId,
            connections.map((connection) => connection.id),
          ),
        )
        .orderBy(githubOrgs.login);

      const orgsByConnection = new Map<string, Array<{ login: string }>>();
      for (const org of orgs) {
        const entries = orgsByConnection.get(org.connectionId) ?? [];
        entries.push({ login: org.login });
        orgsByConnection.set(org.connectionId, entries);
      }

      return ok(
        connections.map((connection) => ({
          ...connection,
          organizations: orgsByConnection.get(connection.id) ?? [],
        })),
      );
    });
  }

  async listOwnerOptions() {
    return unavailableOnThrow(async () => {
      const [connections, orgs] = await Promise.all([
        this.db
          .select({ login: githubConnections.githubLogin })
          .from(githubConnections)
          .where(eq(githubConnections.status, 'active')),
        this.db.select({ login: githubOrgs.login }).from(githubOrgs),
      ]);

      return ok(
        Array.from(
          new Set([
            ...connections.map((connection) => connection.login),
            ...orgs.map((org) => org.login),
          ]),
        ).sort(),
      );
    });
  }

  async listOrganizations(connectionId: string) {
    return unavailableOnThrow(async () => {
      const orgs = await this.db
        .select({
          id: githubOrgs.id,
          login: githubOrgs.login,
          name: githubOrgs.name,
          avatarUrl: githubOrgs.avatarUrl,
          isSelected: githubOrgs.isSelected,
        })
        .from(githubOrgs)
        .where(eq(githubOrgs.connectionId, connectionId))
        .orderBy(githubOrgs.login);

      return ok(orgs);
    });
  }

  async readCredential(connectionId: string) {
    const selected = await unavailableOnThrow(async () => {
      const [row] = await this.db
        .select({
          encryptedToken: githubConnections.encryptedToken,
          githubLogin: githubConnections.githubLogin,
        })
        .from(githubConnections)
        .where(eq(githubConnections.id, connectionId))
        .limit(1);

      return row
        ? ok(row)
        : notFound(`GitHub connection ${connectionId} was not found`);
    });
    if (!selected.ok) return selected;

    try {
      return ok({
        githubLogin: selected.value.githubLogin,
        token: decryptCredential(
          decodeCredentialEnvelope(selected.value.encryptedToken),
          readCredentialKey(),
          connectionId,
        ),
      });
    } catch (error) {
      return denied(
        `GitHub connection ${connectionId} credential could not be decrypted: ${errorMessage(error)}`,
      );
    }
  }

  async storeOAuthConnection(
    connection: DashboardGitHubOAuthConnection,
    plaintextToken: string,
  ) {
    return unavailableOnThrow(async () => {
      const connectionId = randomUUID();
      const encryptedToken = encodeCredentialEnvelope(
        encryptCredential(plaintextToken, readCredentialKey(), connectionId),
      );

      await this.db.transaction(async (tx) => {
        await tx.insert(githubConnections).values({
          id: connectionId,
          displayName: connection.displayName,
          githubLogin: connection.githubLogin,
          avatarUrl: connection.avatarUrl,
          connectionType: connection.connectionType,
          encryptedToken,
          scopes: connection.scopes,
          createdBy: connection.createdBy,
        });

        if (connection.organizations.length > 0) {
          await tx
            .insert(githubOrgs)
            .values(
              connection.organizations.map((org) => ({
                connectionId,
                githubId: org.githubId,
                login: org.login,
                name: org.name,
                avatarUrl: org.avatarUrl,
              })),
            )
            .onConflictDoUpdate({
              target: [githubOrgs.connectionId, githubOrgs.githubId],
              set: {
                login: sql`excluded.login`,
                name: sql`excluded.name`,
                avatarUrl: sql`excluded.avatar_url`,
              },
            });
        }
      });

      return ok(connectionId);
    });
  }

  async removeConnection(connectionId: string) {
    return unavailableOnThrow(async () => {
      const linkedRepos = await this.db
        .select({ id: repos.id })
        .from(repos)
        .where(eq(repos.connectionId, connectionId));

      await this.db
        .delete(githubConnections)
        .where(eq(githubConnections.id, connectionId));

      let disableError: string | undefined;
      if (linkedRepos.length > 0) {
        try {
          await this.db
            .update(repos)
            .set({ enabled: false, updatedAt: new Date() })
            .where(
              inArray(
                repos.id,
                linkedRepos.map((repo) => repo.id),
              ),
            );
        } catch (error) {
          disableError = errorMessage(error);
        }
      }

      return ok({ disableError });
    });
  }

  async importRepositories(
    connectionId: string,
    repositories: DashboardRepositoryImport[],
  ) {
    return unavailableOnThrow(async () => {
      for (const repository of repositories) {
        await this.db
          .insert(repos)
          .values({
            owner: repository.owner,
            name: repository.name,
            connectionId,
            deletedAt: null,
            enabled: false,
          })
          .onConflictDoNothing({ target: [repos.owner, repos.name] });

        await this.db
          .update(repos)
          .set({
            connectionId,
            deletedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(repos.owner, repository.owner),
              eq(repos.name, repository.name),
            ),
          );
      }

      return ok(undefined);
    });
  }

  async removeRepository(repoId: string, connectionId: string) {
    return unavailableOnThrow(async () => {
      const [repo] = await this.db
        .select({ enabled: repos.enabled })
        .from(repos)
        .where(and(eq(repos.id, repoId), eq(repos.connectionId, connectionId)))
        .limit(1);
      if (!repo) return notFound('repository was not found');
      if (repo.enabled) {
        return conflict('enabled repositories must be disabled before removal');
      }

      await this.db
        .update(repos)
        .set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() })
        .where(and(eq(repos.id, repoId), eq(repos.connectionId, connectionId)));

      return ok(undefined);
    });
  }
}

function createDashboardDbClient() {
  const sql = postgres(readDatabaseUrl(), { max: 14 });
  const db = drizzle(sql, {
    schema: {
      apiKeys,
      authUsers,
      costEvents,
      githubConnections,
      githubOrgs,
      globalSettings,
      invitations,
      repoPlugins,
      repos,
      runs,
      teamMembers,
    },
  });
  return { db, sql };
}

let dashboardDbClient: ReturnType<typeof createDashboardDbClient> | undefined;

function getDashboardDbClient() {
  dashboardDbClient ??= createDashboardDbClient();
  return dashboardDbClient;
}

function toDashboardRunRow(run: Run): DashboardRunRow {
  return {
    id: run.id,
    repo_id: run.repoId,
    repo_owner: run.repoOwner,
    repo_name: run.repoName,
    issue_number: run.issueNumber,
    issue_title: run.issueTitle,
    pipeline_variant: run.pipelineVariant,
    current_phase: run.currentPhase,
    outcome: run.outcome,
    total_cost: run.totalCost,
    phases: run.phases,
    fix_attempts: run.fixAttempts,
    report: run.report,
    active_plugins: run.activePlugins,
    started_at: run.startedAt.toISOString(),
    completed_at: run.completedAt?.toISOString() ?? null,
    updated_at: run.updatedAt.toISOString(),
  };
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

function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function notFound(message: string): StoreResult<never> {
  return { ok: false, error: 'not-found', message };
}

function conflict(message: string): StoreResult<never> {
  return { ok: false, error: 'conflict', message };
}

function denied(message: string): StoreResult<never> {
  return { ok: false, error: 'denied', message };
}

function unavailable(message: string): StoreResult<never> {
  return { ok: false, error: 'unavailable', message };
}

function encodeCredentialEnvelope(envelope: CredentialEnvelope): Buffer {
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

function decodeCredentialEnvelope(value: Buffer): CredentialEnvelope {
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
  kind: DashboardRepoCredentialKind,
): string {
  return `${repositoryId}:${kind}`;
}

async function repositoryExists(
  db: DashboardDb,
  repositoryId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.id, repositoryId))
    .limit(1);
  return Boolean(row);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withoutUndefined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
