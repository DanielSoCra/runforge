export const BUILD_TIME_ONLY_BETTER_AUTH_SECRET =
  'build-time-only-better-auth-secret-do-not-use-at-runtime';

export interface BetterAuthEnv {
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  NEXT_PHASE?: string;
  SKIP_ENV_VALIDATION?: string;
  npm_lifecycle_event?: string;
}

export function resolveBetterAuthBaseUrl(
  env: BetterAuthEnv = process.env,
): string | undefined {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL;
  return skipsValidationForBuild(env) ? 'http://localhost:3000' : undefined;
}

export function resolveBetterAuthSecret(
  env: BetterAuthEnv = process.env,
): string | undefined {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  if (!skipsEnvValidation(env)) return undefined;
  if (isBuildPhase(env)) return BUILD_TIME_ONLY_BETTER_AUTH_SECRET;
  throw new Error(
    'BETTER_AUTH_SECRET is required at runtime; SKIP_ENV_VALIDATION fallback is build-only',
  );
}

function skipsValidationForBuild(env: BetterAuthEnv): boolean {
  return skipsEnvValidation(env) && isBuildPhase(env);
}

function skipsEnvValidation(env: BetterAuthEnv): boolean {
  return env.SKIP_ENV_VALIDATION?.trim().toLowerCase() === 'true';
}

function isBuildPhase(env: BetterAuthEnv): boolean {
  return (
    env.NEXT_PHASE === 'phase-production-build' ||
    env.npm_lifecycle_event === 'build'
  );
}
