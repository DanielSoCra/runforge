// src/validation/sampling.ts
import { createHash } from 'crypto';

export interface SamplingConfig {
  rate: number;
  minRate: number;
}

export function shouldSample(
  issueNumber: number,
  config: SamplingConfig = { rate: 0.1, minRate: 0.01 },
): boolean {
  const effectiveRate = Math.max(config.rate, config.minRate);
  const hash = createHash('sha256').update(String(issueNumber)).digest();
  const value = hash.readUInt32BE(0) / 0xFFFFFFFF;
  return value < effectiveRate;
}
