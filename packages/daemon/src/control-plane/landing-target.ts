// packages/daemon/src/control-plane/landing-target.ts
//
// Landing-target resolution for the integrate handler. Governed deployments take
// their trunk from the deployment profile's `landing.landsOn`; missing or
// invalid landing data fails closed (escalate). Profile-less runs fall back to
// the legacy `config.branches.staging`, loudly marked as ungoverned.

import type { LandingTarget } from './deployment-registry/types.js';

/** Minimal registry surface consumed by this module — easier to test/mock. */
export interface LandingRegistry {
  readDeclaredData: (
    deploymentId: string,
    key: 'landing',
  ) =>
    | { kind: 'found'; value: unknown }
    | { kind: 'not-found' };
}

export type LandingResolution =
  | { kind: 'governed'; landsOn: string }
  | { kind: 'ungoverned'; landsOn: string }
  | { kind: 'escalate'; reason: string };

export interface ResolveLandingTargetArgs {
  registry: LandingRegistry | undefined;
  deploymentId: string | undefined;
  fallbackStaging: string;
}

function isLandingTarget(value: unknown): value is LandingTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'landsOn' in value &&
    typeof (value as Record<string, unknown>).landsOn === 'string' &&
    (value as Record<string, unknown>).landsOn !== ''
  );
}

/**
 * Resolve the trunk a code change should land on.
 *
 * - Governed deployment with a valid `landing` declaration → `governed` + `landsOn`.
 * - Governed deployment with missing/invalid `landing` → `escalate` (fail-closed).
 * - No deployment configured → `ungoverned` + the legacy staging branch.
 */
export function resolveLandingTarget({
  registry,
  deploymentId,
  fallbackStaging,
}: ResolveLandingTargetArgs): LandingResolution {
  if (registry === undefined || deploymentId === undefined) {
    return { kind: 'ungoverned', landsOn: fallbackStaging };
  }

  const declared = registry.readDeclaredData(deploymentId, 'landing');
  if (declared.kind === 'not-found') {
    return {
      kind: 'escalate',
      reason: `landing target not declared for deployment "${deploymentId}"`,
    };
  }

  if (!isLandingTarget(declared.value)) {
    return {
      kind: 'escalate',
      reason: `landing target for deployment "${deploymentId}" is missing or invalid`,
    };
  }

  return { kind: 'governed', landsOn: declared.value.landsOn };
}
