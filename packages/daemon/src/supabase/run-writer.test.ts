import { describe, it, expect, vi } from 'vitest';
import { SupabaseRunWriter, toDbOutcome, toDbSessionType } from './run-writer.js';

describe('toDbOutcome', () => {
  it('maps complete → complete', () => expect(toDbOutcome('complete')).toBe('complete'));
  it('maps stuck → stuck',       () => expect(toDbOutcome('stuck')).toBe('stuck'));
  it('maps paused → in-progress', () => expect(toDbOutcome('paused')).toBe('in-progress'));
  it('maps error → in-progress',  () => expect(toDbOutcome('error')).toBe('in-progress'));
});

describe('toDbSessionType', () => {
  it('maps coordinator → planning',       () => expect(toDbSessionType('coordinator')).toBe('planning'));
  it('maps worker → implementation',      () => expect(toDbSessionType('worker')).toBe('implementation'));
  it('maps reviewer-spec → validation',   () => expect(toDbSessionType('reviewer-spec')).toBe('validation'));
  it('maps diagnostician → diagnosis',    () => expect(toDbSessionType('diagnostician')).toBe('diagnosis'));
  it('maps reporter → validation',        () => expect(toDbSessionType('reporter')).toBe('validation'));
});

describe('SupabaseRunWriter', () => {
  const makeClient = (upsertResult = { error: null }, insertResult = { error: null }) => ({
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'runs') {
        return { upsert: vi.fn().mockResolvedValue(upsertResult) };
      }
      return { insert: vi.fn().mockResolvedValue(insertResult) };
    }),
  });

  it('upsertRun calls supabase.from("runs").upsert with the patch', async () => {
    const client = makeClient();
    const writer = new SupabaseRunWriter(client as any);
    await writer.upsertRun('run-1', { outcome: 'in-progress', repo_owner: 'org', repo_name: 'repo' });
    expect(client.from).toHaveBeenCalledWith('runs');
  });

  it('upsertRun logs warning on error, does not throw', async () => {
    const client = makeClient({ error: { message: 'db down' } });
    const writer = new SupabaseRunWriter(client as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(writer.upsertRun('run-1', {})).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('writeCostEvent calls supabase.from("cost_events").insert', async () => {
    const client = makeClient();
    const writer = new SupabaseRunWriter(client as any);
    await writer.writeCostEvent('run-1', 'worker', 1.5);
    expect(client.from).toHaveBeenCalledWith('cost_events');
  });

  it('writeCostEvent logs warning on error, does not throw', async () => {
    const client = makeClient(undefined, { error: { message: 'write failed' } });
    const writer = new SupabaseRunWriter(client as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(writer.writeCostEvent('run-1', 'worker', 1.5)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
