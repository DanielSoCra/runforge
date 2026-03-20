// src/control-plane/fsm.ts
import type { Phase, PhaseEvent, PipelineVariant } from '../types.js';

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
  implement: { success: { next: 'review' }, failure: { next: 'implement' } },
  review: { success: { next: 'holdout' }, failure: { next: 'implement' } },
  holdout: { success: { next: 'integrate' }, failure: { next: 'stuck' } },
  integrate: { success: { next: 'deploy' }, failure: { next: 'stuck' } },
  deploy: { success: { next: 'test' }, failure: { next: 'stuck' } },
  test: { success: { next: 'report' }, failure: { next: 'implement' } },
  report: { success: { next: 'report' } }, // terminal — report success means done
};

// Feature-simple: skips decompose
const featureSimpleTransitions: TransitionTable = {
  detect: { success: { next: 'classify' }, failure: { next: 'stuck' } },
  classify: {
    success: { next: 'implement' },
    'success:simple': { next: 'implement' },
    failure: { next: 'stuck' },
  },
  implement: { success: { next: 'review' }, failure: { next: 'implement' } },
  review: { success: { next: 'holdout' }, failure: { next: 'implement' } },
  holdout: { success: { next: 'integrate' }, failure: { next: 'stuck' } },
  integrate: { success: { next: 'deploy' }, failure: { next: 'stuck' } },
  deploy: { success: { next: 'test' }, failure: { next: 'stuck' } },
  test: { success: { next: 'report' }, failure: { next: 'implement' } },
  report: { success: { next: 'report' } },
};

// Bug: skips classify, decompose, holdout
const bugTransitions: TransitionTable = {
  detect: { success: { next: 'implement' }, failure: { next: 'stuck' } },
  implement: { success: { next: 'review' }, failure: { next: 'implement' } },
  review: { success: { next: 'integrate' }, failure: { next: 'implement' } },
  integrate: { success: { next: 'deploy' }, failure: { next: 'stuck' } },
  deploy: { success: { next: 'test' }, failure: { next: 'stuck' } },
  test: { success: { next: 'report' }, failure: { next: 'implement' } },
  report: { success: { next: 'report' } },
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
  qa:           { success: { next: 'launch' },        failure: { next: 'build' } },
  launch:       { success: { next: 'report' } },
};

const PIPELINES: Record<PipelineVariant, TransitionTable> = {
  feature: featureTransitions,
  'feature-simple': featureSimpleTransitions,
  bug: bugTransitions,
  website: websiteTransitions,
};

export function getPipeline(variant: PipelineVariant): TransitionTable {
  return PIPELINES[variant];
}

export function getStartPhase(_variant: PipelineVariant): Phase {
  return 'detect';
}

export function isTerminal(phase: Phase): boolean {
  return phase === 'stuck' || phase === 'paused';
}

export function isComplete(phase: Phase, event: PhaseEvent): boolean {
  return phase === 'report' && event === 'success';
}

// Global transitions that apply regardless of pipeline variant
export function applyGlobalTransition(event: PhaseEvent): Phase | undefined {
  if (event === 'budget-exceeded') return 'paused';
  if (event === 'rate-limited') return 'paused';
  return undefined;
}
