import { describe, expect, it } from 'vitest';

import { readDaemonDataBackendKind } from './backend-kind.js';

describe('readDaemonDataBackendKind', () => {
  it('defaults to auto for current Supabase-or-legacy behavior', () => {
    expect(readDaemonDataBackendKind({})).toBe('auto');
  });

  it('accepts explicit daemon data backends', () => {
    expect(readDaemonDataBackendKind({ DAEMON_DATA_BACKEND: 'postgres' })).toBe(
      'postgres',
    );
    expect(readDaemonDataBackendKind({ DAEMON_DATA_BACKEND: 'supabase' })).toBe(
      'supabase',
    );
    expect(readDaemonDataBackendKind({ DAEMON_DATA_BACKEND: 'legacy' })).toBe(
      'legacy',
    );
  });

  it('rejects unknown backend names', () => {
    expect(() =>
      readDaemonDataBackendKind({ DAEMON_DATA_BACKEND: 'sqlite' }),
    ).toThrow(/DAEMON_DATA_BACKEND/);
  });
});
