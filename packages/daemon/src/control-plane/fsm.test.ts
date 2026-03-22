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

    it('report → failure → stuck (defense-in-depth, #107)', () => {
      expect(transition(table, 'report', 'failure')?.next).toBe('stuck');
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

    it('detect → success → diagnose (#48)', () => {
      expect(transition(table, 'detect', 'success')?.next).toBe('diagnose');
    });

    it('diagnose → success → implement (#48)', () => {
      expect(transition(table, 'diagnose', 'success')?.next).toBe('implement');
    });

    it('diagnose → failure → stuck (#48)', () => {
      expect(transition(table, 'diagnose', 'failure')?.next).toBe('stuck');
    });

    it('review → success → integrate (skip holdout)', () => {
      expect(transition(table, 'review', 'success')?.next).toBe('integrate');
    });

    it('report → failure → stuck (#107)', () => {
      expect(transition(table, 'report', 'failure')?.next).toBe('stuck');
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

    it('per-run-budget-exceeded → stuck (#92)', () => {
      expect(applyGlobalTransition('per-run-budget-exceeded')).toBe('stuck');
    });

    it('rate-limited → paused', () => {
      expect(applyGlobalTransition('rate-limited')).toBe('paused');
    });

    it('containment-breach → stuck (#208)', () => {
      expect(applyGlobalTransition('containment-breach')).toBe('stuck');
    });

    it('success has no global override', () => {
      expect(applyGlobalTransition('success')).toBeUndefined();
    });
  });

  describe('website pipeline', () => {
    const table = getPipeline('website');

    it('getStartPhase returns init for website', () => {
      expect(getStartPhase('website')).toBe('init');
    });

    it('init → success → intelligence', () => {
      expect(transition(table, 'init', 'success')?.next).toBe('intelligence');
    });

    it('init → failure → stuck', () => {
      expect(transition(table, 'init', 'failure')?.next).toBe('stuck');
    });

    it('intelligence → success → brand', () => {
      expect(transition(table, 'intelligence', 'success')?.next).toBe('brand');
    });

    it('brand → success → design', () => {
      expect(transition(table, 'brand', 'success')?.next).toBe('design');
    });

    it('design → success → seo', () => {
      expect(transition(table, 'design', 'success')?.next).toBe('seo');
    });

    it('seo → success → content', () => {
      expect(transition(table, 'seo', 'success')?.next).toBe('content');
    });

    it('content → success → assets', () => {
      expect(transition(table, 'content', 'success')?.next).toBe('assets');
    });

    it('assets → success → build', () => {
      expect(transition(table, 'assets', 'success')?.next).toBe('build');
    });

    it('build → success → qa', () => {
      expect(transition(table, 'build', 'success')?.next).toBe('qa');
    });

    it('qa → success → launch', () => {
      expect(transition(table, 'qa', 'success')?.next).toBe('launch');
    });

    it('isComplete returns true for launch + success', () => {
      expect(isComplete('launch', 'success')).toBe(true);
    });

    it('launch has no outbound transition', () => {
      expect(transition(table, 'launch', 'success')).toBeUndefined();
    });

    it('intelligence → failure → stuck', () => {
      expect(transition(table, 'intelligence', 'failure')?.next).toBe('stuck');
    });

    it('build → failure → stuck', () => {
      expect(transition(table, 'build', 'failure')?.next).toBe('stuck');
    });

    it('qa → failure → stuck', () => {
      expect(transition(table, 'qa', 'failure')?.next).toBe('stuck');
    });
  });
});
