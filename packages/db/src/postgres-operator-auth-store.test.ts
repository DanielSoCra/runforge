import { describe, expect, it, vi } from 'vitest';

import type { AutoClaudeDb } from './client.js';
import { PostgresOperatorAuthStore } from './postgres-stores.js';
import { authUsers, teamMembers } from './schema.js';
import type { OperatorRole } from './stores.js';

interface FakeUser {
  id: string;
  role: OperatorRole;
  updatedAt?: Date;
}

interface FakeMembership {
  id: string;
  userId: string;
  role: OperatorRole;
  grantedAt: Date;
}

interface FakeDbState {
  users: Map<string, FakeUser>;
  memberships: Map<string, FakeMembership>;
}

describe('PostgresOperatorAuthStore', () => {
  it('reads an existing membership without exposing storage internals', async () => {
    const grantedAt = new Date('2026-01-02T03:04:05.000Z');
    const { db } = createFakeOperatorAuthDb({
      memberships: [
        { id: 'membership-1', userId: 'user-1', role: 'viewer', grantedAt },
      ],
    });

    await expect(
      new PostgresOperatorAuthStore(db).readMembership('user-1'),
    ).resolves.toEqual({
      ok: true,
      value: { userId: 'user-1', role: 'viewer', grantedAt },
    });
  });

  it('keeps the auth user role and team membership role in sync', async () => {
    const { db, state, tx } = createFakeOperatorAuthDb({
      users: [{ id: 'user-1', role: 'viewer' }],
    });

    const result = await new PostgresOperatorAuthStore(db).setMembership(
      'user-1',
      'admin',
    );

    expect(result.ok).toBe(true);
    expect(state.users.get('user-1')?.role).toBe('admin');
    expect(state.memberships.get('user-1')?.role).toBe('admin');
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses membership changes for unknown auth users', async () => {
    const { db, state } = createFakeOperatorAuthDb();

    await expect(
      new PostgresOperatorAuthStore(db).setMembership('missing-user', 'admin'),
    ).resolves.toEqual({
      ok: false,
      error: 'not-found',
      message: 'operator user missing-user was not found',
    });
    expect(state.memberships.size).toBe(0);
  });

  it('bootstraps the first administrator once', async () => {
    const { db, state, tx } = createFakeOperatorAuthDb({
      users: [{ id: 'user-1', role: 'viewer' }],
    });

    const result =
      await new PostgresOperatorAuthStore(db).bootstrapFirstAdmin('user-1');

    expect(result.ok).toBe(true);
    expect(state.users.get('user-1')?.role).toBe('admin');
    expect(state.memberships.get('user-1')?.role).toBe('admin');
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('denies first-administrator bootstrap after any membership exists', async () => {
    const grantedAt = new Date('2026-01-02T03:04:05.000Z');
    const { db, state } = createFakeOperatorAuthDb({
      users: [{ id: 'user-2', role: 'viewer' }],
      memberships: [
        { id: 'membership-1', userId: 'user-1', role: 'admin', grantedAt },
      ],
    });

    await expect(
      new PostgresOperatorAuthStore(db).bootstrapFirstAdmin('user-2'),
    ).resolves.toEqual({
      ok: false,
      error: 'denied',
      message: 'first administrator already exists',
    });
    expect(state.memberships.size).toBe(1);
    expect(state.users.get('user-2')?.role).toBe('viewer');
  });
});

function createFakeOperatorAuthDb(input: {
  users?: FakeUser[];
  memberships?: FakeMembership[];
} = {}) {
  const state: FakeDbState = {
    users: new Map((input.users ?? []).map((user) => [user.id, user])),
    memberships: new Map(
      (input.memberships ?? []).map((membership) => [
        membership.userId,
        membership,
      ]),
    ),
  };
  const tx = createFakeDbApi(state);
  const db = {
    ...createFakeDbApi(state),
    transaction: vi.fn(
      async (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx),
    ),
  };

  return { db: db as unknown as AutoClaudeDb, state, tx };
}

function createFakeDbApi(state: FakeDbState) {
  return {
    select: vi.fn((selection?: unknown) => ({
      from: vi.fn((table: unknown) => createSelectQuery(state, table, selection)),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) =>
        createInsertQuery(state, table, values),
      ),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => updateRows(state, table, values)),
        })),
      })),
    })),
    execute: vi.fn(async () => undefined),
  };
}

function createSelectQuery(
  state: FakeDbState,
  table: unknown,
  selection: unknown,
) {
  const rows = () => selectRows(state, table, selection);
  return {
    where: vi.fn(() => ({
      limit: vi.fn(async (limit: number) => rows().slice(0, limit)),
    })),
    limit: vi.fn(async (limit: number) => rows().slice(0, limit)),
    then: (
      onfulfilled?: ((value: unknown[]) => unknown) | null,
      onrejected?: ((reason: unknown) => unknown) | null,
    ) => Promise.resolve(rows()).then(onfulfilled, onrejected),
  };
}

function selectRows(
  state: FakeDbState,
  table: unknown,
  selection: unknown,
): unknown[] {
  if (table === authUsers) {
    return Array.from(state.users.values()).map((user) => ({ id: user.id }));
  }
  if (table === teamMembers && isCountSelection(selection)) {
    return [{ value: state.memberships.size }];
  }
  if (table === teamMembers) {
    return Array.from(state.memberships.values());
  }
  return [];
}

function createInsertQuery(
  state: FakeDbState,
  table: unknown,
  values: Record<string, unknown>,
) {
  return {
    onConflictDoUpdate: vi.fn(() => ({
      returning: vi.fn(async () => upsertMembershipRows(state, table, values)),
    })),
    onConflictDoNothing: vi.fn(() => ({
      returning: vi.fn(async () =>
        insertMembershipRowsIfAbsent(state, table, values),
      ),
    })),
    returning: vi.fn(async () => upsertMembershipRows(state, table, values)),
  };
}

function upsertMembershipRows(
  state: FakeDbState,
  table: unknown,
  values: Record<string, unknown>,
): unknown[] {
  if (table !== teamMembers) return [];
  const row = membershipFromValues(state, values);
  state.memberships.set(row.userId, row);
  return [row];
}

function insertMembershipRowsIfAbsent(
  state: FakeDbState,
  table: unknown,
  values: Record<string, unknown>,
): unknown[] {
  if (table !== teamMembers) return [];
  const userId = String(values.userId);
  if (state.memberships.has(userId)) return [];
  const row = membershipFromValues(state, values);
  state.memberships.set(row.userId, row);
  return [row];
}

function updateRows(
  state: FakeDbState,
  table: unknown,
  values: Record<string, unknown>,
): unknown[] {
  if (table !== authUsers) return [];
  const user = Array.from(state.users.values())[0];
  if (!user) return [];
  user.role = values.role as OperatorRole;
  user.updatedAt = values.updatedAt as Date;
  return [{ id: user.id }];
}

function membershipFromValues(
  state: FakeDbState,
  values: Record<string, unknown>,
): FakeMembership {
  const userId = String(values.userId);
  const existing = state.memberships.get(userId);
  return {
    id: existing?.id ?? `membership-${state.memberships.size + 1}`,
    userId,
    role: values.role as OperatorRole,
    grantedAt:
      values.grantedAt instanceof Date ? values.grantedAt : new Date(),
  };
}

function isCountSelection(selection: unknown): boolean {
  return (
    typeof selection === 'object' && selection !== null && 'value' in selection
  );
}
