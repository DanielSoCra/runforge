import type { ContainmentCapabilityProfile } from '../adapters/types.js';

export type ContainmentBaseline = {
  isolatedWorkspace: boolean;
  deterministicGates: boolean;
  requiredReviewLevel: 'strongest';
};

export function composeContainmentBaseline(
  profile: ContainmentCapabilityProfile,
): ContainmentBaseline {
  // Floor: every runtime runs isolated, passes deterministic gates, and faces
  // strongest-level independent review. A non-native-guard runtime gets the
  // full compensating baseline; the native runtime is still gated and reviewed.
  const isolatedWorkspace = true;
  const deterministicGates = true;
    const requiredReviewLevel = 'strongest' as const;

  // Profile can only add controls, never remove the floor. The local variables
  // above already represent the floor, so we return them directly.
  void profile;

  return {
    isolatedWorkspace,
    deterministicGates,
    requiredReviewLevel,
  };
}
