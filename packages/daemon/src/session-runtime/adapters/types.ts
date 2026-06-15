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

export interface ContainmentCapabilityProfile {
  nativeGuardHooks: boolean;
  structuredOutput: boolean;
  exactCostReporting: boolean;
  sessionContinuation: boolean;
}

export interface SessionHandle {
  pid?: number;
}

export interface ProviderAdapter {
  spawn(def: AgentDefinition, prompt: string, options?: {
    cwd?: string;
    jsonSchema?: string;
    containmentPolicy?: ContainmentPolicy;
    mcpConfigs?: McpConfig[];
    directoryScope?: DirectoryScope;
    provider?: ProviderDefinition;
    // Pass --dangerously-skip-permissions to clear the workspace-trust gate for
    // autonomous, externally-sandboxed (container) workers. Gated upstream in
    // SessionRuntime (config.autonomous || AUTO_CLAUDE_SKIP_PERMISSIONS=1).
    // Adapters that don't model a trust gate (e.g. codex-cli) may ignore it.
    skipPermissions?: boolean;
  }): Promise<Result<SessionResult>>;
  resume(
    def: AgentDefinition,
    prompt: string,
    continuationId: string,
    options?: Parameters<ProviderAdapter['spawn']>[2],
  ): Promise<Result<SessionResult>>;
  abort(handle: SessionHandle): Promise<void>;
  capabilities(): ContainmentCapabilityProfile;
}
