import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  apiKeys,
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  briefings,
  costEvents,
  githubConnections,
  githubOrgs,
  globalSettings,
  keyTypeEnum,
  matrixStatusEnum,
  pluginGlobalSettings,
  repoPlugins,
  repos,
  runOutcomeEnum,
  runs,
  teamRoleEnum,
} from './schema.js';

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((column) => column.name);
}

describe('schema parity foundation', () => {
  it('keeps later repository and run fields from the full legacy migration history', () => {
    expect(columnNames(repos)).toEqual(
      expect.arrayContaining([
        'connection_id',
        'github_status',
        'matrix_status',
        'credential_status',
        'credential_error',
      ]),
    );
    expect(columnNames(runs)).toEqual(
      expect.arrayContaining([
        'active_plugins',
        'updated_at',
        'outcome',
        'phases',
        'fix_attempts',
      ]),
    );
  });

  it('keeps plugin, GitHub connection, briefing, settings, and credential tables', () => {
    expect(columnNames(globalSettings)).toEqual(
      expect.arrayContaining(['daily_budget_limit', 'default_model']),
    );
    expect(columnNames(apiKeys)).toEqual(
      expect.arrayContaining(['repo_id', 'key_type', 'encrypted_value']),
    );
    expect(columnNames(githubConnections)).toEqual(
      expect.arrayContaining(['encrypted_token', 'status', 'token_expires_at']),
    );
    expect(columnNames(githubOrgs)).toEqual(
      expect.arrayContaining(['connection_id', 'github_id', 'is_selected']),
    );
    expect(columnNames(repoPlugins)).toEqual(
      expect.arrayContaining(['active', 'recommended', 'config']),
    );
    expect(columnNames(pluginGlobalSettings)).toEqual(
      expect.arrayContaining(['plugin_id', 'settings']),
    );
    expect(columnNames(briefings)).toEqual(
      expect.arrayContaining(['status_line', 'signal_snapshot']),
    );
    expect(columnNames(costEvents)).toEqual(
      expect.arrayContaining([
        'run_id',
        'session_type',
        'cost',
        // Spend attribution — project-owned drizzle migration 0002, not part
        // of the 13 legacy supabase files (STACK-AC-DATA-PLATFORM gotcha).
        'provider',
        'usage_units',
      ]),
    );
  });

  it('keeps enum values added after the initial migration', () => {
    expect(runOutcomeEnum.enumValues).toContain('failed');
    expect(keyTypeEnum.enumValues).toContain('webhook-secret');
    expect(matrixStatusEnum.enumValues).toEqual(['ok', 'degraded', 'failed']);
  });

  it('defines Better Auth tables in the project-owned schema', () => {
    expect(columnNames(authUsers)).toEqual(
      expect.arrayContaining([
        'email',
        'email_verified',
        'name',
        'image',
        'role',
      ]),
    );
    expect(columnNames(authSessions)).toEqual(
      expect.arrayContaining([
        'user_id',
        'token',
        'expires_at',
        'ip_address',
        'user_agent',
      ]),
    );
    expect(columnNames(authAccounts)).toEqual(
      expect.arrayContaining([
        'user_id',
        'account_id',
        'provider_id',
        'access_token',
        'refresh_token',
        'id_token',
        'password',
      ]),
    );
    expect(columnNames(authVerifications)).toEqual(
      expect.arrayContaining(['identifier', 'value', 'expires_at']),
    );
  });

  it('keeps the current admin/viewer role vocabulary for auth continuity', () => {
    expect(teamRoleEnum.enumValues).toEqual(['admin', 'viewer']);
  });
});
