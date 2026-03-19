// src/session-runtime/repetition.test.ts
import { describe, it, expect } from 'vitest';
import { createRepetitionDetector } from './repetition.js';

describe('createRepetitionDetector', () => {
  it('allows unique calls', () => {
    const detector = createRepetitionDetector(3);
    expect(detector.record('Read', { file: 'a.ts' })).toBe(false);
    expect(detector.record('Write', { file: 'b.ts' })).toBe(false);
    expect(detector.record('Bash', { command: 'ls' })).toBe(false);
  });

  it('allows alternating calls', () => {
    const detector = createRepetitionDetector(3);
    for (let i = 0; i < 6; i++) {
      const tool = i % 2 === 0 ? 'Read' : 'Write';
      expect(detector.record(tool, { file: 'a.ts' })).toBe(false);
    }
  });

  it('does not block before reaching maxConsecutive', () => {
    const detector = createRepetitionDetector(5);
    for (let i = 0; i < 4; i++) {
      expect(detector.record('Read', { file_path: 'src/main.ts' })).toBe(false);
    }
  });

  it('blocks exactly at maxConsecutive identical calls', () => {
    const detector = createRepetitionDetector(5);
    for (let i = 0; i < 4; i++) {
      detector.record('Read', { file_path: 'src/main.ts' });
    }
    expect(detector.record('Read', { file_path: 'src/main.ts' })).toBe(true);
  });

  it('resets consecutive count on a different call', () => {
    const detector = createRepetitionDetector(3);
    detector.record('Read', { file_path: 'a.ts' });
    detector.record('Read', { file_path: 'a.ts' });
    // Different call resets count
    expect(detector.record('Write', { file_path: 'b.ts' })).toBe(false);
    // Now two more identical won't block
    expect(detector.record('Read', { file_path: 'a.ts' })).toBe(false);
    expect(detector.record('Read', { file_path: 'a.ts' })).toBe(false);
    // Third identical should block
    expect(detector.record('Read', { file_path: 'a.ts' })).toBe(true);
  });

  it('reset() clears state so blocking resets', () => {
    const detector = createRepetitionDetector(3);
    detector.record('Read', { file_path: 'a.ts' });
    detector.record('Read', { file_path: 'a.ts' });
    detector.record('Read', { file_path: 'a.ts' }); // blocked (count = 3)

    detector.reset();

    // After reset, same call should not be blocked
    expect(detector.record('Read', { file_path: 'a.ts' })).toBe(false);
    expect(detector.record('Read', { file_path: 'a.ts' })).toBe(false);
  });

  it('uses default maxConsecutive of 5 when not specified', () => {
    const detector = createRepetitionDetector();
    for (let i = 0; i < 4; i++) {
      expect(detector.record('Bash', { command: 'pnpm test' })).toBe(false);
    }
    expect(detector.record('Bash', { command: 'pnpm test' })).toBe(true);
  });

  it('treats calls with same tool but different inputs as different', () => {
    const detector = createRepetitionDetector(3);
    expect(detector.record('Read', { file_path: 'a.ts' })).toBe(false);
    expect(detector.record('Read', { file_path: 'b.ts' })).toBe(false);
    expect(detector.record('Read', { file_path: 'c.ts' })).toBe(false);
    expect(detector.record('Read', { file_path: 'd.ts' })).toBe(false);
  });
});
