// packages/daemon/src/control-plane/merge-decision/index.ts
//
// Public surface of the pure merge-decision core.

export * from './types.js';
export { decideMerge } from './decide.js';
export { toDecisionRiskClass } from './risk-class.js';
export {
  buildMergeDecisionRequest,
  decisionIdFor,
  INTEGRATE_PHASE,
  type BuildMergeDecisionRequestOpts,
} from './build-request.js';
export { observeVerifierStatus } from './observe-verifier.js';
export { computeTouchedPaths } from './touched-paths.js';
