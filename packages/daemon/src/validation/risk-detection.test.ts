// src/validation/risk-detection.test.ts
import { describe, it, expect } from 'vitest';
import { isRiskSensitive } from './risk-detection.js';

describe('isRiskSensitive', () => {
  it('returns false when no signals match', () => {
    expect(isRiskSensitive(
      ['feature', 'bug'],
      'This feature adds a new dashboard widget with charts.',
      ['src/components/Dashboard.tsx', 'src/hooks/useChart.ts'],
    )).toBe(false);
  });

  it('detects risk from security label', () => {
    expect(isRiskSensitive(['security', 'feature'], '', [])).toBe(true);
  });

  it('detects risk from security-sensitive label', () => {
    expect(isRiskSensitive(['security-sensitive'], '', [])).toBe(true);
  });

  it('detects risk from auth label', () => {
    expect(isRiskSensitive(['auth'], '', [])).toBe(true);
  });

  it('is case-insensitive for labels', () => {
    expect(isRiskSensitive(['Security'], '', [])).toBe(true);
    expect(isRiskSensitive(['AUTH'], '', [])).toBe(true);
  });

  it('detects risk from auth keyword in spec content', () => {
    expect(isRiskSensitive([], 'The user must authenticate with auth tokens.', [])).toBe(true);
  });

  it('detects risk from credential keyword in spec content', () => {
    expect(isRiskSensitive([], 'Store user credential in database.', [])).toBe(true);
  });

  it('detects risk from payment keyword in spec content', () => {
    expect(isRiskSensitive([], 'Handle payment processing via Stripe.', [])).toBe(true);
  });

  it('detects risk from encrypt keyword in spec content', () => {
    expect(isRiskSensitive([], 'Encrypt sensitive data at rest.', [])).toBe(true);
  });

  it('detects risk from token keyword in spec content', () => {
    expect(isRiskSensitive([], 'Generate a JWT token for each user.', [])).toBe(true);
  });

  it('detects risk from password keyword in spec content', () => {
    expect(isRiskSensitive([], 'User enters password to login.', [])).toBe(true);
  });

  it('detects risk from secret keyword in spec content', () => {
    expect(isRiskSensitive([], 'Load secrets from environment variables.', [])).toBe(true);
  });

  it('detects risk from permission keyword in spec content', () => {
    expect(isRiskSensitive([], 'Check user permission before rendering.', [])).toBe(true);
  });

  it('detects risk from access control keyword in spec content', () => {
    expect(isRiskSensitive([], 'Implement access control for admin routes.', [])).toBe(true);
  });

  it('is case-insensitive for spec keywords', () => {
    expect(isRiskSensitive([], 'Token-based AUTH system.', [])).toBe(true);
  });

  it('detects risk from auth path pattern', () => {
    expect(isRiskSensitive([], '', ['src/auth/middleware.ts'])).toBe(true);
  });

  it('detects risk from security path pattern', () => {
    expect(isRiskSensitive([], '', ['src/security/validator.ts'])).toBe(true);
  });

  it('detects risk from payment path pattern', () => {
    expect(isRiskSensitive([], '', ['src/payment/processor.ts'])).toBe(true);
  });

  it('detects risk from credential filename pattern', () => {
    expect(isRiskSensitive([], '', ['src/credentialStore.ts'])).toBe(true);
  });

  it('does not match normal paths', () => {
    expect(isRiskSensitive([], '', ['src/components/Button.tsx', 'src/utils/format.ts'])).toBe(false);
  });

  it('accepts custom config', () => {
    const customConfig = {
      securityLabels: ['top-secret'],
      securityKeywords: ['nuclear'],
      securityPaths: ['**/classified/**'],
    };
    expect(isRiskSensitive(['top-secret'], '', [], customConfig)).toBe(true);
    expect(isRiskSensitive(['security'], '', [], customConfig)).toBe(false);
    expect(isRiskSensitive([], 'nuclear codes', [], customConfig)).toBe(true);
    expect(isRiskSensitive([], '', ['src/classified/data.ts'], customConfig)).toBe(true);
  });
});
