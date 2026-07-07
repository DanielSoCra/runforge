import { describe, expect, it } from 'vitest';
import { isLoopbackHost, assertBindAllowed, checkAuthorization, ControlBindError } from '../control-auth.js';

describe('control-plane auth primitives', () => {
  describe('assertBindAllowed', () => {
    it('allows loopback binds with or without a token', () => {
      expect(() => assertBindAllowed('127.0.0.1', undefined)).not.toThrow();
      expect(() => assertBindAllowed('127.0.0.1', 'tok')).not.toThrow();
    });

    it('requires a non-empty token for non-loopback binds', () => {
      expect(() => assertBindAllowed('0.0.0.0', undefined)).toThrow(ControlBindError);
      expect(() => assertBindAllowed('0.0.0.0', 'tok')).not.toThrow();
      expect(() => assertBindAllowed('10.0.0.5', '')).toThrow(ControlBindError);
    });
  });

  describe('isLoopbackHost', () => {
    it('recognizes only IPv4 127.0.0.0/8 loopback hosts', () => {
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('127.1.2.3')).toBe(true);
      expect(isLoopbackHost('0.0.0.0')).toBe(false);
      expect(isLoopbackHost('192.168.1.1')).toBe(false);
    });
  });

  describe('checkAuthorization', () => {
    const token = 'secrettoken';

    it('returns 401 when the Authorization header is missing', () => {
      expect(checkAuthorization(undefined, token)).toMatchObject({
        ok: false,
        status: 401,
      });
    });

    it('accepts the exact bearer token', () => {
      expect(checkAuthorization('Bearer secrettoken', token)).toEqual({ ok: true });
    });

    it('returns 403 for a same-length wrong bearer token', () => {
      expect(checkAuthorization('Bearer wrongtoken1', token)).toMatchObject({
        ok: false,
        status: 403,
      });
    });

    it('returns 403 without throwing for a different-length wrong bearer token', () => {
      let result: ReturnType<typeof checkAuthorization> | undefined;

      expect(() => {
        result = checkAuthorization('Bearer short', token);
      }).not.toThrow();

      expect(result).toMatchObject({
        ok: false,
        status: 403,
      });
    });

    it('returns 403 for non-bearer schemes', () => {
      expect(checkAuthorization('Basic secrettoken', token)).toMatchObject({
        ok: false,
        status: 403,
      });
    });
  });
});
