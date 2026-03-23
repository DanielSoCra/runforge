import { describe, it, expect, vi } from 'vitest';
import { SupabaseRunWriter, toDbOutcome, toDbSessionType } from './run-writer.js';

describe('toDbOutcome', () => {
  it('maps complete → complete', () => expect(toDbOutcome('complete')).toBe('complete'));
  it('maps stuck → stuck',       () => expect(toDbOutcome('stuck')).toBe('stuck'));
  it('maps paused → in-progress', () => expect(toDbOutcome('paused')).toBe('in-progress'));
  it('maps error → in-progress',  () => expect(toDbOutcome('error')).toBe('in-progress'));
});

describe('toDbSessionType', () => {
  // planning group
  it('maps coordinator → planning',       () => expect(toDbSessionType('coordinator')).toBe('planning'));
  it('maps classifier → planning',        () => expect(toDbSessionType('classifier')).toBe('planning'));

  // implementation group
  it('maps worker → implementation',           () => expect(toDbSessionType('worker')).toBe('implementation'));
  it('maps bug-worker → implementation',        () => expect(toDbSessionType('bug-worker')).toBe('implementation'));

  // validation group
  it('maps reviewer-spec → validation',     () => expect(toDbSessionType('reviewer-spec')).toBe('validation'));
  it('maps reviewer-quality → validation',  () => expect(toDbSessionType('reviewer-quality')).toBe('validation'));
  it('maps reviewer-security → validation', () => expect(toDbSessionType('reviewer-security')).toBe('validation'));

  // diagnosis group
  it('maps diagnostician → diagnosis',    () => expect(toDbSessionType('diagnostician')).toBe('diagnosis'));

  // codebase-reviewer (was missing — #319)
  it('maps codebase-reviewer → validation', () => expect(toDbSessionType('codebase-reviewer')).toBe('validation'));

  // exhaustiveness guard
  it('throws on unknown session type', () => {
    expect(() => toDbSessionType('nonexistent' as any)).toThrow('Unknown session type');
  });
});

describe('SupabaseRunWriter', () => {
  const makeClient = (upsertResult: { error: { message: string } | null } = { error: null }, insertResult: { error: { message: string } | null } = { error: null }) => ({
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
