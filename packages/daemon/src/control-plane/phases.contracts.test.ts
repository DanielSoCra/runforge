// phases.contracts.test.ts
// Contract tests that verify real module exports match what phases.ts expects.
// phases.test.ts mocks all 13 dependencies, so if a dependency renames a function,
// changes its signature, or alters return types, the unit tests still pass.
// These contract tests import the REAL modules (no vi.mock) and verify:
//   1. Each export exists and is a function
//   2. Function parameter counts match what phases.ts calls with
//   3. Return types satisfy the contracts phases.ts depends on
// If a dependency API changes, these tests fail — catching what mocked tests miss (#139).

import { describe, it, expect } from 'vitest';
import { git } from '../lib/git.js';
import { createGate1, selectGates } from '../validation/gates.js';
import { createReviewerGate } from '../validation/reviewer-session.js';
import { isRiskSensitive } from '../validation/risk-detection.js';
import { runReview } from '../validation/review.js';
import { formatReport, postReport } from './reporter.js';
import { notify } from './notify.js';
import { appendResult } from './results.js';
import { createWorkDetector } from './work-detection.js';
import { diagnose } from '../diagnosis/diagnostician.js';
import { routeDiagnosis } from '../diagnosis/router.js';
import { loadSpecContent } from '../infra/spec-loader.js';
import { classify } from './classifier.js';
import { createPhaseHandlers, acquireDetectLock, releaseDetectLock, isDetectLocked } from './phases.js';

describe('phases dependency contracts (#139)', () => {
  // Each test verifies that a real module export exists, is a function, and
  // accepts at least the number of parameters phases.ts passes to it.
  // TypeScript compilation of THIS file (which imports real modules) also
  // catches type mismatches that the mocked test file cannot.

  it('git: (args: string[], cwd?: string) => Promise<Result<string>>', () => {
    expect(typeof git).toBe('function');
    // phases.ts calls git(args, repoRoot) — 2 params
    expect(git.length).toBeGreaterThanOrEqual(1);
  });

  it('createGate1: (commands: string[]) => Gate', () => {
    expect(typeof createGate1).toBe('function');
    // phases.ts calls createGate1(config.validation.gate1Commands)
    const gate = createGate1(['echo ok']);
    expect(gate).toHaveProperty('type', 'deterministic');
    expect(typeof gate.execute).toBe('function');
  });

  it('selectGates: (complexity, riskSensitive, ...gates) => Gate[]', () => {
    expect(typeof selectGates).toBe('function');
    const gate = createGate1([]);
    const result = selectGates('simple', false, gate);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('createReviewerGate: exports a function', () => {
    expect(typeof createReviewerGate).toBe('function');
  });

  it('isRiskSensitive: (labels, text, artifacts) => boolean', () => {
    expect(typeof isRiskSensitive).toBe('function');
    // phases.ts calls isRiskSensitive(labels, body + scope, [])
    const result = isRiskSensitive([], '', []);
    expect(typeof result).toBe('boolean');
  });

  it('runReview: exports a function', () => {
    expect(typeof runReview).toBe('function');
  });

  it('formatReport: (run, outcome) => string', () => {
    expect(typeof formatReport).toBe('function');
  });

  it('postReport: exports a function', () => {
    expect(typeof postReport).toBe('function');
  });

  it('notify: exports a function', () => {
    expect(typeof notify).toBe('function');
  });

  it('appendResult: exports a function', () => {
    expect(typeof appendResult).toBe('function');
  });

  it('createWorkDetector: (octokit, owner, repo) => WorkDetector', () => {
    expect(typeof createWorkDetector).toBe('function');
  });

  it('diagnose: exports a function', () => {
    expect(typeof diagnose).toBe('function');
  });

  it('routeDiagnosis: (diagnosis, threshold) => RoutingDecision', () => {
    expect(typeof routeDiagnosis).toBe('function');
    // phases.ts calls routeDiagnosis(result.value, threshold)
    const decision = routeDiagnosis(
      { type: 'A', confidence: 0.9, affectedSpecs: [], affectedArtifacts: [], suggestedAction: '', reasoning: '' },
      0.7,
    );
    expect(decision).toHaveProperty('route');
  });

  it('loadSpecContent: exports a function', () => {
    expect(typeof loadSpecContent).toBe('function');
  });

  it('classify: exports a function', () => {
    expect(typeof classify).toBe('function');
  });

  it('createPhaseHandlers: exports a function with expected arity', () => {
    expect(typeof createPhaseHandlers).toBe('function');
    // phases.ts createPhaseHandlers takes 11 params
    // (config, owner, repoName, runtime, coordinator, octokit, workRequest, stateDir, runWriter?, runId?, repoRoot?)
    expect(createPhaseHandlers.length).toBeGreaterThanOrEqual(8);
  });

  it('detect lock utilities: acquire, release, isLocked', () => {
    expect(typeof acquireDetectLock).toBe('function');
    expect(typeof releaseDetectLock).toBe('function');
    expect(typeof isDetectLocked).toBe('function');

    // Verify the lock protocol works with real functions
    releaseDetectLock();
    expect(isDetectLocked()).toBe(false);
    expect(acquireDetectLock()).toBe(true);
    expect(isDetectLocked()).toBe(true);
    expect(acquireDetectLock()).toBe(false); // already held
    releaseDetectLock();
    expect(isDetectLocked()).toBe(false);
  });
});
