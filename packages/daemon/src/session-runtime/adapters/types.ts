// src/session-runtime/adapters/types.ts
import type { AgentDefinition, SessionResult } from '../../types.js';
import type { Result } from '../../lib/result.js';
import type { ContainmentPolicy } from '../containment-hooks.js';

export interface ProviderAdapter {
  spawn(def: AgentDefinition, prompt: string, options?: {
    cwd?: string;
    jsonSchema?: string;
    containmentPolicy?: ContainmentPolicy;
  }): Promise<Result<SessionResult>>;
}
