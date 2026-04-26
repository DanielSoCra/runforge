// variant.ts — Spec-driven pipeline variant definition
// Governed by: STACK-AC-SPEC-PIPELINE

import type { Phase, WorkRequest } from '../../types.js';
import type { TransitionTable } from '../fsm.js';

/**
 * Phase type classifies how the FSM executes a phase.
 */
export type SpecPhaseType = 'session' | 'gate' | 'delegated';

/**
 * Definition for a single phase in the spec-driven pipeline.
 */
export interface SpecPhaseDefinition {
  readonly name: Phase;
  readonly type: SpecPhaseType;
  readonly sessionType: string | null;
  readonly retryable: boolean;
  readonly maxRetries: number;
}

/**
 * The ten-phase sequence for the spec-driven pipeline variant.
 * Frozen literal — phase sequence requires code review to change.
 *
 * From L2 (ARCH-AC-SPEC-PIPELINE):
 *   detect, l2-design, l2-gate, l3-generate, l3-compliance,
 *   implement, review, holdout, integrate, report
 */
export const specDrivenPhases: readonly SpecPhaseDefinition[] = Object.freeze([
  { name: 'detect',         type: 'session',    sessionType: null,                   retryable: false, maxRetries: 0 },
  { name: 'l2-design',      type: 'session',    sessionType: 'l2-designer',          retryable: true,  maxRetries: 3 },
  { name: 'l2-gate',        type: 'gate',       sessionType: null,                   retryable: false, maxRetries: 0 },
  { name: 'l3-generate',    type: 'session',    sessionType: 'l3-generator',         retryable: true,  maxRetries: 3 },
  { name: 'l3-compliance',  type: 'session',    sessionType: 'compliance-reviewer',  retryable: true,  maxRetries: 3 },
  { name: 'implement',      type: 'delegated',  sessionType: null,                   retryable: true,  maxRetries: 3 },
  { name: 'review',         type: 'delegated',  sessionType: null,                   retryable: true,  maxRetries: 3 },
  { name: 'holdout',        type: 'delegated',  sessionType: null,                   retryable: false, maxRetries: 0 }, // retryable=false: no phase-level self-loop; fix-cycle retry is via FSM (holdout.failure → implement)
  { name: 'integrate',      type: 'delegated',  sessionType: null,                   retryable: false, maxRetries: 0 },
  { name: 'report',         type: 'session',    sessionType: null,                   retryable: false, maxRetries: 0 },
] as const);

/**
 * Transition table for the spec-driven pipeline variant.
 *
 * Key differences from feature pipeline:
 * - Adds l2-design, l2-gate, l3-generate, l3-compliance phases
 * - l2-gate supports 'feedback' event (backward to l2-design)
 * - l2-gate parks the run via pausedAtPhase when awaiting human review
 * - l3-compliance failure loops back to l3-generate
 */
export const specDrivenTransitions: TransitionTable = {
  detect:          { success: { next: 'l2-design' }, failure: { next: 'stuck' } },
  'l2-design':     { success: { next: 'l2-gate' }, failure: { next: 'l2-design' } },
  'l2-gate':       {
    success: { next: 'l3-generate' },
    feedback: { next: 'l2-design' },
    failure: { next: 'stuck' },
  },
  'l3-generate':   { success: { next: 'l3-compliance' }, failure: { next: 'l3-generate' } },
  'l3-compliance': {
    success: { next: 'implement' },
    failure: { next: 'l3-generate' },
    escalated: { next: 'stuck' },
  },
  implement:       { success: { next: 'review' }, failure: { next: 'implement' } },
  review:          { success: { next: 'holdout' }, failure: { next: 'implement' }, escalated: { next: 'stuck' } },
  holdout:         { success: { next: 'integrate' }, failure: { next: 'implement' }, escalated: { next: 'stuck' } },
  integrate:       { success: { next: 'report' }, failure: { next: 'stuck' } },
  report:          { success: { next: 'report' }, failure: { next: 'stuck' } },
};

/**
 * Checks if a work request should be routed to the spec-driven variant.
 *
 * Selector criteria (from L3 spec):
 *   - Issue has the `feature-pipeline` label
 *   - Issue body contains a spec chain reference (L1 spec path)
 *
 * L3 gotcha: if `feature-pipeline` is present but no spec reference found,
 * log a warning and fall through to default variant.
 */
export function isSpecDrivenRequest(request: WorkRequest): boolean {
  const hasLabel = request.labels.includes('feature-pipeline');
  if (!hasLabel) return false;

  const hasSpecRef = request.specRefs.length > 0
    || /\.specify\//.test(request.body)
    || /FUNC-|ARCH-|STACK-/.test(request.body);

  if (!hasSpecRef) {
    console.warn(
      `[spec-pipeline] Issue #${request.issueNumber} has feature-pipeline label but no spec reference in body — falling through to default variant`,
    );
    return false;
  }

  return true;
}

/**
 * Returns the phase definition for a given phase name, or undefined if not found.
 */
export function getPhaseDefinition(phase: Phase): SpecPhaseDefinition | undefined {
  return specDrivenPhases.find(p => p.name === phase);
}
