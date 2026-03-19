// src/control-plane/error-hash.ts
import { createHash } from 'crypto';

export function normalizeError(error: string): string {
  return error
    // Strip UUIDs first (before timestamp stripping, to avoid partial UUID matches)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    // Strip timestamps (ISO 8601, Unix timestamps, time-like patterns)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\dZ]*/g, '<TIMESTAMP>')
    .replace(/\b\d{10,13}\b/g, '<TIMESTAMP>')
    // Strip line numbers
    .replace(/:\d+:\d+/g, ':<LINE>')
    .replace(/line \d+/gi, 'line <N>')
    // Strip file-specific paths (keep basename)
    .replace(/\/[\w./-]+\//g, '.../')
    .trim();
}

export function hashError(error: string): string {
  const normalized = normalizeError(error);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function isCircularError(
  errorHash: string,
  errorHashes: Record<string, number>,
  threshold: number = 3,
): boolean {
  return (errorHashes[errorHash] ?? 0) >= threshold;
}

export function recordErrorHash(
  errorHash: string,
  errorHashes: Record<string, number>,
): Record<string, number> {
  return {
    ...errorHashes,
    [errorHash]: (errorHashes[errorHash] ?? 0) + 1,
  };
}
