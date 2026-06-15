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
 * level and every touched path's floor. A path's floor is the max of the
 * risk-path entries it matches, or the deployment's configured default minimum
 * when it matches none (ARCH-AC-LANE-ENGINE: "unmatched paths fall through to
 * the deployment's configured default minimum"). By construction (a max over
 * levels) nothing here can ever lower a level.
 */
export function applyRiskPathFloor(
  classifierLevel: RiskLevel,
  riskPathMap: RiskPathMap,
  touchedPaths: string[],
  defaultMinLevel: RiskLevel,
): RiskLevel {
  const perPathFloors = touchedPaths.map((path) => {
    const matched = riskPathMap
      .filter((entry) => matchesAny(path, entry.paths))
      .map((entry) => entry.minLevel);
    return matched.length > 0 ? maxRiskLevel(matched[0]!, ...matched.slice(1)) : defaultMinLevel;
  });
  return maxRiskLevel(classifierLevel, ...perPathFloors);
}
