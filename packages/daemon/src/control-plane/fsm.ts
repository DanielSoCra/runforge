// src/control-plane/fsm.ts
import type { Phase, PhaseEvent, PipelineVariant } from '../types.js';
import { specDrivenTransitions } from './spec-pipeline/variant.js';

export interface Transition {
  next: Phase;
}

export type TransitionTable = Partial<Record<Phase, Partial<Record<PhaseEvent, Transition>>>>;

export function transition(table: TransitionTable, current: Phase, event: PhaseEvent): Transition | undefined {
  return table[current]?.[event];
}

// Feature pipeline: detect → classify → decompose → implement → review → holdout → integrate → deploy → test → report
const featureTransitions: TransitionTable = {
  detect: { success: { next: 'classify' }, failure: { next: 'stuck' } },
  classify: {
    success: { next: 'decompose' },
    'success:simple': { next: 'implement' },
    failure: { next: 'stuck' },
  },
  decompose: { success: { next: 'implement' }, failure: { next: 'stuck' } },
  implement: { success: { next: 'review' }, failure: { next: 'implement' }, escalated: { next: 'stuck' } },
  review: { success: { next: 'holdout' }, failure: { next: 'implement' }, escalated: { next: 'stuck' } },
  holdout: { success: { next: 'integrate' }, failure: { next: 'implement' }, escalated: { next: 'stuck' } },
  integrate: { success: { next: 'deploy' }, failure: { next: 'stuck' } },
  deploy: { success: { next: 'test' }, failure: { next: 'stuck' } },
  test: { success: { next: 'report' }, failure: { next: 'implement' } },
  report: { success: { next: 'report' }, failure: { next: 'stuck' } }, // terminal — report success means done; failure → stuck (defense-in-depth, not retryable)
};

// Feature-simple: skips decompose
const featureSimpleTransitions: TransitionTable = {
  detect: { success: { next: 'classify' }, failure: { next: 'stuck' } },
  classify: {
    success: { next: 'implement' },
    'success:simple': { next: 'implement' },
    failure: { next: 'stuck' },
  },
  implement: { success: { next: 'review' }, failure: { next: 'implement' }, escalated: { next: 'stuck' } },
  review: { success: { next: 'holdout' }, failure: { next: 'implement' }, escalated: { next: 'stuck' } },
  holdout: { success: { next: 'integrate' }, failure: { next: 'implement' }, escalated: { next: 'stuck' } },
  integrate: { success: { next: 'deploy' }, failure: { next: 'stuck' } },
  deploy: { success: { next: 'test' }, failure: { next: 'stuck' } },
  test: { success: { next: 'report' }, failure: { next: 'implement' } },
  report: { success: { next: 'report' }, failure: { next: 'stuck' } },
};

// Bug: detect → implement → review → integrate → deploy → test → report (skips classify, decompose, holdout)
const bugTransitions: TransitionTable = {
  detect: { success: { next: 'implement' }, failure: { next: 'stuck' } },
  implement: { success: { next: 'review' }, failure: { next: 'implement' }, escalated: { next: 'stuck' } },
  review: { success: { next: 'integrate' }, failure: { next: 'implement' }, escalated: { next: 'stuck' } },
  integrate: { success: { next: 'deploy' }, failure: { next: 'stuck' } },
  deploy: { success: { next: 'test' }, failure: { next: 'stuck' } },
  test: { success: { next: 'report' }, failure: { next: 'implement' } },
  report: { success: { next: 'report' }, failure: { next: 'stuck' } },
};

const websiteTransitions: TransitionTable = {
  init:         { success: { next: 'intelligence' }, failure: { next: 'stuck' } },
  intelligence: { success: { next: 'brand' },        failure: { next: 'stuck' } },
  brand:        { success: { next: 'design' },        failure: { next: 'stuck' } },
  design:       { success: { next: 'seo' },           failure: { next: 'stuck' } },
  seo:          { success: { next: 'content' },       failure: { next: 'stuck' } },
  content:      { success: { next: 'assets' },        failure: { next: 'stuck' } },
  assets:       { success: { next: 'build' },         failure: { next: 'stuck' } },
  build:        { success: { next: 'qa' },            failure: { next: 'stuck' } },
  qa:           { success: { next: 'launch' },        failure: { next: 'stuck' } },
  // launch has no outbound transition — isComplete() handles it directly
};

const PIPELINES: Record<PipelineVariant, TransitionTable> = {
  feature: featureTransitions,
  'feature-simple': featureSimpleTransitions,
  bug: bugTransitions,
  website: websiteTransitions,
  'spec-driven': specDrivenTransitions,
  // The DAG registry falls back from adversarial-dev to feature until the
  // required reviewer/model-tier capabilities are present. This transition
  // table keeps persisted variant strings loadable during that staged rollout.
  'adversarial-dev': featureTransitions,
};

export function getPipeline(variant: PipelineVariant): TransitionTable {
  return PIPELINES[variant];
}

export function getStartPhase(variant: PipelineVariant): Phase {
  return variant === 'website' ? 'init' : 'detect';
}

export function isTerminal(phase: Phase): boolean {
  return phase === 'stuck' || phase === 'paused';
}

export function isComplete(phase: Phase, event: PhaseEvent): boolean {
  if (phase === 'report' && event === 'success') return true;
  if (phase === 'launch' && event === 'success') return true;
  return false;
}

// Global transitions that apply regardless of pipeline variant
export function applyGlobalTransition(event: PhaseEvent): Phase | undefined {
  if (event === 'budget-exceeded') return 'paused';
  if (event === 'per-run-budget-exceeded') return 'stuck';
  if (event === 'rate-limited') return 'paused';
  if (event === 'containment-breach') return 'stuck';
  return undefined;
}
