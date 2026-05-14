import { describe, it, expect, vi } from 'vitest';
import { SupabaseRunWriter, toDbOutcome, toDbSessionType } from './run-writer.js';

describe('toDbOutcome', () => {
  it('maps complete → complete', () => expect(toDbOutcome('complete')).toBe('complete'));
  it('maps stuck → stuck',       () => expect(toDbOutcome('stuck')).toBe('stuck'));
  it('maps paused → in-progress', () => expect(toDbOutcome('paused')).toBe('in-progress'));
  it('maps parked → in-progress (#562)', () => expect(toDbOutcome('parked')).toBe('in-progress'));
  it('maps error → failed',       () => expect(toDbOutcome('error')).toBe('failed'));
  it('maps failed → failed',      () => expect(toDbOutcome('failed')).toBe('failed'));
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

  // product-owner and tech-lead (#342)
  it('maps product-owner → planning', () => expect(toDbSessionType('product-owner')).toBe('planning'));
  it('maps tech-lead → planning',     () => expect(toDbSessionType('tech-lead')).toBe('planning'));

  // spec-pipeline session types
  it('maps l2-designer → planning',         () => expect(toDbSessionType('l2-designer')).toBe('planning'));
  it('maps l3-generator → planning',        () => expect(toDbSessionType('l3-generator')).toBe('planning'));
  it('maps compliance-reviewer → planning', () => expect(toDbSessionType('compliance-reviewer')).toBe('planning'));

  // exhaustiveness guard
  it('throws on unknown session type', () => {
    expect(() => toDbSessionType('nonexistent' as any)).toThrow('Unknown session type');
  });
});

describe('SupabaseRunWriter', () => {
  const makeClient = (result: { error: { message: string } | null } = { error: null }) => {
    const eqMock = vi.fn().mockResolvedValue(result);
    return {
      from: vi.fn().mockImplementation(() => ({
        insert: vi.fn().mockResolvedValue(result),
        update: vi.fn().mockReturnValue({ eq: eqMock }),
        upsert: vi.fn().mockResolvedValue(result),
      })),
    };
  };

  it('insertRun calls supabase.from("runs").insert', async () => {
    const client = makeClient();
    const writer = new SupabaseRunWriter(client as any);
    await writer.insertRun('run-1', { outcome: 'in-progress', repo_owner: 'org', repo_name: 'repo' });
    expect(client.from).toHaveBeenCalledWith('runs');
  });

  it('upsertRun calls supabase.from("runs").update with eq filter', async () => {
    const client = makeClient();
    const writer = new SupabaseRunWriter(client as any);
    await writer.upsertRun('run-1', { outcome: 'in-progress' });
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
    const client = makeClient({ error: { message: 'write failed' } });
    const writer = new SupabaseRunWriter(client as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(writer.writeCostEvent('run-1', 'worker', 1.5)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
