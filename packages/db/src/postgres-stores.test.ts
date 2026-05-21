import { describe, expect, it } from 'vitest';

import {
  decodeCredentialEnvelope,
  encodeCredentialEnvelope,
} from './postgres-stores.js';

describe('credential envelope storage encoding', () => {
  it('round-trips credential envelopes as bytea-safe JSON buffers', () => {
    const envelope = {
      v: 1 as const,
      iv: 'nonce',
      tag: 'tag',
      blob: 'ciphertext',
    };

    expect(
      decodeCredentialEnvelope(encodeCredentialEnvelope(envelope)),
    ).toEqual(envelope);
  });

  it('rejects unsupported envelope versions before decryption', () => {
    const encoded = Buffer.from(
      JSON.stringify({ v: 2, iv: 'nonce', tag: 'tag', blob: 'ciphertext' }),
      'utf8',
    );

    expect(() => decodeCredentialEnvelope(encoded)).toThrow(
      /unsupported credential envelope version: 2/,
    );
  });
});
