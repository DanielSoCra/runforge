// src/validation/risk-detection.ts
import { minimatch } from 'minimatch';

export interface RiskConfig {
  securityLabels: string[];
  securityKeywords: string[];
  securityPaths: string[];
}

const DEFAULT_CONFIG: RiskConfig = {
  securityLabels: ['security', 'security-sensitive', 'auth'],
  securityKeywords: ['auth', 'credential', 'payment', 'encrypt', 'token', 'password', 'secret', 'permission', 'access control'],
  securityPaths: ['**/auth/**', '**/security/**', '**/payment/**', '**/credential*'],
};

export function isRiskSensitive(
  labels: string[],
  specContent: string,
  artifactPaths: string[],
  config: RiskConfig = DEFAULT_CONFIG,
): boolean {
  // Signal 1: Label match
  if (labels.some((l) => config.securityLabels.includes(l.toLowerCase()))) return true;

  // Signal 2: Spec content keyword match
  const lowerContent = specContent.toLowerCase();
  if (config.securityKeywords.some((kw) => lowerContent.includes(kw))) return true;

  // Signal 3: Artifact path match
  if (artifactPaths.some((path) =>
    config.securityPaths.some((pattern) => minimatch(path, pattern, { dot: true })),
  )) return true;

  return false;
}
