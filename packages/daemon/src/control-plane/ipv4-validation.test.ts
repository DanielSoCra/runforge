import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isIP } from 'node:net';

/**
 * Regression test for issue #155 (BUG-24):
 * DAEMON_HOST validation must reject invalid IPv4 addresses like "256.0.0.1".
 * The daemon uses node:net isIP() — these tests verify the behavior we rely on.
 */
describe('DAEMON_HOST IPv4 validation (node:net isIP)', () => {
  it('accepts valid IPv4 addresses', () => {
    expect(isIP('0.0.0.0')).toBe(4);
    expect(isIP('127.0.0.1')).toBe(4);
    expect(isIP('192.168.1.1')).toBe(4);
    expect(isIP('255.255.255.255')).toBe(4);
    expect(isIP('10.0.0.1')).toBe(4);
  });

  it('rejects octets > 255', () => {
    expect(isIP('256.0.0.1')).toBe(0);
    expect(isIP('0.256.0.0')).toBe(0);
    expect(isIP('0.0.300.0')).toBe(0);
    expect(isIP('0.0.0.999')).toBe(0);
  });

  it('rejects leading zeros (ambiguous octal interpretation)', () => {
    expect(isIP('01.0.0.1')).toBe(0);
    expect(isIP('192.168.001.001')).toBe(0);
  });

  it('rejects malformed addresses', () => {
    expect(isIP('')).toBe(0);
    expect(isIP('localhost')).toBe(0);
    expect(isIP('1.2.3')).toBe(0);
    expect(isIP('1.2.3.4.5')).toBe(0);
    expect(isIP('1.2.3.4a')).toBe(0);
    expect(isIP('-1.0.0.0')).toBe(0);
  });
});
