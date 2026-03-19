// src/session-runtime/repetition.ts
import { createHash } from 'crypto';

export interface RepetitionDetector {
  record(toolName: string, input: unknown): boolean; // returns true if blocked
  reset(): void;
}

export function createRepetitionDetector(maxConsecutive: number = 5): RepetitionDetector {
  let lastHash: string | null = null;
  let consecutiveCount = 0;

  return {
    record(toolName: string, input: unknown): boolean {
      const hash = createHash('sha256')
        .update(toolName + JSON.stringify(input))
        .digest('hex');

      if (hash === lastHash) {
        consecutiveCount++;
        return consecutiveCount >= maxConsecutive;
      }

      lastHash = hash;
      consecutiveCount = 1;
      return false;
    },

    reset(): void {
      lastHash = null;
      consecutiveCount = 0;
    },
  };
}
