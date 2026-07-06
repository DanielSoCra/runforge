import { describe, expect, it } from 'vitest';

import {
  readBriefingDataBackendKind,
  validateBriefingDataBackendEnv,
} from './backend.js';

describe('briefing data backend config', () => {
  it('defaults to the Postgres backend', () => {
    expect(readBriefingDataBackendKind({})).toBe('postgres');
  });

  it('accepts the Postgres backend explicitly', () => {
    expect(
      readBriefingDataBackendKind({ BRIEFING_DATA_BACKEND: 'postgres' }),
    ).toBe('postgres');
  });

  it('rejects retired and unknown backend values', () => {
    expect(() =>
      readBriefingDataBackendKind({ BRIEFING_DATA_BACKEND: 'supabase' }),
    ).toThrow(/BRIEFING_DATA_BACKEND/);
    expect(() =>
      readBriefingDataBackendKind({ BRIEFING_DATA_BACKEND: 'sqlite' }),
    ).toThrow(/BRIEFING_DATA_BACKEND/);
  });

  it('requires Postgres connection env', () => {
    expect(() => validateBriefingDataBackendEnv({})).toThrow(
      /RUNFORGE_DATABASE_URL/,
    );
    expect(() =>
      validateBriefingDataBackendEnv({
        BRIEFING_DATA_BACKEND: 'postgres',
        RUNFORGE_DATABASE_URL:
          'postgres://postgres:postgres@localhost:5432/runforge',
      }),
    ).not.toThrow();
  });
});
