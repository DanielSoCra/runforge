import { describe, expect, it } from 'vitest';

import {
  readBriefingDataBackendKind,
  validateBriefingDataBackendEnv,
} from './backend.js';

describe('briefing data backend config', () => {
  it('defaults to the existing Supabase backend', () => {
    expect(readBriefingDataBackendKind({})).toBe('supabase');
  });

  it('selects the Postgres backend explicitly', () => {
    expect(
      readBriefingDataBackendKind({ BRIEFING_DATA_BACKEND: 'postgres' }),
    ).toBe('postgres');
  });

  it('rejects unknown backend values', () => {
    expect(() =>
      readBriefingDataBackendKind({ BRIEFING_DATA_BACKEND: 'sqlite' }),
    ).toThrow(/BRIEFING_DATA_BACKEND/);
  });

  it('requires Supabase env only for the Supabase backend', () => {
    expect(() => validateBriefingDataBackendEnv({})).toThrow(/SUPABASE_URL/);
    expect(() =>
      validateBriefingDataBackendEnv({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      }),
    ).not.toThrow();
  });

  it('requires Postgres env only for the Postgres backend', () => {
    expect(() =>
      validateBriefingDataBackendEnv({ BRIEFING_DATA_BACKEND: 'postgres' }),
    ).toThrow(/AUTO_CLAUDE_DATABASE_URL/);
    expect(() =>
      validateBriefingDataBackendEnv({
        BRIEFING_DATA_BACKEND: 'postgres',
        AUTO_CLAUDE_DATABASE_URL:
          'postgres://postgres:postgres@localhost:5432/auto_claude',
      }),
    ).not.toThrow();
  });
});
