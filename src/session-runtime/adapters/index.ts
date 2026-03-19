// src/session-runtime/adapters/index.ts
import type { ProviderAdapter } from './types.js';
import { CliAdapter } from './cli.js';

export type { ProviderAdapter };
export { CliAdapter };

export function createAdapter(type: 'cli' | 'sdk'): ProviderAdapter {
  if (type === 'cli') return new CliAdapter();
  throw new Error(`SDK adapter not yet implemented. Use 'cli' adapter.`);
}
