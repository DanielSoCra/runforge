// src/control-plane/error-hash.test.ts
import { describe, it, expect } from 'vitest';
import {
  normalizeError,
  hashError,
  isCircularError,
  recordErrorHash,
} from './error-hash.js';

describe('normalizeError', () => {
  it('strips ISO 8601 timestamps', () => {
    const error = 'Failed at 2026-03-19T10:23:45.123Z during build';
    const normalized = normalizeError(error);
    expect(normalized).not.toContain('2026-03-19T10:23:45.123Z');
    expect(normalized).toContain('<TIMESTAMP>');
  });

  it('strips Unix timestamps (10+ digits)', () => {
    const error = 'Error at epoch 1742380800000 in pipeline';
    const normalized = normalizeError(error);
    expect(normalized).not.toContain('1742380800000');
    expect(normalized).toContain('<TIMESTAMP>');
  });

  it('strips line:col references', () => {
    const error = 'SyntaxError: src/foo.ts:42:17 unexpected token';
    const normalized = normalizeError(error);
    expect(normalized).not.toMatch(/:\d+:\d+/);
    expect(normalized).toContain(':<LINE>');
  });

  it('strips "line N" references (case-insensitive)', () => {
    const error = 'Parse error at Line 88 in module';
    const normalized = normalizeError(error);
    expect(normalized).not.toMatch(/line \d+/i);
    expect(normalized).toContain('line <N>');
  });

  it('strips UUIDs', () => {
    const error = 'Session 550e8400-e29b-41d4-a716-446655440000 failed';
    const normalized = normalizeError(error);
    expect(normalized).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(normalized).toContain('<UUID>');
  });

  it('strips intermediate path segments (keeps basename)', () => {
    const error = 'Cannot find /home/user/projects/runforge/foo.ts module';
    const normalized = normalizeError(error);
    expect(normalized).toContain('.../');
  });

  it('produces same output for same logical error with different timestamps', () => {
    const e1 = 'Build failed at 2026-03-19T10:00:00Z: missing dependency';
    const e2 = 'Build failed at 2026-03-20T15:30:00Z: missing dependency';
    expect(normalizeError(e1)).toBe(normalizeError(e2));
  });

  it('trims whitespace', () => {
    const error = '  some error message  ';
    expect(normalizeError(error)).toBe('some error message');
  });
});

describe('hashError', () => {
  it('returns a 16-character hex string', () => {
    const hash = hashError('some error message');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('same logical error (different timestamps) produces same hash', () => {
    const e1 = 'Build failed at 2026-03-19T10:00:00Z: missing dependency';
    const e2 = 'Build failed at 2026-03-20T15:30:00Z: missing dependency';
    expect(hashError(e1)).toBe(hashError(e2));
  });

  it('same logical error (different line numbers) produces same hash', () => {
    const e1 = 'TypeError: cannot read property at:10:5';
    const e2 = 'TypeError: cannot read property at:99:12';
    expect(hashError(e1)).toBe(hashError(e2));
  });

  it('different errors produce different hashes', () => {
    const h1 = hashError('Module not found: react');
    const h2 = hashError('Module not found: lodash');
    expect(h1).not.toBe(h2);
  });

  it('same error text always produces same hash (deterministic)', () => {
    const msg = 'Connection refused at port 3000';
    expect(hashError(msg)).toBe(hashError(msg));
  });
});

describe('isCircularError', () => {
  it('returns false when count is below threshold', () => {
    expect(isCircularError('abc123', { abc123: 2 }, 3)).toBe(false);
  });

  it('returns true when count equals threshold', () => {
    expect(isCircularError('abc123', { abc123: 3 }, 3)).toBe(true);
  });

  it('returns true when count exceeds threshold', () => {
    expect(isCircularError('abc123', { abc123: 5 }, 3)).toBe(true);
  });

  it('returns false for unknown hash (count is 0)', () => {
    expect(isCircularError('newHash', {}, 3)).toBe(false);
  });

  it('uses default threshold of 3', () => {
    expect(isCircularError('abc123', { abc123: 3 })).toBe(true);
    expect(isCircularError('abc123', { abc123: 2 })).toBe(false);
  });
});

describe('recordErrorHash', () => {
  it('increments count for existing hash', () => {
    const before = { abc123: 2 };
    const after = recordErrorHash('abc123', before);
    expect(after['abc123']).toBe(3);
  });

  it('initializes count to 1 for new hash', () => {
    const after = recordErrorHash('newHash', {});
    expect(after['newHash']).toBe(1);
  });

  it('does not mutate the original record (immutable update)', () => {
    const original = { abc123: 1 };
    const after = recordErrorHash('abc123', original);
    expect(original['abc123']).toBe(1); // unchanged
    expect(after['abc123']).toBe(2);
  });

  it('preserves other hashes unchanged', () => {
    const before = { hash1: 2, hash2: 5 };
    const after = recordErrorHash('hash1', before);
    expect(after['hash2']).toBe(5);
    expect(after['hash1']).toBe(3);
  });
});
