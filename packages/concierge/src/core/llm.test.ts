import { describe, expect, it } from 'vitest';
import { buildPromptBlocks } from './llm.js';

describe('prompt block assembly', () => {
  it('keeps cached prompt blocks byte-stable across turns', () => {
    const first = buildPromptBlocks({
      systemPrompt: 'You are the concierge.',
      toolDescriptions: 'ac_status: read daemon status',
      operatorProfile: 'The operator prefers concise answers.',
      rollingSummary: 'No open reminders.',
      recentTurns: [{ role: 'operator', text: 'status?' }],
    });
    const second = buildPromptBlocks({
      systemPrompt: 'You are the concierge.',
      toolDescriptions: 'ac_status: read daemon status',
      operatorProfile: 'The operator prefers concise answers.',
      rollingSummary: 'No open reminders.',
      recentTurns: [{ role: 'operator', text: 'again' }],
    });

    expect(first.cachedPrefix).toBe(second.cachedPrefix);
    expect(first.cachedSummary).toBe(second.cachedSummary);
    expect(first.uncachedRecent).not.toBe(second.uncachedRecent);
  });

  it('rejects dynamic ids and timestamps in cached blocks', () => {
    expect(() => buildPromptBlocks({
      systemPrompt: 'run_id=abc123',
      toolDescriptions: 'tools',
      operatorProfile: 'profile',
      rollingSummary: 'summary',
      recentTurns: [],
    })).toThrow(/cached block contains dynamic content/);
  });
});
