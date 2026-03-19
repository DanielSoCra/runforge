// src/validation/warmup.ts
import { writeJsonSafe, readJsonSafe } from '../lib/json-store.js';
import { ok, type Result } from '../lib/result.js';

export interface WarmupState {
  completionCount: number;
  graduated: boolean;
  consecutiveCorrections: number;
  threshold: number;
  regressionThreshold: number;
}

export function createInitialWarmupState(threshold: number = 10, regressionThreshold: number = 3): WarmupState {
  return {
    completionCount: 0,
    graduated: false,
    consecutiveCorrections: 0,
    threshold,
    regressionThreshold,
  };
}

export function recordCompletion(state: WarmupState): WarmupState {
  const next = { ...state, completionCount: state.completionCount + 1 };
  if (!next.graduated && next.completionCount >= next.threshold) {
    next.graduated = true;
  }
  return next;
}

export function recordCorrection(state: WarmupState): WarmupState {
  const next = { ...state, consecutiveCorrections: state.consecutiveCorrections + 1 };
  if (next.graduated && next.consecutiveCorrections >= next.regressionThreshold) {
    next.graduated = false;
    next.completionCount = 0;
    next.consecutiveCorrections = 0;
  }
  return next;
}

export function recordApprovalWithoutCorrection(state: WarmupState): WarmupState {
  return { ...state, consecutiveCorrections: 0 };
}

export function needsApproval(state: WarmupState): boolean {
  return !state.graduated;
}

export async function saveWarmupState(state: WarmupState, path: string): Promise<void> {
  await writeJsonSafe(path, state);
}

export async function loadWarmupState(path: string): Promise<Result<WarmupState>> {
  return readJsonSafe<WarmupState>(path);
}
