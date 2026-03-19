import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, unwrap, mapResult } from './result.js';

describe('Result', () => {
  it('ok wraps a value', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err wraps an error', () => {
    const r = err(new Error('fail'));
    expect(isErr(r)).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('unwrap returns value for ok', () => {
    expect(unwrap(ok(42))).toBe(42);
  });

  it('unwrap throws for err', () => {
    expect(() => unwrap(err(new Error('fail')))).toThrow('fail');
  });

  it('unwrap throws for non-Error err', () => {
    expect(() => unwrap(err('string error'))).toThrow('string error');
  });

  it('mapResult transforms ok values', () => {
    const r = mapResult(ok(2), (n) => n * 3);
    expect(unwrap(r)).toBe(6);
  });

  it('mapResult passes through err', () => {
    const r = mapResult(err(new Error('fail')), (n: number) => n * 3);
    expect(isErr(r)).toBe(true);
  });
});
