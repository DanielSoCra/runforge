// packages/daemon/src/control-plane/deployment-registry/schema.ts
//
// Deployment-Profile Registry — schemas + parsers (STACK-AC-DEPLOYMENT-REGISTRY).
//
// Parse-validate-freeze at the edge. The schemas here are REAL (declarative zod,
// `.strict()` envelopes) and compose the siblings' own parsers — never re-declare
// a lane or pool field. The post-schema logic (cross-field assembly, deep-freeze)
// is the implementer's to fill; its bodies throw 'not implemented' so behavioral
// success-path tests stay RED while the declarative `.strict()`/rejection tests
// pass against real zod (the gate-author handoff state).

import { z } from 'zod';
import { SanitizerConfigSchema } from '@auto-claude/sanitization';
import { ComplianceReviewVerdictSchema } from '../../compliance/schemas.js';
import type {
  DeploymentProfile,
  FleetCapacityConfig,
  RegistrationOutcome,
  FleetCapacityOutcome,
} from './types.js';
import type { LaneSet } from '../lane-engine/types.js';
import { parseLaneSet } from '../lane-engine/schema.js';
import {
  PoolConfigSchema,
  validatePoolMembership,
} from '../../session-runtime/providers/window-scheduler/schema.js';

/**
 * The lane engine's four-level risk vocabulary, reused verbatim for the risk-path
 * map's minLevel and for the deployment's defaultMinLevel (the L3: "no second risk
 * vocabulary"). An entry naming an unknown level is rejected at parse time.
 */
const RiskLevel = z.enum(['green', 'yellow', 'orange', 'red']);

/**
 * The platform's gate vocabulary (the lane engine's `GateKey`), reused verbatim
 * so a gate-set definition cannot name a second, drifting set of gate keys. An
 * entry naming a key outside this set is rejected at parse time (fail-closed).
 */
const GateKeySchema = z.enum([
  'deterministic',
  'spec-compliance',
  'quality',
  'security',
  'holdout',
]);

/**
 * OPTIONAL deployment-level gate-set DEFINITIONS (XCUT P2#1): a map from gate-set
 * NAME → the gate keys that must have PASSED for the set to be satisfied. The same
 * name space a lane's `gateSet` field selects. `.min(1)` required: a gate-set that
 * demands nothing makes the lane's verdict vacuously true, which is a config error
 * masquerading as a gate. ABSENT on a profile ⇒ the feature is inert (the integrate
 * verdict preserves today's safe `validationPassed = true`).
 */
const GateSetDefinitionSchema = z
  .object({ required: z.array(GateKeySchema).min(1) })
  .strict();
const GateSetDefinitionsSchema = z.record(z.string(), GateSetDefinitionSchema);

/**
 * Thin `.strict()` schema over RiskPathEntry[] — the lane engine only *consumes*
 * the risk-path map, never parses it, so the envelope owns this shape. `.min(1)`
 * paths: an entry with no paths matches nothing (config error).
 */
const RiskPathEntrySchema = z
  .object({
    paths: z.array(z.string()).min(1),
    minLevel: RiskLevel,
  })
  .strict();

const OwnedRepositorySchema = z
  .object({
    owner: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

const ComplianceReviewerSchema = z
  .object({
    reviewer: z.string().min(1),
    condition: z.string().min(1),
  })
  .strict();

const HonestAutomationMapSchema = z
  .object({
    automatable: z.array(z.string()),
    strained: z.array(z.string()),
    irreduciblyHuman: z.array(z.string()),
  })
  .strict();

export const DeclaredReleasePathSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('platform-performs') }).strict(),
  z.object({ kind: z.literal('trigger-automated'), trigger: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('record-only'), procedure: z.string().min(1) }).strict(),
]);

const LandingTargetSchema = z
  .object({
    landsOn: z.string().min(1),
    productionReleasePath: DeclaredReleasePathSchema,
    /**
     * OPTIONAL explicit required-check names for the controlled code-change
     * merge path. Absent or empty for a governed deployment fails closed.
     */
    requiredChecks: z.array(z.string().min(1)).optional(),
  })
  .strict();

const CapabilityBindingSchema = z
  .object({
    capability: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

/**
 * The ENVELOPE schema — only the fields the siblings do not define. The lane set
 * is `z.unknown()` here: it is validated by the lane engine's own parseLaneSet
 * (not re-declared), but its presence is required so a profile that omits it is
 * an envelope-level offender. `defaultMinLevel` is required (a risk config with
 * no floor cannot fail safe — L2 error handling).
 */
export const ProfileEnvelopeSchema = z
  .object({
    repositories: z.array(OwnedRepositorySchema),
    riskPathMap: z.array(RiskPathEntrySchema),
    defaultMinLevel: RiskLevel,
    laneSet: z.unknown(),
    // OPTIONAL gate-set definitions (XCUT P2#1). Absent ⇒ the lane-specific
    // gate-set verdict is inert. Validated here (not re-declared elsewhere); a
    // dangling lane→gate-set reference is checked in parseProfile's cross-field
    // pass below, where both the lane set and the gate-set names are known.
    gateSets: GateSetDefinitionsSchema.optional(),
    // OPTIONAL sanitizer bindings (STACK-AC-SANITIZATION). Absent or empty ⇒
    // the input-boundary sanitization pipeline is the identity (default today).
    sanitizers: SanitizerConfigSchema.optional(),
    lifecycleMode: z.string().min(1),
    complianceReviewers: z.array(ComplianceReviewerSchema),
    // OPTIONAL recorded compliance review verdicts (FUNC-AC-COMPLIANCE-GATE).
    // Absent ⇒ the merge-decision compliance lens falls back to path-condition
    // matching. Reuses the compliance module's canonical verdict schema so the
    // evaluator and the profile agree on shape.
    complianceVerdicts: z.array(ComplianceReviewVerdictSchema).optional(),
    honestAutomation: HonestAutomationMapSchema,
    budget: z.number(),
    landing: LandingTargetSchema,
    capabilityBindings: z.array(CapabilityBindingSchema),
  })
  .strict();

/** The fleet capacity schema reuses the window scheduler's per-pool schema verbatim. */
export const FleetCapacitySchema = z.array(PoolConfigSchema);

/** Flatten zod issues into offender strings — same format as the lane engine's parser
 * (`<path>: <message>`); for an unrecognized key the path is empty but the message
 * names the offending key, so a `.toContain(<key>)` assertion still finds it. */
export function zodOffenders(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

/**
 * Recursively freeze an object graph so an accepted profile (and its nested
 * LaneSet/pools/arrays) cannot be mutated post-validation. Mirrors the lane-engine
 * `deepFreeze` precedent (recurse children, then freeze).
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Parse + validate one deployment's raw profile data into a frozen
 * DeploymentProfile, or reject naming every offender. Composes the envelope
 * `.strict()` schema with the lane engine's parseLaneSet (the lane set is the
 * engine's own frozen LaneSet, verbatim). Cross-deployment ownership is NOT
 * checked here (the schema cannot see other profiles — that lives in register).
 *
 * The schema validation and parseLaneSet composition are REAL (so rejection tests
 * pass); the success-path assembly + deepFreeze is STUBBED to throw.
 *
 * @param id          the deployment id to stamp on the parsed profile
 * @param raw         the parsed-but-unvalidated profile data
 */
export function parseProfile(id: string, raw: unknown): RegistrationOutcome {
  const env = ProfileEnvelopeSchema.safeParse(raw);

  // Compose the lane engine's own parser. Even if the envelope failed we still
  // surface lane offenders — reject whole, name every offender, never
  // short-circuit into a partial accept.
  const laneRaw = env.success ? env.data.laneSet : (raw as { laneSet?: unknown })?.laneSet;
  const lanes = parseLaneSet(laneRaw);

  const offenders: string[] = [];
  if (!env.success) offenders.push(...zodOffenders(env.error));
  if (!lanes.ok) offenders.push(...lanes.errors);

  // Lifecycle mode must name one of the lane set's declared phases.
  if (env.success && lanes.ok && !lanes.laneSet.declaredPhases.includes(env.data.lifecycleMode)) {
    offenders.push(`lifecycleMode '${env.data.lifecycleMode}' is not a declared phase`);
  }

  // Cross-field (XCUT P2#1): when gate-set definitions are declared, every lane's
  // gate-set reference — across ALL lifecycle modes — must name a defined gate set.
  // A dangling reference is a malformed pack; reject it at activation rather than
  // accepting it and parking every affected change at integrate (fail at the door,
  // not at runtime).
  if (env.success && lanes.ok && env.data.gateSets !== undefined) {
    const defined = new Set(Object.keys(env.data.gateSets));
    for (const lane of lanes.laneSet.lanes) {
      const refs =
        typeof lane.gateSet === 'string'
          ? [lane.gateSet]
          : Object.values(lane.gateSet);
      for (const ref of refs) {
        if (!defined.has(ref)) {
          offenders.push(
            `lane '${lane.name}' references undefined gate set '${ref}'`,
          );
        }
      }
    }
  }

  if (!env.success || !lanes.ok || offenders.length > 0) {
    return { ok: false, offenders };
  }

  // Success path — assemble the envelope + the engine's frozen LaneSet into a
  // single deep-frozen DeploymentProfile. STUB. (env.success and lanes.ok are
  // both narrowed true here.)
  return assembleProfile(id, env.data, lanes.laneSet);
}

/**
 * Parse + validate the fleet-level capacity config: the window scheduler's
 * per-pool schema across the array, then its cross-pool one-provider-one-pool
 * invariant. Schema + validatePoolMembership are REAL; the freeze is STUBBED.
 */
export function parseFleetCapacity(raw: unknown): FleetCapacityOutcome {
  const pools = FleetCapacitySchema.safeParse(raw);
  if (!pools.success) {
    return { ok: false, offenders: zodOffenders(pools.error) };
  }
  const membership = validatePoolMembership(pools.data);
  if (!membership.ok) {
    return { ok: false, offenders: membership.offenders };
  }
  return freezeFleetCapacity(pools.data);
}

// ---------------------------------------------------------------------------
// STUBS — implementer (Kimi) fills these. They must produce a deep-frozen graph.
// ---------------------------------------------------------------------------

/** Assemble a validated envelope + frozen LaneSet into a frozen DeploymentProfile. */
function assembleProfile(
  id: string,
  env: z.infer<typeof ProfileEnvelopeSchema>,
  laneSet: LaneSet,
): RegistrationOutcome {
  const profile: DeploymentProfile = {
    id,
    repositories: env.repositories,
    riskPathMap: env.riskPathMap,
    defaultMinLevel: env.defaultMinLevel,
    laneSet,
    gateSets: env.gateSets,
    // SanitizerConfigSchema has a default([]), so an omitted field parses to [].
    // For the deployment profile we want absent/empty to mean "no sanitizers"
    // (undefined) so downstream consumers can use a simple optional check.
    sanitizers:
      env.sanitizers === undefined || env.sanitizers.length === 0
        ? undefined
        : env.sanitizers,
    lifecycleMode: env.lifecycleMode,
    complianceReviewers: env.complianceReviewers,
    complianceVerdicts: env.complianceVerdicts,
    honestAutomation: env.honestAutomation,
    budget: env.budget,
    landing: env.landing,
    capabilityBindings: env.capabilityBindings,
  };
  return { ok: true, profile: deepFreeze(profile) };
}

/** Freeze the validated pools into a frozen FleetCapacityConfig. */
function freezeFleetCapacity(pools: FleetCapacityConfig['pools']): FleetCapacityOutcome {
  const fleet: FleetCapacityConfig = { pools };
  return { ok: true, fleet: deepFreeze(fleet) };
}
