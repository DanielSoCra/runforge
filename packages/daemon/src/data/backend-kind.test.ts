import { describe, expect, it } from 'vitest';

import { readDaemonDataBackendKind } from './backend-kind.js';

describe('readDaemonDataBackendKind', () => {
  it('defaults to the Postgres backend', () => {
    expect(readDaemonDataBackendKind({})).toBe('postgres');
  });

  it('accepts the Postgres backend explicitly', () => {
    expect(readDaemonDataBackendKind({ DAEMON_DATA_BACKEND: 'postgres' })).toBe(
      'postgres',
    );
  });

  it('rejects retired and unknown backend names', () => {
    expect(() =>
      readDaemonDataBackendKind({ DAEMON_DATA_BACKEND: 'supabase' }),
    ).toThrow(/DAEMON_DATA_BACKEND/);
    expect(() =>
      readDaemonDataBackendKind({ DAEMON_DATA_BACKEND: 'legacy' }),
    ).toThrow(/DAEMON_DATA_BACKEND/);
    expect(() =>
      readDaemonDataBackendKind({ DAEMON_DATA_BACKEND: 'auto' }),
    ).toThrow(/DAEMON_DATA_BACKEND/);
    expect(() =>
      readDaemonDataBackendKind({ DAEMON_DATA_BACKEND: 'sqlite' }),
    ).toThrow(/DAEMON_DATA_BACKEND/);
  });
});
