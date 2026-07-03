// packages/daemon/src/control-plane/phase-artifact-status.ts
//
// Status guard for the extended PhaseArtifact status vocabulary used by the
// code-change delivery lane and its post-landing observation / reversal states.

const KNOWN_PHASE_ARTIFACT_STATUSES = new Set([
  'prepared',
  'proposed',
  'awaiting-review',
  'merged',
  'joined',
  'observed-healthy',
  'observed-red',
  'reversal-raised',
  'reverted',
  'rejected',
  'superseded',
  'delivery-failed',
]);

export function isKnownPhaseArtifactStatus(status: string): boolean {
  return KNOWN_PHASE_ARTIFACT_STATUSES.has(status);
}
