import { describe, expect, it } from 'vitest';

import { gateDecision, type ResolvedOperatorSession } from './gate-decision.js';

function session(role: ResolvedOperatorSession['user']['role']) {
  return { user: { id: 'operator-1', role } };
}

describe('gateDecision', () => {
  it('redirects unauthenticated operators to login', () => {
    expect(gateDecision(null)).toBe('/login');
  });

  it('allows authenticated viewers to pass viewer gates', () => {
    expect(gateDecision(session('viewer'))).toBeNull();
  });

  it('allows admins to pass admin gates', () => {
    expect(gateDecision(session('admin'), { requiredRole: 'admin' })).toBeNull();
  });

  it('denies viewers at admin gates without redirecting', () => {
    expect(gateDecision(session('viewer'), { requiredRole: 'admin' })).toBe(
      'deny',
    );
  });

  it('denies sessions that do not resolve to a known role', () => {
    expect(gateDecision(session(null))).toBe('deny');
    expect(gateDecision({ user: { id: 'operator-1', role: 'owner' } })).toBe(
      'deny',
    );
  });

  it('allows the explicit local bypass to synthesize access', () => {
    expect(gateDecision(null, { localBypass: true })).toBeNull();
    expect(
      gateDecision(null, { localBypass: true, requiredRole: 'admin' }),
    ).toBeNull();
  });
});
