// packages/daemon/src/control-plane/lane-engine/risk.ts
import type { RiskLevel, RiskPathMap } from './types.js';
import { matchesAny } from './match.js';

/** Risk levels ordered least → most cautious. Index = caution rank. */
export const RISK_ORDER: readonly RiskLevel[] = ['green', 'yellow', 'orange', 'red'];

/** The most cautious of the given levels. At least one level is required. */
export function maxRiskLevel(first: RiskLevel, ...rest: RiskLevel[]): RiskLevel {
  return [first, ...rest].reduce((acc, level) =>
    RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(acc) ? level : acc,
  );
}

/**
 * Raise-only floor: the effective risk is the most cautious of the classifier
 * level and every risk-path entry whose patterns match a touched path. By
 * construction (a max over levels) a map entry can never lower a level.
 */
export function applyRiskPathFloor(
  classifierLevel: RiskLevel,
  riskPathMap: RiskPathMap,
  touchedPaths: string[],
): RiskLevel {
  const matchedFloors = riskPathMap
    .filter((entry) => touchedPaths.some((p) => matchesAny(p, entry.paths)))
    .map((entry) => entry.minLevel);
  return maxRiskLevel(classifierLevel, ...matchedFloors);
}
