// src/session-runtime/adapters/types.ts
import type {
  AgentDefinition,
  DirectoryScope,
  ProviderDefinition,
  SessionResult,
} from '../../types.js';
import type { Result } from '../../lib/result.js';
import type { ContainmentPolicy } from '../containment-hooks.js';
import type { McpConfig } from '../plugin-injection.js';

export interface ProviderAdapter {
  spawn(def: AgentDefinition, prompt: string, options?: {
    cwd?: string;
    jsonSchema?: string;
    containmentPolicy?: ContainmentPolicy;
    mcpConfigs?: McpConfig[];
    directoryScope?: DirectoryScope;
    provider?: ProviderDefinition;
  }): Promise<Result<SessionResult>>;
}
