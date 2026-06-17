// packages/daemon/src/control-plane/deployment-registry/index.ts
//
// Public surface of the Deployment-Profile Registry. Mirrors lane-engine/index.ts:
// re-export the types, then the named parse/registry functions.
export * from './types.js';
export {
  ProfileEnvelopeSchema,
  FleetCapacitySchema,
  parseProfile,
  parseFleetCapacity,
  deepFreeze,
  zodOffenders,
} from './schema.js';
export { DeploymentRegistry, createDeploymentRegistry } from './registry.js';
