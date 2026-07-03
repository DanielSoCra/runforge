// G1 — self-hosting deployment profile acceptance gate.
//
// auto-claude must govern ITSELF: the repo-root auto-claude.config.json must
// carry a `deployment` block that the registry's own authoritative validator
// (parseProfile) accepts, whose landing target fails closed on explicit
// required checks, and whose every autonomously-merging lane declares a
// runnable verifier oracle (the verifier-gated-autonomy hard boundary).
//
// RED at HEAD: auto-claude.config.json has NO `deployment` block, so the very
// first assertion (block present) fails. The downstream assertions are the
// immovable shape the fix must satisfy to go green.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProfile } from './deployment-registry/index.js';

const CONFIG_PATH = join(import.meta.dirname, '../../../../auto-claude.config.json');

interface ConfigShape {
  deployment?: { id?: string; profile?: unknown };
}

/** ByMode<MergePolicy> is either a bare policy string or a per-mode map. */
function mergePoliciesOf(mergePolicy: unknown): string[] {
  if (typeof mergePolicy === 'string') return [mergePolicy];
  if (mergePolicy !== null && typeof mergePolicy === 'object') {
    return Object.values(mergePolicy as Record<string, unknown>).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  return [];
}

/** A lane that can merge without an operator decision (auto / review-then-auto). */
function isAutonomousLane(lane: { mergePolicy: unknown }): boolean {
  return mergePoliciesOf(lane.mergePolicy).some(
    (p) => p === 'auto' || p === 'review-then-auto',
  );
}

describe('G1 self-hosting deployment profile', () => {
  it('registers auto-claude as its own governed deployment via parseProfile', async () => {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf-8')) as ConfigShape;
    const deployment = raw.deployment;

    expect(
      deployment,
      'auto-claude.config.json must declare a `deployment` block — the daemon cannot self-govern without registering itself',
    ).toBeDefined();
    if (deployment === undefined) return; // unreachable after expect; narrows for TS

    expect(deployment.id, 'deployment.id must be a non-empty string').toBeTypeOf(
      'string',
    );
    const id = deployment.id ?? '';
    expect(id.length, 'deployment.id must be non-empty').toBeGreaterThan(0);

    const outcome = parseProfile(id, deployment.profile);
    if (!outcome.ok) {
      expect.fail(
        `deployment.profile was rejected by the registry validator: ${outcome.offenders.join('; ')}`,
      );
    }
    const profile = outcome.profile;

    // Governed landing must fail closed on an EXPLICIT required-checks list.
    const requiredChecks = profile.landing.requiredChecks;
    expect(
      Array.isArray(requiredChecks) && requiredChecks.length > 0,
      'landing.requiredChecks must be a non-empty list — a governed deployment fails closed without explicit merge checks',
    ).toBe(true);

    // At least one path must be risk-classified (the floor is not vacuous).
    expect(
      profile.riskPathMap.length,
      'riskPathMap must classify at least one path',
    ).toBeGreaterThan(0);

    // Verifier-gated autonomy: every autonomously-merging lane declares a
    // runnable verifier oracle. A lane without one may not merge unattended.
    const autonomousLanes = profile.laneSet.lanes.filter(isAutonomousLane);
    expect(
      autonomousLanes.length,
      'profile must declare at least one autonomously-merging lane',
    ).toBeGreaterThan(0);

    for (const lane of autonomousLanes) {
      expect(
        lane.verifier,
        `autonomous lane '${lane.name}' must declare a verifier — verifier-gated autonomy is the hard boundary`,
      ).toBeDefined();
      const ref = lane.verifier?.invoke.ref;
      expect(
        typeof ref === 'string' && ref.length > 0,
        `autonomous lane '${lane.name}' verifier must carry a runnable invoke.ref`,
      ).toBe(true);
    }
  });
});
