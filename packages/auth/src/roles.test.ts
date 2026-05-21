import { describe, expect, it } from 'vitest';

import { isOperatorRole, roleAllows } from './roles.js';

describe('operator roles', () => {
  it('recognizes the current dashboard role values', () => {
    expect(isOperatorRole('admin')).toBe(true);
    expect(isOperatorRole('viewer')).toBe(true);
    expect(isOperatorRole('administrator')).toBe(false);
    expect(isOperatorRole(undefined)).toBe(false);
  });

  it('lets admins perform viewer and admin actions', () => {
    expect(roleAllows('admin', 'viewer')).toBe(true);
    expect(roleAllows('admin', 'admin')).toBe(true);
  });

  it('keeps viewers read-only', () => {
    expect(roleAllows('viewer', 'viewer')).toBe(true);
    expect(roleAllows('viewer', 'admin')).toBe(false);
  });
});
