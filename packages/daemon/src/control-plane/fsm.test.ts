// src/control-plane/fsm.test.ts
import { describe, it, expect } from 'vitest';
import { transition, getPipeline, getStartPhase, isTerminal, isComplete, applyGlobalTransition } from './fsm.js';

describe('FSM', () => {
  describe('feature pipeline', () => {
    const table = getPipeline('feature');

    it('starts at detect', () => {
      expect(getStartPhase('feature')).toBe('detect');
    });

    it('detect → success → classify', () => {
      expect(transition(table, 'detect', 'success')?.next).toBe('classify');
    });

    it('classify → success → decompose', () => {
      expect(transition(table, 'classify', 'success')?.next).toBe('decompose');
    });

    it('classify → success:simple → implement (skip decompose)', () => {
      expect(transition(table, 'classify', 'success:simple')?.next).toBe('implement');
    });

    it('implement → success → review', () => {
      expect(transition(table, 'implement', 'success')?.next).toBe('review');
    });

    it('implement → failure → implement (retry)', () => {
      expect(transition(table, 'implement', 'failure')?.next).toBe('implement');
    });

    it('review → success → holdout', () => {
      expect(transition(table, 'review', 'success')?.next).toBe('holdout');
    });

    it('review → failure → implement (fix cycle)', () => {
      expect(transition(table, 'review', 'failure')?.next).toBe('implement');
    });

    it('report → success is terminal (complete)', () => {
      expect(isComplete('report', 'success')).toBe(true);
    });
  });

  describe('feature-simple pipeline', () => {
    const table = getPipeline('feature-simple');

    it('classify → success → implement (no decompose)', () => {
      expect(transition(table, 'classify', 'success')?.next).toBe('implement');
    });
  });

  describe('bug pipeline', () => {
    const table = getPipeline('bug');

    it('detect → success → implement (skip classify)', () => {
      expect(transition(table, 'detect', 'success')?.next).toBe('implement');
    });

    it('review → success → integrate (skip holdout)', () => {
      expect(transition(table, 'review', 'success')?.next).toBe('integrate');
    });
  });

  describe('terminal states', () => {
    it('stuck is terminal', () => {
      expect(isTerminal('stuck')).toBe(true);
    });

    it('paused is terminal', () => {
      expect(isTerminal('paused')).toBe(true);
    });

    it('implement is not terminal', () => {
      expect(isTerminal('implement')).toBe(false);
    });
  });

  describe('global transitions', () => {
    it('budget-exceeded → paused', () => {
      expect(applyGlobalTransition('budget-exceeded')).toBe('paused');
    });

    it('rate-limited → paused', () => {
      expect(applyGlobalTransition('rate-limited')).toBe('paused');
    });

    it('success has no global override', () => {
      expect(applyGlobalTransition('success')).toBeUndefined();
    });
  });
});
