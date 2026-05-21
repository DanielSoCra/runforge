import { describe, expect, it, vi } from 'vitest';

import {
  SupabaseRunWriter,
  toDbOutcome,
  toDbSessionType,
} from './run-writer.js';

describe('retired Supabase run-writer mapping exports', () => {
  it('re-exports outcome mapping from the Postgres writer', () => {
    expect(toDbOutcome('complete')).toBe('complete');
    expect(toDbOutcome('stuck')).toBe('stuck');
    expect(toDbOutcome('paused')).toBe('in-progress');
    expect(toDbOutcome('parked')).toBe('in-progress');
    expect(toDbOutcome('error')).toBe('failed');
    expect(toDbOutcome('failed')).toBe('failed');
  });

  it('re-exports session type mapping from the Postgres writer', () => {
    expect(toDbSessionType('coordinator')).toBe('planning');
    expect(toDbSessionType('worker')).toBe('implementation');
    expect(toDbSessionType('reviewer-quality')).toBe('validation');
    expect(toDbSessionType('diagnostician')).toBe('diagnosis');
    expect(toDbSessionType('tech-lead')).toBe('planning');
    expect(() => toDbSessionType('nonexistent' as never)).toThrow(
      'Unknown session type',
    );
  });
});

describe('SupabaseRunWriter retired shim', () => {
  it('does not write and logs a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writer = new SupabaseRunWriter();

    await writer.insertRun();
    await writer.upsertRun();
    await writer.writeCostEvent();

    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});
