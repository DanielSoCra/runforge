// src/session-runtime/adapters/types.ts
import type { AgentDefinition, SessionResult } from '../../types.js';
import type { Result } from '../../lib/result.js';

export interface ProviderAdapter {
  spawn(def: AgentDefinition, prompt: string, options?: {
    cwd?: string;
    jsonSchema?: string;
  }): Promise<Result<SessionResult>>;
}
