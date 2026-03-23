// src/validation/proactive-scheduler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProactiveScheduler, type ProactiveState } from './proactive-scheduler.js';

describe('ProactiveScheduler', () => {
  const areas = ['src/validation', 'src/knowledge', 'src/control-plane'];

  describe('pickNextArea', () => {
    it('picks the area with the oldest lastReviewedAt', () => {
      const state: ProactiveState = {
        lastReviewedAt: {
          'src/validation': '2026-03-23T10:00:00Z',
          'src/knowledge': '2026-03-22T10:00:00Z',
          'src/control-plane': '2026-03-23T12:00:00Z',
        },
        cycleIndex: 0,
      };
      const result = ProactiveScheduler.pickNextArea(state, areas);
      expect(result).toBe('src/knowledge');
    });

    it('picks area never reviewed (no timestamp) first', () => {
      const state: ProactiveState = {
        lastReviewedAt: {
          'src/validation': '2026-03-23T10:00:00Z',
        },
        cycleIndex: 0,
      };
      const result = ProactiveScheduler.pickNextArea(state, areas);
      // src/knowledge and src/control-plane have no timestamp, picks first one
      expect(result).toBe('src/knowledge');
    });

    it('picks first area when all have same timestamp', () => {
      const ts = '2026-03-23T10:00:00Z';
      const state: ProactiveState = {
        lastReviewedAt: {
          'src/validation': ts,
          'src/knowledge': ts,
          'src/control-plane': ts,
        },
        cycleIndex: 0,
      };
      const result = ProactiveScheduler.pickNextArea(state, areas);
      expect(result).toBe('src/validation');
    });

    it('returns undefined for empty areas array', () => {
      const state: ProactiveState = { lastReviewedAt: {}, cycleIndex: 0 };
      const result = ProactiveScheduler.pickNextArea(state, []);
      expect(result).toBeUndefined();
    });
  });

  describe('shouldThrottle', () => {
    it('returns false when active workers below threshold', () => {
      const result = ProactiveScheduler.shouldThrottle(5, 10, 0.8);
      expect(result).toBe(false);
    });

    it('returns true when active workers at or above threshold', () => {
      const result = ProactiveScheduler.shouldThrottle(8, 10, 0.8);
      expect(result).toBe(true);
    });

    it('returns true when active workers exceed threshold', () => {
      const result = ProactiveScheduler.shouldThrottle(9, 10, 0.8);
      expect(result).toBe(true);
    });
  });

  describe('updateState', () => {
    it('updates lastReviewedAt for the reviewed area and increments cycleIndex', () => {
      const state: ProactiveState = {
        lastReviewedAt: {},
        cycleIndex: 0,
      };
      const updated = ProactiveScheduler.updateState(state, 'src/validation');
      expect(updated.lastReviewedAt['src/validation']).toBeDefined();
      expect(updated.cycleIndex).toBe(1);
    });

    it('preserves other area timestamps', () => {
      const state: ProactiveState = {
        lastReviewedAt: {
          'src/knowledge': '2026-03-22T10:00:00Z',
        },
        cycleIndex: 5,
      };
      const updated = ProactiveScheduler.updateState(state, 'src/validation');
      expect(updated.lastReviewedAt['src/knowledge']).toBe('2026-03-22T10:00:00Z');
      expect(updated.lastReviewedAt['src/validation']).toBeDefined();
      expect(updated.cycleIndex).toBe(6);
    });
  });

  describe('formatFindingBody', () => {
    it('formats finding as structured markdown', () => {
      const body = ProactiveScheduler.formatFindingBody({
        title: 'Dead code detected',
        severity: 'minor',
        location: 'src/utils.ts:42',
        description: 'Unused helper function',
        evidence: 'No callers found via grep',
      });
      expect(body).toContain('**Severity:** minor');
      expect(body).toContain('**Location:** src/utils.ts:42');
      expect(body).toContain('Unused helper function');
      expect(body).toContain('No callers found via grep');
    });
  });

  describe('emptyState', () => {
    it('creates a fresh state', () => {
      const state = ProactiveScheduler.emptyState();
      expect(state.lastReviewedAt).toEqual({});
      expect(state.cycleIndex).toBe(0);
    });
  });
});
