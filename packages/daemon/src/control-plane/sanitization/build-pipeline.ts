// packages/daemon/src/control-plane/sanitization/build-pipeline.ts
//
// Composition helper that turns a deployment profile's sanitizer bindings into
// an executable SanitizationPipeline. Default = identity (empty pipeline).
// Concrete sanitizers live in separate packages and are registered here by name.

import type { DeploymentProfile } from '../deployment-registry/types.js';
import type { DeploymentRegistry } from '../deployment-registry/registry.js';
import {
  SanitizationPipeline,
  SanitizerRegistry,
} from '@auto-claude/sanitization';
import { createWithholdingFactory } from '@auto-claude/sanitizer-redaction';
import type { ProtectedStore } from '@auto-claude/sanitizer-redaction';

export interface BuildSanitizationPipelineOptions {
  /** The ledger's protected store; required when a profile activates withholding. */
  protectedStore?: ProtectedStore;
}

/**
 * Build the input-boundary sanitization pipeline for a deployment profile.
 *
 * - No profile, no sanitizers, or an empty binding list ⇒ identity pipeline
 *   (`isEmpty === true`). This is the default today and keeps the raise path
 *   byte-identical.
 * - The "withholding" redaction sanitizer is registered when a ProtectedStore is
 *   supplied. Activating it in a deployment profile without a store fails closed.
 */
export function buildSanitizationPipeline(
  profile?: Readonly<DeploymentProfile>,
  opts?: BuildSanitizationPipelineOptions,
): SanitizationPipeline {
  const registry = new SanitizerRegistry();
  const store = opts?.protectedStore;

  registry.register(
    'withholding',
    store
      ? createWithholdingFactory(store)
      : () => {
          throw new Error(
            'withholding sanitizer requires a ProtectedStore, but the decision index is disabled or unavailable',
          );
        },
    '@auto-claude/sanitizer-redaction withholding sanitizer',
  );

  return registry.build(profile?.sanitizers ?? []);
}

/**
 * Resolve the active deployment profile from a registry and build its pipeline.
 * Not-found or unconfigured deployments fall back to the identity pipeline.
 */
export function buildSanitizationPipelineForDeployment(
  registry: DeploymentRegistry | undefined,
  deploymentId: string | undefined,
  opts?: BuildSanitizationPipelineOptions,
): SanitizationPipeline {
  if (registry === undefined || deploymentId === undefined) {
    return buildSanitizationPipeline(undefined, opts);
  }
  const result = registry.lookup(deploymentId);
  return buildSanitizationPipeline(
    result.kind === 'found' ? result.profile : undefined,
    opts,
  );
}
