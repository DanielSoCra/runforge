import { describe, expect, it } from 'vitest';
import { CodexCliAdapter } from './codex-cli.js';
import type { AgentDefinition, ProviderDefinition } from '../../types.js';

const agent: AgentDefinition = {
  name: 'classifier',
  description: 'classifies work',
  systemPrompt: '',
  allowedTools: ['Read', 'Grep'],
  modelOverride: 'claude-haiku-4-5-20251001',
  maxTurns: 1,
  timeoutMs: 30_000,
  budgetCap: 0.5,
};

const provider: ProviderDefinition = {
  name: 'codex-planner',
  adapterClass: 'process-based',
  providerKind: 'codex-cli',
  supportedModelTiers: ['higher-capability'],
  cliTool: 'codex',
  model: 'gpt-5.5',
  executionFlags: ['exec', '--full-auto'],
};

describe('CodexCliAdapter (#480)', () => {
  it('builds args from provider flags and provider model', () => {
    const adapter = new CodexCliAdapter();
    const args = adapter.buildArgs(agent, 'plan this', provider);

    expect(args).toEqual([
      'exec',
      '--full-auto',
      '--model',
      'gpt-5.5',
      'plan this',
    ]);
  });

  it('wraps plain stdout into a SessionResult payload', () => {
    const adapter = new CodexCliAdapter();
    const parsed = adapter.parseOutput('implemented the plan\n');

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.output).toBe('implemented the plan');
      expect(parsed.value.cost).toBe(0);
      expect(parsed.value.structuredData).toEqual({
        provider: 'codex-cli',
        raw: 'implemented the plan\n',
      });
    }
  });
});
