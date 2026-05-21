import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../drizzle/0001_operator_auth_tables.sql', import.meta.url),
  'utf8',
);

describe('operator auth migration', () => {
  it('creates the Better Auth table set through the Data Platform migrator', () => {
    expect(migration).toContain('CREATE TABLE "users"');
    expect(migration).toContain('CREATE TABLE "sessions"');
    expect(migration).toContain('CREATE TABLE "accounts"');
    expect(migration).toContain('CREATE TABLE "verifications"');
  });

  it('keeps auth sessions and accounts bound to users with cascade cleanup', () => {
    expect(migration).toContain(
      'ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk"',
    );
    expect(migration).toContain(
      'ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk"',
    );
    expect(migration).toContain('ON DELETE cascade');
  });

  it('creates unique indexes for email, session token, and provider account', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "users_email_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "sessions_token_key"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "accounts_provider_account_key"',
    );
  });
});
