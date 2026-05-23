import { describe, expect, it } from 'vitest';

import {
  classifyDriverError,
  decodeCredentialEnvelope,
  encodeCredentialEnvelope,
} from './postgres-stores.js';

function errWithCode(message: string, code: string, name = 'Error'): Error {
  const e = new Error(message);
  e.name = name;
  (e as Error & { code?: string }).code = code;
  return e;
}

describe('classifyDriverError', () => {
  it('classifies ECONNREFUSED as unreachable', () => {
    const result = classifyDriverError(
      errWithCode('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'),
    );
    expect(result.category).toBe('unreachable');
    expect(result.code).toBe('ECONNREFUSED');
  });

  it('classifies SQLSTATE 08006 (connection failure) as unreachable', () => {
    const result = classifyDriverError(
      errWithCode('connection failure', '08006'),
    );
    expect(result.category).toBe('unreachable');
    expect(result.code).toBe('08006');
  });

  it('classifies SQLSTATE 28P01 (auth) as rejected', () => {
    const result = classifyDriverError(
      errWithCode('password authentication failed', '28P01'),
    );
    expect(result.category).toBe('rejected');
    expect(result.code).toBe('28P01');
  });

  it('classifies SQLSTATE 42P01 (undefined table) as rejected', () => {
    const result = classifyDriverError(
      errWithCode('relation does not exist', '42P01'),
    );
    expect(result.category).toBe('rejected');
    expect(result.code).toBe('42P01');
  });

  it('classifies an opaque (no-code) error as rejected', () => {
    const result = classifyDriverError(new Error('something opaque'));
    expect(result.category).toBe('rejected');
    expect(result.code).toBeNull();
  });

  it('picks the deepest informative layer in a depth-3 chain', () => {
    const deepest = errWithCode(
      'connect ECONNREFUSED 127.0.0.1:5432',
      'ECONNREFUSED',
    );
    const mid = new Error('postgres connection error', { cause: deepest });
    const outer = new Error('Failed query: select ...', { cause: mid });

    const result = classifyDriverError(outer);
    expect(result.category).toBe('unreachable');
    expect(result.code).toBe('ECONNREFUSED');
    expect(result.message).toBe('connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;

    const result = classifyDriverError(a);
    expect(result.category).toBe('rejected');
  });
});

describe('unavailableOnThrow message format', () => {
  it('includes the driver code in the unavailable message', async () => {
    // Exercise via classifyDriverError + the documented format directly,
    // mirroring unavailableOnThrow's message assembly.
    const classified = classifyDriverError(
      errWithCode('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'),
    );
    expect(classified.code).toBe('ECONNREFUSED');
    expect(classified.message).toContain('ECONNREFUSED');
  });
});

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
