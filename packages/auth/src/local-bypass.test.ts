import { describe, expect, it } from 'vitest';

import { findProductionIndicator, resolveLocalAuthBypass } from './local-bypass.js';

describe('resolveLocalAuthBypass', () => {
  it('is disabled by default', () => {
    expect(resolveLocalAuthBypass({})).toEqual({
      enabled: false,
      reason: 'not-requested',
    });
  });

  it('does not preserve the legacy AUTH_DISABLED bypass', () => {
    expect(resolveLocalAuthBypass({ AUTH_DISABLED: 'true' })).toEqual({
      enabled: false,
      reason: 'legacy-auth-disabled-ignored',
    });
  });

  it('enables only the explicit local bypass flag in a non-production context', () => {
    expect(
      resolveLocalAuthBypass({
        LOCAL_AUTH_BYPASS: 'true',
        NODE_ENV: 'development',
      }),
    ).toEqual({ enabled: true });
  });

  it('ignores AUTH_DISABLED when the replacement local bypass is explicitly set', () => {
    expect(
      resolveLocalAuthBypass({
        AUTH_DISABLED: 'true',
        LOCAL_AUTH_BYPASS: 'true',
        NODE_ENV: 'development',
      }),
    ).toEqual({ enabled: true });
  });

  it('refuses the bypass when a production indicator is present', () => {
    expect(
      resolveLocalAuthBypass({
        LOCAL_AUTH_BYPASS: 'true',
        NODE_ENV: 'production',
      }),
    ).toEqual({
      enabled: false,
      reason: 'production-indicator',
      indicator: 'NODE_ENV',
    });
  });

  it('treats deploy-platform markers as production indicators', () => {
    expect(findProductionIndicator({ VERCEL_ENV: 'production' })).toBe(
      'VERCEL_ENV',
    );
    expect(findProductionIndicator({ RENDER: 'true' })).toBe('RENDER');
    expect(findProductionIndicator({ FLY_APP_NAME: 'auto-claude' })).toBe(
      'FLY_APP_NAME',
    );
    expect(findProductionIndicator({ K_SERVICE: 'dashboard' })).toBe(
      'K_SERVICE',
    );
    expect(findProductionIndicator({ AWS_EXECUTION_ENV: 'AWS_Lambda' })).toBe(
      'AWS_EXECUTION_ENV',
    );
    expect(findProductionIndicator({ HEROKU_APP_NAME: 'auto-claude' })).toBe(
      'HEROKU_APP_NAME',
    );
  });
});
