import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decodeCredentialKey,
  decryptCredential,
  encryptCredential,
  readCredentialKey,
} from './credential-crypto.js';

describe('credential crypto', () => {
  it('round-trips plaintext with AES-256-GCM and matching AAD', () => {
    const key = randomBytes(32);
    const envelope = encryptCredential('ghp_secret', key, 'connection-1');

    expect(decryptCredential(envelope, key, 'connection-1')).toBe('ghp_secret');
    expect(envelope.v).toBe(1);
    expect(Buffer.from(envelope.iv, 'base64url')).toHaveLength(12);
  });

  it('uses a different IV for repeated encryption of the same secret', () => {
    const key = randomBytes(32);
    const first = encryptCredential(
      'same-secret',
      key,
      'repo-1:source-control',
    );
    const second = encryptCredential(
      'same-secret',
      key,
      'repo-1:source-control',
    );

    expect(first.iv).not.toBe(second.iv);
    expect(first.blob).not.toBe(second.blob);
  });

  it('refuses to decrypt when the authenticated identifier changes', () => {
    const key = randomBytes(32);
    const envelope = encryptCredential('ghp_secret', key, 'connection-1');

    expect(() => decryptCredential(envelope, key, 'connection-2')).toThrow();
  });

  it('requires ENCRYPTION_KEY and rejects non-256-bit keys', () => {
    expect(() => readCredentialKey({})).toThrow(/ENCRYPTION_KEY/);
    expect(() =>
      decodeCredentialKey(Buffer.from('short').toString('base64url')),
    ).toThrow(/32 bytes/);
  });

  it('accepts hex and base64url encoded 32-byte keys', () => {
    const key = randomBytes(32);

    expect(decodeCredentialKey(key.toString('hex'))).toEqual(key);
    expect(decodeCredentialKey(key.toString('base64url'))).toEqual(key);
  });
});
