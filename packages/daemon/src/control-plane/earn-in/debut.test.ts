import { describe, it, expect } from 'vitest';
import { isDebut } from './debut.js';
import type { WideningRecord } from '../deployment-registry/types.js';

const NOW = Date.UTC(2026, 6, 3);

describe('isDebut', () => {
  it('returns true for an empty history', () => {
    expect(isDebut([])).toBe(true);
  });

  it('returns false after any widened record', () => {
    const history: WideningRecord[] = [
      {
        deploymentId: 'd',
        riskClass: 'green',
        prior: 'human-gated',
        next: 'widened',
        authorization: { kind: 'operator-grant', operator: 'daniel' },
        recordedAt: NOW,
      },
    ];
    expect(isDebut(history)).toBe(false);
  });

  it('returns true when history contains only a demote', () => {
    const history: WideningRecord[] = [
      {
        deploymentId: 'd',
        riskClass: 'green',
        prior: 'widened',
        next: 'human-gated',
        authorization: { kind: 'demote-on-red', trigger: 'red' },
        recordedAt: NOW,
      },
    ];
    expect(isDebut(history)).toBe(true);
  });
});
