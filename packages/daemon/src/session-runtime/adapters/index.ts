// src/session-runtime/adapters/index.ts
import type { ProviderAdapter } from './types.js';
import type { ProviderDefinition } from '../../types.js';
import { CliAdapter } from './cli.js';
import { CodexCliAdapter } from './codex-cli.js';
import { PiCliAdapter } from './pi-cli.js';

export type { ProviderAdapter };
export { CliAdapter, CodexCliAdapter, PiCliAdapter };

export function createAdapter(type: 'cli' | 'sdk'): ProviderAdapter {
  if (type === 'cli') return new CliAdapter();
  throw new Error(`SDK adapter not yet implemented. Use 'cli' adapter.`);
}

export function createProviderAdapter(provider: ProviderDefinition): ProviderAdapter {
  if (provider.adapterClass === 'programmatic-api') {
    throw new Error(
      `Provider adapter not yet implemented: ${provider.adapterClass}`,
    );
  }
  if (provider.providerKind === 'claude-cli') return new CliAdapter();
  if (provider.providerKind === 'codex-cli') return new CodexCliAdapter();
  if (provider.providerKind === 'pi-cli') return new PiCliAdapter();
  throw new Error(`Unknown provider kind: ${provider.providerKind}`);
}
