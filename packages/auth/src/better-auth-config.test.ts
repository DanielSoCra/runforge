import { describe, expect, it } from 'vitest';

import {
  BUILD_TIME_ONLY_BETTER_AUTH_SECRET,
  resolveBetterAuthBaseUrl,
  resolveBetterAuthSecret,
} from './better-auth-config.js';

describe('Better Auth config helpers', () => {
  it('uses explicit runtime configuration when present', () => {
    expect(
      resolveBetterAuthBaseUrl({ BETTER_AUTH_URL: 'https://app.example.test' }),
    ).toBe('https://app.example.test');
    expect(resolveBetterAuthSecret({ BETTER_AUTH_SECRET: 'secret' })).toBe(
      'secret',
    );
  });

  it('keeps missing runtime values explicit', () => {
    expect(resolveBetterAuthBaseUrl({})).toBeUndefined();
    expect(resolveBetterAuthSecret({})).toBeUndefined();
    expect(
      resolveBetterAuthSecret({ SKIP_ENV_VALIDATION: 'false' }),
    ).toBeUndefined();
  });

  it('allows placeholder values only during builds with env validation skipped', () => {
    const env = {
      SKIP_ENV_VALIDATION: 'true',
      NEXT_PHASE: 'phase-production-build',
    };

    expect(resolveBetterAuthBaseUrl(env)).toBe('http://localhost:3000');
    expect(resolveBetterAuthSecret(env)).toBe(
      BUILD_TIME_ONLY_BETTER_AUTH_SECRET,
    );
  });

  it('rejects skipped validation at runtime for the auth secret', () => {
    expect(() =>
      resolveBetterAuthSecret({ SKIP_ENV_VALIDATION: 'true' }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });
});
