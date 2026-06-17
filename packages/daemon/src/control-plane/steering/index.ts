// packages/daemon/src/control-plane/steering/index.ts
//
// Public surface of the Steering-Role Registry & Deciders. Mirrors
// deployment-registry/index.ts: re-export the types, then the named
// schema / decide / registry functions.
export * from './types.js';
export {
  SteeringRoleSchema,
  WakeRhythmSchema,
  parseRole,
  deepFreeze,
  zodOffenders,
} from './schema.js';
export { decideWake, checkSpend } from './decide.js';
export {
  cronMatchesAt,
  cronDue,
  CRON_SEARCH_CAP_MINUTES,
  MINUTE_MS,
} from './cron.js';
export {
  SteeringRegistry,
  createSteeringRegistry,
  type KnownTargets,
} from './registry.js';
