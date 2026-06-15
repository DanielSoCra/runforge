// packages/daemon/src/control-plane/lane-engine/index.ts
export * from './types.js';
export { matchesAny } from './match.js';
export { RISK_ORDER, maxRiskLevel, applyRiskPathFloor } from './risk.js';
export { evaluateTripwire } from './tripwire.js';
export { assignLane } from './assign.js';
export { parseLaneSet, type ParseLaneSetResult } from './schema.js';
export { resolveForMode } from './resolve-mode.js';
export { capPolicy, evaluateMergeEligibility } from './eligibility.js';
export { evaluateEarnIn } from './earn-in.js';
