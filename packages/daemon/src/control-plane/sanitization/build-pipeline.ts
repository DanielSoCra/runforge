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

/**
 * Build the input-boundary sanitization pipeline for a deployment profile.
 *
 * - No profile, no sanitizers, or an empty binding list ⇒ identity pipeline
 *   (`isEmpty === true`). This is the default today and keeps the raise path
 *   byte-identical.
 * - The "withholding" redaction sanitizer is registered by name, but this slice
 *   does not wire the ProtectedStore it requires. Activating it in a deployment
 *   profile therefore fails closed with a clear error; Slice 5 will supply the
 *   store binding.
 */
export function buildSanitizationPipeline(
  profile?: Readonly<DeploymentProfile>,
): SanitizationPipeline {
  const registry = new SanitizerRegistry();

  // Slice 4 placeholder: the redaction sanitizer needs a ProtectedStore, which
  // is not wired yet. Register the name so deployments can declare it, but fail
  // closed if they actually try to activate it without the store plumbing.
  registry.register(
    'withholding',
    () => {
      throw new Error(
        'redaction sanitizer requires store wiring (withholding is registered but not bound in this slice)',
      );
    },
    '@auto-claude/sanitizer-redaction withholding sanitizer (store wiring pending)',
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
): SanitizationPipeline {
  if (registry === undefined || deploymentId === undefined) {
    return buildSanitizationPipeline(undefined);
  }
  const result = registry.lookup(deploymentId);
  return buildSanitizationPipeline(
    result.kind === 'found' ? result.profile : undefined,
  );
}
