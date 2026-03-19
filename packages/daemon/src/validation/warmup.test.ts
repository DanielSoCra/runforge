// src/validation/warmup.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  createInitialWarmupState,
  recordCompletion,
  recordCorrection,
  recordApprovalWithoutCorrection,
  needsApproval,
  saveWarmupState,
  loadWarmupState,
} from './warmup.js';

vi.mock('../lib/json-store.js', () => ({
  writeJsonSafe: vi.fn(),
  readJsonSafe: vi.fn(),
}));

import { writeJsonSafe, readJsonSafe } from '../lib/json-store.js';

const mockWriteJsonSafe = writeJsonSafe as ReturnType<typeof vi.fn>;
const mockReadJsonSafe = readJsonSafe as ReturnType<typeof vi.fn>;

describe('createInitialWarmupState', () => {
  it('starts ungraduated with zero counts', () => {
    const state = createInitialWarmupState();
    expect(state.graduated).toBe(false);
    expect(state.completionCount).toBe(0);
    expect(state.consecutiveCorrections).toBe(0);
  });

  it('uses default threshold of 10', () => {
    const state = createInitialWarmupState();
    expect(state.threshold).toBe(10);
  });

  it('uses default regressionThreshold of 3', () => {
    const state = createInitialWarmupState();
    expect(state.regressionThreshold).toBe(3);
  });

  it('accepts custom threshold and regressionThreshold', () => {
    const state = createInitialWarmupState(5, 2);
    expect(state.threshold).toBe(5);
    expect(state.regressionThreshold).toBe(2);
  });
});

describe('recordCompletion', () => {
  it('increments completionCount', () => {
    const state = createInitialWarmupState();
    const next = recordCompletion(state);
    expect(next.completionCount).toBe(1);
  });

  it('does not mutate original state', () => {
    const state = createInitialWarmupState();
    recordCompletion(state);
    expect(state.completionCount).toBe(0);
  });

  it('graduates after reaching threshold', () => {
    let state = createInitialWarmupState(3);
    state = recordCompletion(state);
    state = recordCompletion(state);
    expect(state.graduated).toBe(false);
    state = recordCompletion(state);
    expect(state.graduated).toBe(true);
  });

  it('does not change graduated status once graduated', () => {
    let state = createInitialWarmupState(2);
    state = recordCompletion(state);
    state = recordCompletion(state);
    expect(state.graduated).toBe(true);
    state = recordCompletion(state);
    expect(state.graduated).toBe(true);
  });
});

describe('recordCorrection', () => {
  it('increments consecutiveCorrections', () => {
    const state = createInitialWarmupState();
    const next = recordCorrection(state);
    expect(next.consecutiveCorrections).toBe(1);
  });

  it('does not mutate original state', () => {
    const state = createInitialWarmupState();
    recordCorrection(state);
    expect(state.consecutiveCorrections).toBe(0);
  });

  it('regresses graduated agent after consecutive corrections', () => {
    let state = createInitialWarmupState(2, 3);
    // Graduate first
    state = recordCompletion(state);
    state = recordCompletion(state);
    expect(state.graduated).toBe(true);

    // Apply corrections up to threshold
    state = recordCorrection(state);
    state = recordCorrection(state);
    expect(state.graduated).toBe(true); // Not yet regressed

    state = recordCorrection(state);
    expect(state.graduated).toBe(false); // Regressed
    expect(state.completionCount).toBe(0);
    expect(state.consecutiveCorrections).toBe(0);
  });

  it('does not regress ungraduated agent', () => {
    let state = createInitialWarmupState(10, 3);
    state = recordCorrection(state);
    state = recordCorrection(state);
    state = recordCorrection(state);
    expect(state.graduated).toBe(false);
    expect(state.consecutiveCorrections).toBe(3);
  });
});

describe('recordApprovalWithoutCorrection', () => {
  it('resets consecutiveCorrections to zero', () => {
    let state = createInitialWarmupState();
    state = { ...state, consecutiveCorrections: 2 };
    const next = recordApprovalWithoutCorrection(state);
    expect(next.consecutiveCorrections).toBe(0);
  });

  it('does not mutate original state', () => {
    const state = { ...createInitialWarmupState(), consecutiveCorrections: 2 };
    recordApprovalWithoutCorrection(state);
    expect(state.consecutiveCorrections).toBe(2);
  });

  it('preserves other state fields', () => {
    let state = createInitialWarmupState(5, 2);
    state = recordCompletion(state);
    state = recordCompletion(state);
    state = recordCompletion(state);
    state = { ...state, consecutiveCorrections: 1 };

    const next = recordApprovalWithoutCorrection(state);
    expect(next.completionCount).toBe(3);
    expect(next.threshold).toBe(5);
    expect(next.consecutiveCorrections).toBe(0);
  });
});

describe('needsApproval', () => {
  it('returns true when not graduated', () => {
    const state = createInitialWarmupState();
    expect(needsApproval(state)).toBe(true);
  });

  it('returns false when graduated', () => {
    let state = createInitialWarmupState(1);
    state = recordCompletion(state);
    expect(needsApproval(state)).toBe(false);
  });
});

describe('saveWarmupState', () => {
  it('calls writeJsonSafe with path and state', async () => {
    mockWriteJsonSafe.mockResolvedValue(undefined);
    const state = createInitialWarmupState();
    await saveWarmupState(state, '/tmp/warmup.json');
    expect(mockWriteJsonSafe).toHaveBeenCalledWith('/tmp/warmup.json', state);
  });
});

describe('loadWarmupState', () => {
  it('returns result from readJsonSafe', async () => {
    const state = createInitialWarmupState();
    mockReadJsonSafe.mockResolvedValue({ ok: true, value: state });

    const result = await loadWarmupState('/tmp/warmup.json');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(state);
    }
    expect(mockReadJsonSafe).toHaveBeenCalledWith('/tmp/warmup.json');
  });

  it('returns err when readJsonSafe fails', async () => {
    mockReadJsonSafe.mockResolvedValue({ ok: false, error: new Error('file not found') });

    const result = await loadWarmupState('/tmp/missing.json');
    expect(result.ok).toBe(false);
  });
});
