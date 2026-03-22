import { describe, it, expect } from 'vitest';
import { isConnectionError } from './fallback.js';

describe('isConnectionError', () => {
  it('returns true for ECONNREFUSED', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:3000');
    (error as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    expect(isConnectionError(error)).toBe(true);
  });

  it('returns true for ENOTFOUND', () => {
    const error = new Error('getaddrinfo ENOTFOUND localhost');
    (error as NodeJS.ErrnoException).code = 'ENOTFOUND';
    expect(isConnectionError(error)).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    const error = new Error('connect ETIMEDOUT');
    (error as NodeJS.ErrnoException).code = 'ETIMEDOUT';
    expect(isConnectionError(error)).toBe(true);
  });

  it('returns true when message contains ECONNREFUSED without code', () => {
    const error = new Error('Request failed: ECONNREFUSED');
    expect(isConnectionError(error)).toBe(true);
  });

  it('returns false for application-level errors', () => {
    const error = new Error('Budget exceeded: daily limit reached');
    expect(isConnectionError(error)).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isConnectionError('some string')).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
    expect(isConnectionError(42)).toBe(false);
  });

  it('returns false for generic errors', () => {
    const error = new Error('Something went wrong');
    expect(isConnectionError(error)).toBe(false);
  });
});
