import { describe, expect, it } from 'vitest';
import { createVaultPolicy } from './vault.js';

describe('vault access policy', () => {
  it('allows reads inside configured vault roots', () => {
    const policy = createVaultPolicy({
      vaultPath: '/vault',
      allowList: ['00-inbox', '10-projects'],
      confirmationRequired: ['20-Areas/clients'],
    });

    expect(policy.authorize('/vault/00-inbox/today.md', 'read')).toEqual({ decision: 'allow' });
    expect(policy.authorize('/vault/private.md', 'read')).toEqual({
      decision: 'deny',
      reason: 'path is outside allowed vault prefixes',
    });
  });

  it('requires confirmation for client-folder writes', () => {
    const policy = createVaultPolicy({
      vaultPath: '/vault',
      allowList: ['00-inbox', '20-Areas/clients'],
      confirmationRequired: ['20-Areas/clients'],
    });

    expect(policy.authorize('/vault/20-Areas/clients/acme/notes.md', 'write')).toEqual({
      decision: 'confirm',
      reason: 'vault write requires confirmation',
    });
  });
});
