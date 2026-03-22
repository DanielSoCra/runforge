import { describe, it, expect } from 'vitest';
import { buildSignalPrompt, briefingSchema, briefingTool } from './prompt.js';
import type { SignalResult } from './signals.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseSignals: SignalResult = {
  runs: [
    { id: 'run-1', issue_number: 42, outcome: 'success', phase: 'done', updated_at: '2026-03-22T10:00:00Z' },
    { id: 'run-2', issue_number: 99, outcome: 'stuck', phase: 'implementation', updated_at: '2026-03-22T10:05:00Z' },
  ],
  daemonStatus: { state: 'running', activeRuns: 1 },
  gitLog: ['abc1234 fix: resolve flaky test', 'def5678 feat: add dashboard widget'],
  heartbeatAt: '2026-03-22T10:10:00Z',
  gaps: [],
};

const signalsWithGaps: SignalResult = {
  runs: [],
  daemonStatus: null,
  gitLog: ['abc1234 fix: resolve flaky test'],
  heartbeatAt: null,
  gaps: ['daemon: ECONNREFUSED', 'runs: timeout'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSignalPrompt', () => {
  it('includes all signal data in the prompt', () => {
    const prompt = buildSignalPrompt(baseSignals);

    expect(prompt).toContain('run-1');
    expect(prompt).toContain('run-2');
    expect(prompt).toContain('issue_number');
    expect(prompt).toContain('"state": "running"');
    expect(prompt).toContain('abc1234');
    expect(prompt).toContain('def5678');
    expect(prompt).toContain('Heartbeat');
    expect(prompt).toContain('2026-03-22T10:10:00Z');
  });

  it('includes previous briefing context when provided', () => {
    const previous = {
      status_line: 'All systems nominal',
      changes: [],
      attention: [],
      forecast: 'Quiet period expected',
      generated_at: '2026-03-22T09:00:00Z',
    };

    const prompt = buildSignalPrompt(baseSignals, previous);

    expect(prompt).toContain('Previous Briefing');
    expect(prompt).toContain('All systems nominal');
    expect(prompt).toContain('Quiet period expected');
    expect(prompt).toContain('2026-03-22T09:00:00Z');
  });

  it('omits previous briefing section when none provided', () => {
    const prompt = buildSignalPrompt(baseSignals);

    expect(prompt).not.toContain('Previous Briefing');
  });

  it('includes gap notes when signals are missing', () => {
    const prompt = buildSignalPrompt(signalsWithGaps);

    expect(prompt).toContain('Signal Gaps');
    expect(prompt).toContain('daemon: ECONNREFUSED');
    expect(prompt).toContain('runs: timeout');
    expect(prompt).toContain('note any gaps');
  });

  it('handles empty runs gracefully', () => {
    const signals: SignalResult = { ...baseSignals, runs: [] };
    const prompt = buildSignalPrompt(signals);

    expect(prompt).toContain('No runs updated since last briefing');
  });

  it('handles empty git log gracefully', () => {
    const signals: SignalResult = { ...baseSignals, gitLog: [] };
    const prompt = buildSignalPrompt(signals);

    expect(prompt).toContain('No commits since last briefing');
  });

  it('handles unavailable daemon gracefully', () => {
    const signals: SignalResult = { ...baseSignals, daemonStatus: null, heartbeatAt: null };
    const prompt = buildSignalPrompt(signals);

    expect(prompt).toContain('Daemon status unavailable');
    expect(prompt).toContain('daemon may be unreachable');
  });
});

describe('briefingSchema', () => {
  it('has all required fields', () => {
    expect(briefingSchema.required).toContain('status_line');
    expect(briefingSchema.required).toContain('changes');
    expect(briefingSchema.required).toContain('attention');
    expect(briefingSchema.required).toContain('forecast');
  });

  it('defines correct types for all fields', () => {
    expect(briefingSchema.properties.status_line.type).toBe('string');
    expect(briefingSchema.properties.changes.type).toBe('array');
    expect(briefingSchema.properties.attention.type).toBe('array');
    expect(briefingSchema.properties.forecast.type).toBe('string');
  });

  it('defines change items with summary and optional links', () => {
    const changeItem = briefingSchema.properties.changes.items;
    expect(changeItem.required).toContain('summary');
    expect(changeItem.properties.summary.type).toBe('string');
    expect(changeItem.properties.links?.type).toBe('array');
  });

  it('defines attention items with issueNumber and reason', () => {
    const attentionItem = briefingSchema.properties.attention.items;
    expect(attentionItem.required).toContain('issueNumber');
    expect(attentionItem.required).toContain('reason');
    expect(attentionItem.properties.issueNumber.type).toBe('number');
    expect(attentionItem.properties.reason.type).toBe('string');
  });
});

describe('briefingTool', () => {
  it('has the correct name', () => {
    expect(briefingTool.name).toBe('produce_briefing');
  });

  it('uses the briefing schema as input_schema', () => {
    expect(briefingTool.input_schema).toBe(briefingSchema);
  });
});
