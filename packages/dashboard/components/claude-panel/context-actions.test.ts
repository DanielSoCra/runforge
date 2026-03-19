import { describe, it, expect } from 'vitest';
import { getContextActions, buildRunContext } from './context-actions';

describe('getContextActions', () => {
  it('returns run actions for /runs/[id]', () => {
    const actions = getContextActions('/runs/abc-123');
    expect(actions).toHaveLength(2);
    expect(actions[0].label).toBe('Share this run with Claude');
    expect(actions[1].label).toBe('Create follow-up issue from this run');
  });

  it('returns repo actions for /repos/[id]', () => {
    const actions = getContextActions('/repos/abc-123');
    expect(actions[0].label).toBe('Create issue for this repo');
  });

  it('returns cost actions for /cost', () => {
    const actions = getContextActions('/cost');
    expect(actions[0].label).toBe('Analyze cost trends with Claude');
  });

  it('always includes Open in new tab action', () => {
    const actions = getContextActions('/');
    expect(actions.some((a) => a.label === 'Open in new tab')).toBe(true);
  });
});

describe('buildRunContext', () => {
  it('builds a structured run summary', () => {
    const text = buildRunContext({
      id: 'run-1',
      repo_owner: 'acme',
      repo_name: 'web',
      issue_number: 42,
      issue_title: 'Fix login bug',
      outcome: 'complete',
      total_cost: 0.12,
      current_phase: 'done',
    });
    expect(text).toContain('acme/web');
    expect(text).toContain('#42');
    expect(text).toContain('Fix login bug');
    expect(text).toContain('$0.12');
  });
});
