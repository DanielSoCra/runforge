// src/session-runtime/session-error.test.ts
import { describe, it, expect } from 'vitest';
import { SessionError } from './session-error.js';

describe('SessionError', () => {
  it('carries cost, rateLimited, and containmentBreach flags', () => {
    const err = new SessionError('test', 1.5, true, false);
    expect(err.cost).toBe(1.5);
    expect(err.rateLimited).toBe(true);
    expect(err.containmentBreach).toBe(false);
    expect(err.name).toBe('SessionError');
  });

  it('defaults cost to 0 and flags to false', () => {
    const err = new SessionError('test');
    expect(err.cost).toBe(0);
    expect(err.rateLimited).toBe(false);
    expect(err.containmentBreach).toBe(false);
  });

  describe('static factory methods', () => {
    it('budgetExceeded creates error with zero cost and no flags', () => {
      const err = SessionError.budgetExceeded('daily-budget-exceeded');
      expect(err.message).toContain('Budget exceeded');
      expect(err.message).toContain('daily-budget-exceeded');
      expect(err.cost).toBe(0);
      expect(err.rateLimited).toBe(false);
      expect(err.containmentBreach).toBe(false);
      expect(err).toBeInstanceOf(SessionError);
    });

    it('rateLimited creates error with cost and rateLimited flag', () => {
      const err = SessionError.rateLimited(0.42, 5000);
      expect(err.message).toContain('Rate limited');
      expect(err.message).toContain('5s');
      expect(err.cost).toBe(0.42);
      expect(err.rateLimited).toBe(true);
      expect(err.containmentBreach).toBe(false);
    });

    it('rateLimited works without remainingMs', () => {
      const err = SessionError.rateLimited(0.1);
      expect(err.message).toBe('Rate limited');
      expect(err.cost).toBe(0.1);
      expect(err.rateLimited).toBe(true);
    });

    it('containmentBreached creates error with cost and containmentBreach flag', () => {
      const err = SessionError.containmentBreached('.specify/scenarios/secret.md', 0.07);
      expect(err.message).toContain('Containment breach');
      expect(err.message).toContain('.specify/scenarios/secret.md');
      expect(err.cost).toBe(0.07);
      expect(err.rateLimited).toBe(false);
      expect(err.containmentBreach).toBe(true);
    });
  });
});
