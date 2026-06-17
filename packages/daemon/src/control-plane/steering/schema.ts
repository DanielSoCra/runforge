// packages/daemon/src/control-plane/steering/schema.ts
//
// Steering-Role Registry — schema + parser (STACK-AC-STEERING).
//
// Parse-validate-freeze at the edge. The schemas here are REAL (declarative zod,
// `.strict()` across the whole graph) and validate ONE role's shape — duplicate
// role id and grant-membership are cross-record checks the registry runs (the
// schema cannot see other roles or the platform's known-target sets). The
// post-schema assemble/deep-freeze step is STUBBED to throw 'not implemented' so
// the behavioral success-path tests stay RED while the declarative
// `.strict()`/rejection tests pass against real zod (the gate-author handoff).

import { z } from 'zod';
import type { SteeringRole, RegistrationOutcome, RoleVersion } from './types.js';
import { isValidCronExpr } from './cron.js';

/**
 * The wake-rhythm discriminated union, declarative + real. `interval.everyMs` is
 * `.int().positive()` (a non-positive interval cannot schedule); `cron.expr` is a
 * non-empty string (an empty cron expr cannot schedule). A malformed rhythm is a
 * parse-time offender (L2: "a role without a sound rhythm cannot be scheduled"),
 * never a runtime surprise inside the decider. Each arm is `.strict()`.
 */
export const WakeRhythmSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('interval'),
      everyMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cron'),
      expr: z.string().min(1),
    })
    .strict(),
]);

/**
 * The `.strict()` role schema — a typo'd key (e.g. `routingGrants` for
 * `routingGrant`) fails activation, never a silent default that strips the role
 * of every exit. Validates SHAPE only: the grant arrays are `z.array(z.string())`
 * — each entry's existence (a known capability / known path) is the registry's
 * cross-subsystem check, not the schema's. `perWakingBudget` is `.positive()`
 * (L2: a non-positive budget cannot fail safe at the spend boundary).
 */
export const SteeringRoleSchema = z
  .object({
    id: z.string().min(1),
    charter: z.string().min(1),
    instructions: z.string().min(1),
    voice: z.string().min(1),
    capabilityGrant: z.array(z.string()),
    referenceKnowledge: z.array(z.string()),
    routingGrant: z.array(z.string()),
    wakeRhythm: WakeRhythmSchema,
    perWakingBudget: z.number().positive(),
  })
  .strict();

/**
 * Flatten zod issues into offender strings — same `<path>: <message>` format as
 * the lane-engine / deployment-registry parsers. For an unrecognized key the path
 * may be empty but the message names the offending key, so a `.toContain(<key>)`
 * assertion still finds it.
 */
export function zodOffenders(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

/**
 * Recursively freeze a role's object graph (including `wakeRhythm` and the grant
 * arrays) so an accepted role cannot be mutated post-validation. `Readonly<>` is
 * compile-time only; a consumer that mutated `role.routingGrant` or
 * `role.wakeRhythm.everyMs` at runtime would corrupt shared frozen state and let
 * a waking route somewhere its declaration never granted. Recurse-then-freeze
 * (the lane-engine / deployment-registry precedent).
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
 * Parse + validate one role's raw declaration into a frozen SteeringRole under a
 * RoleVersion, or reject naming every offender. The `.strict()` schema validation
 * is REAL (so rejection tests pass); the success-path assemble + deep-freeze is
 * STUBBED to throw. Cross-role duplicate-id and grant-membership are NOT checked
 * here (the schema cannot see other roles — that lives in the registry).
 *
 * @param raw         the parsed-but-unvalidated role declaration data
 * @param version     the RoleVersion to stamp on the frozen role (assigned by the
 *                    registry: id + next version number + activation time + digest)
 */
export function parseRole(raw: unknown, version: RoleVersion): RegistrationOutcome {
  const parsed = SteeringRoleSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, offenders: zodOffenders(parsed.error) };
  }

  // Success path — assemble the validated declaration into a single deep-frozen
  // SteeringRole under its RoleVersion. STUB. (Kimi fills this.)
  return assembleRole(parsed.data, version);
}

// ---------------------------------------------------------------------------
// STUB — implementer (Kimi) fills this. It must produce a deep-frozen role graph
// stamped with the supplied RoleVersion, returned as { ok: true; role; version }.
// ---------------------------------------------------------------------------

/** Assemble a validated declaration + RoleVersion into a frozen RegistrationOutcome. */
function assembleRole(
  data: z.infer<typeof SteeringRoleSchema>,
  version: RoleVersion,
): RegistrationOutcome {
  // Fail CLOSED on a malformed cron expression at REGISTRATION — the schema only
  // checks the cron shape (a non-empty string), so an unparseable expr (e.g.
  // "not a cron") would freeze ok and then throw at the first decideWake. Reject it
  // as an offender here instead of scheduling an unintended/throwing cadence.
  if (data.wakeRhythm.kind === 'cron' && isValidCronExpr(data.wakeRhythm.expr) === false) {
    return {
      ok: false,
      offenders: [`wakeRhythm.expr: "${data.wakeRhythm.expr}" is not a valid cron expression`],
    };
  }

  const role = deepFreeze(data) as SteeringRole;
  return { ok: true, role, version };
}
