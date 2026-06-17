// packages/daemon/src/control-plane/merge-decision/index.ts
//
// Public surface of the pure merge-decision core.

export * from './types.js';
export { decideMerge } from './decide.js';
export { toDecisionRiskClass } from './risk-class.js';
