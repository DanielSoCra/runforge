import { describe, it, expect } from 'vitest';
import { extractStructuredOutput } from './structured-output.js';

describe('extractStructuredOutput', () => {
  it('returns nested structured_output when present', () => {
    const wrapper = { result: 'r', cost_usd: 0.01, structured_output: { compliant: true } };
    expect(extractStructuredOutput(wrapper)).toEqual({ compliant: true });
  });
  it('returns the input object when structured_output absent', () => {
    const raw = { compliant: false };
    expect(extractStructuredOutput(raw)).toBe(raw);
  });
  it('returns null unchanged', () => {
    expect(extractStructuredOutput(null)).toBeNull();
  });
  it('returns primitives unchanged', () => {
    expect(extractStructuredOutput('string')).toBe('string');
    expect(extractStructuredOutput(42)).toBe(42);
  });
  it('returns input when structured_output is null', () => {
    const wrapper = { result: 'r', structured_output: null };
    expect(extractStructuredOutput(wrapper)).toBe(wrapper);
  });
});
