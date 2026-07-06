export interface OperatorAuthEnv {
  AUTH_DISABLED?: string;
  LOCAL_AUTH_BYPASS?: string;
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  RUNFORGE_ENV?: string;
  RUNFORGE_DEPLOYMENT?: string;
  RAILWAY_ENVIRONMENT?: string;
  RENDER?: string;
  FLY_APP_NAME?: string;
  K_SERVICE?: string;
  AWS_EXECUTION_ENV?: string;
  HEROKU_APP_NAME?: string;
}

export type LocalBypassDecision =
  | { enabled: true }
  | {
      enabled: false;
      reason:
        | 'not-requested'
        | 'legacy-auth-disabled-ignored'
        | 'production-indicator';
      indicator?: string;
    };

export function resolveLocalAuthBypass(
  env: OperatorAuthEnv = process.env,
): LocalBypassDecision {
  if (!isTrue(env.LOCAL_AUTH_BYPASS)) {
    if (isTrue(env.AUTH_DISABLED)) {
      return { enabled: false, reason: 'legacy-auth-disabled-ignored' };
    }
    return { enabled: false, reason: 'not-requested' };
  }

  const productionIndicator = findProductionIndicator(env);
  if (productionIndicator) {
    return {
      enabled: false,
      reason: 'production-indicator',
      indicator: productionIndicator,
    };
  }

  return { enabled: true };
}

export function findProductionIndicator(
  env: OperatorAuthEnv,
): string | null {
  if (isProduction(env.NODE_ENV)) return 'NODE_ENV';
  if (isProduction(env.VERCEL_ENV)) return 'VERCEL_ENV';
  if (isProduction(env.RUNFORGE_ENV)) return 'RUNFORGE_ENV';
  if (isProduction(env.RUNFORGE_DEPLOYMENT)) {
    return 'RUNFORGE_DEPLOYMENT';
  }
  if (isProduction(env.RAILWAY_ENVIRONMENT)) return 'RAILWAY_ENVIRONMENT';
  if (isTrue(env.RENDER)) return 'RENDER';
  if (isPresent(env.FLY_APP_NAME)) return 'FLY_APP_NAME';
  if (isPresent(env.K_SERVICE)) return 'K_SERVICE';
  if (isPresent(env.AWS_EXECUTION_ENV)) return 'AWS_EXECUTION_ENV';
  if (isPresent(env.HEROKU_APP_NAME)) return 'HEROKU_APP_NAME';
  return null;
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function isProduction(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'production';
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}
