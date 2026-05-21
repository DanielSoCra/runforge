import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface CredentialEnvelopeV1 {
  v: 1;
  iv: string;
  tag: string;
  blob: string;
}

export type CredentialEnvelope = CredentialEnvelopeV1;

export interface CredentialEnv {
  ENCRYPTION_KEY?: string;
}

export function readCredentialKey(
  env: CredentialEnv = process.env as CredentialEnv,
): Buffer {
  const encoded = env.ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error('ENCRYPTION_KEY is required for credential encryption');
  }
  return decodeCredentialKey(encoded);
}

export function decodeCredentialKey(encoded: string): Buffer {
  const trimmed = encoded.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64url');
  if (key.length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM',
    );
  }
  return key;
}

export function encryptCredential(
  plaintext: string,
  key: Buffer,
  aad: string,
): CredentialEnvelope {
  if (key.length !== 32) {
    throw new Error('credential encryption key must be exactly 32 bytes');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const blob = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    blob: blob.toString('base64url'),
  };
}

export function decryptCredential(
  envelope: CredentialEnvelope,
  key: Buffer,
  aad: string,
): string {
  if (envelope.v !== 1) {
    throw new Error(
      `unsupported credential envelope version: ${String(envelope.v)}`,
    );
  }
  if (key.length !== 32) {
    throw new Error('credential decryption key must be exactly 32 bytes');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.blob, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
