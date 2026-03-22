// gate.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateGate, SPEC_LABEL_MAP, type GateComment } from './gate.js';

describe('evaluateGate', () => {
  const approval = 'l2-approved';
  const feedback = 'l2-in-progress';

  it('returns approved when approval label present', () => {
    const result = evaluateGate([approval], [], approval, feedback);
    expect(result).toEqual({ status: 'approved' });
  });

  it('returns feedback when feedback label present with comments', () => {
    const comments: GateComment[] = [
      { body: 'Please revise section 3', createdAt: '2026-03-22T10:00:00Z' },
    ];
    const result = evaluateGate([feedback], comments, approval, feedback);
    expect(result).toEqual({ status: 'feedback', content: 'Please revise section 3' });
  });

  it('concatenates multiple comments with separator', () => {
    const comments: GateComment[] = [
      { body: 'Fix A', createdAt: '2026-03-22T10:00:00Z' },
      { body: 'Fix B', createdAt: '2026-03-22T10:01:00Z' },
    ];
    const result = evaluateGate([feedback], comments, approval, feedback);
    expect(result).toEqual({ status: 'feedback', content: 'Fix A\n---\nFix B' });
  });

  it('returns unchanged when feedback label present but no comments', () => {
    const result = evaluateGate([feedback], [], approval, feedback);
    expect(result).toEqual({ status: 'unchanged' });
  });

  it('returns unchanged when neither label present', () => {
    const result = evaluateGate(['some-other-label'], [], approval, feedback);
    expect(result).toEqual({ status: 'unchanged' });
  });

  it('returns unchanged on empty labels', () => {
    const result = evaluateGate([], [], approval, feedback);
    expect(result).toEqual({ status: 'unchanged' });
  });

  it('approval takes priority over feedback', () => {
    const comments: GateComment[] = [{ body: 'feedback', createdAt: '2026-03-22T10:00:00Z' }];
    const result = evaluateGate([approval, feedback], comments, approval, feedback);
    expect(result).toEqual({ status: 'approved' });
  });
});

describe('SPEC_LABEL_MAP', () => {
  it('l2-gate has approval and feedback labels', () => {
    const map = SPEC_LABEL_MAP['l2-gate'];
    expect(map.approval).toBe('l2-approved');
    expect(map.feedback).toBe('l2-in-progress');
  });

  it('l2-design has inProgress label', () => {
    expect(SPEC_LABEL_MAP['l2-design'].inProgress).toBe('l2-in-progress');
  });

  it('l3-generate has inProgress label', () => {
    expect(SPEC_LABEL_MAP['l3-generate'].inProgress).toBe('l3-in-progress');
  });

  it('l3-compliance has inProgress label', () => {
    expect(SPEC_LABEL_MAP['l3-compliance'].inProgress).toBe('l3-review');
  });
});
