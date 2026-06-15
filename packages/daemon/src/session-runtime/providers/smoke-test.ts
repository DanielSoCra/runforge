import type { ProviderDefinition, SessionResult } from '../../types.js';
import type { ProviderAdapter } from '../adapters/types.js';

export type SmokeProof = {
  providerName: string;
  modelBinding: string;
  responded: boolean;
  observableChange: boolean;
  passed: boolean;
  cause?: 'smoke-failed';
};

export type SmokeTestOptions = {
  adapter: ProviderAdapter;
  observedChange: () => boolean | Promise<boolean>;
};

const SMOKE_PROMPT =
  'Write a one-sentence proof that the model is responding, then create or modify a file named smoke-proof.txt in the workspace.';

const SMOKE_AGENT = {
  name: 'smoke-test',
  description: 'one-shot proving run',
  systemPrompt: '',
  allowedTools: ['Read', 'Write'],
  maxTurns: 1,
  timeoutMs: 60_000,
  budgetCap: 0.1,
};

export async function smokeTest(
  provider: ProviderDefinition,
  modelBinding: string,
  options: SmokeTestOptions,
): Promise<SmokeProof> {
  const proof: SmokeProof = {
    providerName: provider.name,
    modelBinding,
    responded: false,
    observableChange: false,
    passed: false,
  };

  const spawnResult = await options.adapter.spawn(
    SMOKE_AGENT,
    SMOKE_PROMPT,
    { provider },
  );

  if (!spawnResult.ok) {
    return { ...proof, cause: 'smoke-failed' };
  }

  const result: SessionResult = spawnResult.value;
  const output = result.output.trim();
  proof.responded = output.length > 0;

  if (!proof.responded) {
    return { ...proof, cause: 'smoke-failed' };
  }

  proof.observableChange = await options.observedChange();

  if (!proof.observableChange) {
    return { ...proof, cause: 'smoke-failed' };
  }

  return { ...proof, passed: true };
}
