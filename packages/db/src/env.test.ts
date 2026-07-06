import { describe, expect, it } from 'vitest';

import { readDatabaseUrl } from './env.js';

describe('readDatabaseUrl', () => {
  it('returns RUNFORGE_DATABASE_URL when it is a valid URL', () => {
    expect(
      readDatabaseUrl({
        RUNFORGE_DATABASE_URL:
          'postgres://postgres:postgres@localhost:5432/runforge',
      }),
    ).toBe('postgres://postgres:postgres@localhost:5432/runforge');
  });

  it('fails when the project-owned database URL is absent', () => {
    expect(() => readDatabaseUrl({})).toThrow(/RUNFORGE_DATABASE_URL/);
  });

  it('fails when the database URL is malformed', () => {
    expect(() =>
      readDatabaseUrl({ RUNFORGE_DATABASE_URL: 'localhost:5432' }),
    ).toThrow(/valid URL/);
  });
});
