import { describe, expect, it } from 'vitest';

import { readDatabaseUrl } from './env.js';

describe('readDatabaseUrl', () => {
  it('returns AUTO_CLAUDE_DATABASE_URL when it is a valid URL', () => {
    expect(
      readDatabaseUrl({
        AUTO_CLAUDE_DATABASE_URL:
          'postgres://postgres:postgres@localhost:5432/auto_claude',
      }),
    ).toBe('postgres://postgres:postgres@localhost:5432/auto_claude');
  });

  it('fails when the project-owned database URL is absent', () => {
    expect(() => readDatabaseUrl({})).toThrow(/AUTO_CLAUDE_DATABASE_URL/);
  });

  it('fails when the database URL is malformed', () => {
    expect(() =>
      readDatabaseUrl({ AUTO_CLAUDE_DATABASE_URL: 'localhost:5432' }),
    ).toThrow(/valid URL/);
  });
});
