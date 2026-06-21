/**
 * RED behavioral gate for `revealProtected` (Slice 5b) — the operator REVEAL flow
 * on the daemon Decision API (STACK-AC-OPERATOR-SURFACE-API).
 *
 * The handler injects a narrow `reveal` function so it is unit-testable without
 * the native decision-index. Pinned behavior:
 *   - valid ref belonging to decision → 200 with { field, value }
 *   - missing/empty ref → 400
 *   - malformed body (null/primitive/array) → 400
 *   - RevealRefNotFoundError / "not found" error → 404
 *   - any other throw → 503 fail-safe
 */
import { describe, it, expect } from 'vitest';
import { RevealRefNotFoundError } from '@auto-claude/decision-index';
import { revealProtected } from './decision-api.js';

function fakeReveal(
  result: { field: string; value: string },
): (id: string, ref: string, actor: string) => { field: string; value: string } {
  return (_id, _ref, _actor) => result;
}

function throwingReveal(
  error: Error,
): (id: string, ref: string, actor: string) => { field: string; value: string } {
  return () => {
    throw error;
  };
}

describe('revealProtected', () => {
  it('returns 200 with field + value for a valid ref', () => {
    const res = revealProtected(
      fakeReveal({ field: 'context', value: 'TOP-SECRET' }),
      'd-1',
      { ref: 'protected://01H' },
      'admin@example.com',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ field: 'context', value: 'TOP-SECRET' });
  });

  it('returns 400 when ref is missing', () => {
    const res = revealProtected(fakeReveal({ field: '', value: '' }), 'd-1', {}, 'admin@example.com');
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/ref/);
  });

  it('returns 400 when ref is empty string', () => {
    const res = revealProtected(
      fakeReveal({ field: '', value: '' }),
      'd-1',
      { ref: '' },
      'admin@example.com',
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed body (JSON null)', () => {
    const res = revealProtected(
      fakeReveal({ field: '', value: '' }),
      'd-1',
      null as unknown as { ref?: string },
      'admin@example.com',
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when the reveal function throws RevealRefNotFoundError', () => {
    const res = revealProtected(
      throwingReveal(new RevealRefNotFoundError('d-1', 'protected://nope')),
      'd-1',
      { ref: 'protected://nope' },
      'admin@example.com',
    );
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/ref not found/);
  });

  it('returns 404 for any "not found" error message', () => {
    const res = revealProtected(
      throwingReveal(new Error('decision not found')),
      'd-1',
      { ref: 'protected://nope' },
      'admin@example.com',
    );
    expect(res.status).toBe(404);
  });

  it('fail-safe: an unexpected throw maps to 503, never rethrows', () => {
    let res: { status: number } | undefined;
    expect(() => {
      res = revealProtected(
        throwingReveal(new Error('store corrupt')),
        'd-1',
        { ref: 'protected://01H' },
        'admin@example.com',
      );
    }).not.toThrow();
    expect(res?.status).toBe(503);
  });
});
