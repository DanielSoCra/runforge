// src/validation/sampling.test.ts
import { describe, it, expect } from 'vitest';
import { shouldSample } from './sampling.js';

describe('shouldSample', () => {
  it('is deterministic — same issue number always yields same result', () => {
    const config = { rate: 0.5, minRate: 0.01 };
    const result1 = shouldSample(42, config);
    const result2 = shouldSample(42, config);
    const result3 = shouldSample(42, config);
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
  });

  it('different issue numbers can yield different results', () => {
    // With rate 0.5, statistically very unlikely all produce same result
    const config = { rate: 0.5, minRate: 0.01 };
    const results = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => shouldSample(n, config)),
    );
    expect(results.size).toBeGreaterThan(1);
  });

  it('rate 1.0 always samples', () => {
    const config = { rate: 1.0, minRate: 0.01 };
    for (const issue of [1, 2, 3, 42, 100, 999, 12345]) {
      expect(shouldSample(issue, config)).toBe(true);
    }
  });

  it('rate 0.0 still samples at minRate floor', () => {
    const config = { rate: 0.0, minRate: 0.01 };
    // With minRate of 0.01, some issues should be sampled
    // We test a large enough range to find at least one sample
    const results = Array.from({ length: 500 }, (_, i) => shouldSample(i + 1, config));
    expect(results.some(Boolean)).toBe(true);
  });

  it('respects minimum floor — rate below minRate is clamped to minRate', () => {
    const withZeroRate = { rate: 0.0, minRate: 0.01 };
    const withMinRate = { rate: 0.01, minRate: 0.01 };
    // Both configs should produce identical results since rate is clamped to minRate
    for (const issue of [1, 2, 3, 42, 100, 999]) {
      expect(shouldSample(issue, withZeroRate)).toBe(shouldSample(issue, withMinRate));
    }
  });

  it('uses default config when none provided', () => {
    // Should not throw; result should be deterministic
    const result1 = shouldSample(42);
    const result2 = shouldSample(42);
    expect(result1).toBe(result2);
  });

  it('rate 0.01 (minimum) still samples some issues', () => {
    const config = { rate: 0.01, minRate: 0.01 };
    const results = Array.from({ length: 500 }, (_, i) => shouldSample(i + 1, config));
    expect(results.some(Boolean)).toBe(true);
  });

  it('higher rate samples more issues than lower rate', () => {
    const lowConfig = { rate: 0.1, minRate: 0.01 };
    const highConfig = { rate: 0.9, minRate: 0.01 };
    const issues = Array.from({ length: 200 }, (_, i) => i + 1);
    const lowCount = issues.filter((n) => shouldSample(n, lowConfig)).length;
    const highCount = issues.filter((n) => shouldSample(n, highConfig)).length;
    expect(highCount).toBeGreaterThan(lowCount);
  });
});
