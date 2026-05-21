import { describe, expect, it } from 'vitest';
import { shouldIgnoreObservedPath } from './filters.js';

describe('observer path filters', () => {
  it('drops secrets and environment files before event emission', () => {
    expect(shouldIgnoreObservedPath('/repo/.env')).toBe(true);
    expect(shouldIgnoreObservedPath('/repo/secrets/token.txt')).toBe(true);
    expect(shouldIgnoreObservedPath('/repo/src/index.ts')).toBe(false);
  });
});
