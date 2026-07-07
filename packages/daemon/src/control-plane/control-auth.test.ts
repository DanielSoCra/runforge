import { describe, expect, it } from 'vitest';
import {
  isLoopbackHost,
  assertBindAllowed,
  checkAuthorization,
  ControlBindError,
} from './control-auth.js';

describe('isLoopbackHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['127.255.255.255', true],
    ['0.0.0.0', false],
    ['192.168.1.1', false],
    ['10.0.0.1', false],
    ['::1', false],
    ['localhost', false],
  ])('isLoopbackHost(%s) === %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe('assertBindAllowed', () => {
  it.each([
    ['127.0.0.1', undefined, false],
    ['127.0.0.1', 'token', false],
    ['127.1.2.3', '', false],
    ['0.0.0.0', undefined, true],
    ['0.0.0.0', '', true],
    ['192.168.1.1', 'token', false],
    ['10.0.0.5', 'token', false],
  ])(
    'assertBindAllowed(%s, %s) throws=%s',
    (host, token, shouldThrow) => {
      if (shouldThrow) {
        expect(() => assertBindAllowed(host, token)).toThrow(ControlBindError);
      } else {
        expect(() => assertBindAllowed(host, token)).not.toThrow();
      }
    },
  );

  it('includes an actionable message for non-loopback + no token', () => {
    expect(() => assertBindAllowed('0.0.0.0', undefined)).toThrow(
      /Non-loopback control bind .* requires RUNFORGE_CONTROL_TOKEN/,
    );
  });
});

describe('checkAuthorization', () => {
  const token = 'secrettoken';

  it('returns 401 when the header is missing', () => {
    expect(checkAuthorization(undefined, token)).toEqual({
      ok: false,
      status: 401,
      error: 'Authorization header required',
    });
  });

  it('accepts the exact bearer token', () => {
    expect(checkAuthorization('Bearer secrettoken', token)).toEqual({ ok: true });
  });

  it('returns 403 for a same-length wrong token', () => {
    expect(checkAuthorization('Bearer wrongtoken1', token)).toEqual({
      ok: false,
      status: 403,
      error: 'Invalid control token',
    });
  });

  it('returns 403 without throwing for a different-length wrong token', () => {
    expect(() => {
      checkAuthorization('Bearer short', token);
    }).not.toThrow();
    expect(checkAuthorization('Bearer short', token)).toEqual({
      ok: false,
      status: 403,
      error: 'Invalid control token',
    });
  });

  it('returns 403 for non-bearer schemes', () => {
    expect(checkAuthorization('Basic secrettoken', token)).toEqual({
      ok: false,
      status: 403,
      error: 'Invalid control token',
    });
  });

  it('normalizes an array header to its first element', () => {
    expect(checkAuthorization(['Bearer secrettoken'], token)).toEqual({ ok: true });
    expect(checkAuthorization(['Bearer wrongtoken1'], token)).toEqual({
      ok: false,
      status: 403,
      error: 'Invalid control token',
    });
  });
});
