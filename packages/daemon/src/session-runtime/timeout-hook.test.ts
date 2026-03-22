import { describe, it, expect } from 'vitest';
import { TIMEOUT_WARNING_MESSAGE } from './timeout-hook.js';

describe('timeout-hook', () => {
  it('exports a non-empty warning message', () => {
    expect(typeof TIMEOUT_WARNING_MESSAGE).toBe('string');
    expect(TIMEOUT_WARNING_MESSAGE.length).toBeGreaterThan(0);
  });
});
