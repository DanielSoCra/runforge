// packages/daemon/src/control-plane/earn-in/demote-on-red.ts
// Red-event classifier + level-wide demote trigger (STACK-AC-EARN-IN).

import type { DeploymentRegistry } from '../deployment-registry/registry.js';
import type { RiskClass } from '../deployment-registry/types.js';
import { appendLaneOutcome } from '../lane-engine/outcome-ledger.js';
import type { RedEventKind } from './types.js';

export interface DemoteOnRedDeps {
  registry: DeploymentRegistry;
  stateDir: string;
  deploymentId: string;
  lane: string;
  riskClass: RiskClass;
  redReason: RedEventKind;
  now: number;
}

/** Any signal that is not explicitly healthy is treated as red (fail-closed). */
export function isRedEvent(status: 'healthy' | 'red' | 'indeterminate'): boolean {
  return status !== 'healthy';
}

/**
 * Two effects of one red event: (1) append a red outcome to the lane's outcome
 * stream, and (2) record a LEVEL-WIDE demotion through the registry so every lane
 * widening for the class is revoked.
 */
export async function triggerDemoteOnRed(deps: DemoteOnRedDeps): Promise<void> {
  const { registry, stateDir, deploymentId, lane, riskClass, redReason, now } = deps;
  const ts = new Date(now).toISOString();

  await appendLaneOutcome(stateDir, {
    ts,
    deploymentId,
    lane,
    kind: 'red',
    redReason,
    riskClass,
  });

  const outcome = registry.recordWidening(
    deploymentId,
    riskClass,
    'human-gated',
    { kind: 'demote-on-red', trigger: redReason },
    now,
  );
  if (!outcome.ok) {
    console.warn(
      `[demote-on-red] Failed to record demotion for ${deploymentId}/${riskClass}: ${outcome.ok === false ? outcome.reason : 'unknown'}`,
    );
  }
}
