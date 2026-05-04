import type { ServiceOwner, WorkflowDefinition, WorkflowNode } from './workflow-types.js';

function task(
  phase: string,
  owner: ServiceOwner,
  next?: string,
): WorkflowNode {
  return { kind: 'task', phase, owner, ...(next ? { next } : {}) };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

const feature = {
  variant: 'feature',
  entryNode: 'detect',
  nodes: {
    detect: task('detect', 'ControlPlane', 'classify'),
    classify: task('classify', 'SessionRuntime', 'decompose'),
    decompose: task('decompose', 'ImplementationCoordinator', 'implement'),
    implement: task('implement', 'ImplementationCoordinator', 'review'),
    review: task('review', 'ValidationService', 'holdout'),
    holdout: task('holdout', 'ValidationService', 'integrate'),
    integrate: task('integrate', 'ControlPlane', 'deploy'),
    deploy: task('deploy', 'ValidationService', 'test'),
    test: task('test', 'ValidationService', 'report'),
    report: task('report', 'ControlPlane'),
  },
  labelMap: {
    detect: 'detect',
    classify: 'classify',
    decompose: 'decompose',
    implement: 'implement',
    review: 'review',
    holdout: 'holdout',
    integrate: 'integrate',
    deploy: 'deploy',
    test: 'test',
    report: 'report',
  },
} satisfies WorkflowDefinition;

const featureSimple = {
  variant: 'feature-simple',
  entryNode: 'detect',
  nodes: {
    detect: task('detect', 'ControlPlane', 'classify'),
    classify: task('classify', 'SessionRuntime', 'implement'),
    implement: task('implement', 'ImplementationCoordinator', 'review'),
    review: task('review', 'ValidationService', 'holdout'),
    holdout: task('holdout', 'ValidationService', 'integrate'),
    integrate: task('integrate', 'ControlPlane', 'deploy'),
    deploy: task('deploy', 'ValidationService', 'test'),
    test: task('test', 'ValidationService', 'report'),
    report: task('report', 'ControlPlane'),
  },
  labelMap: {
    detect: 'detect',
    classify: 'classify',
    implement: 'implement',
    review: 'review',
    holdout: 'holdout',
    integrate: 'integrate',
    deploy: 'deploy',
    test: 'test',
    report: 'report',
  },
} satisfies WorkflowDefinition;

const bug = {
  variant: 'bug',
  entryNode: 'detect',
  nodes: {
    detect: task('detect', 'ControlPlane', 'implement'),
    implement: task('implement', 'ImplementationCoordinator', 'review'),
    review: task('review', 'ValidationService', 'integrate'),
    integrate: task('integrate', 'ControlPlane', 'deploy'),
    deploy: task('deploy', 'ValidationService', 'test'),
    test: task('test', 'ValidationService', 'report'),
    report: task('report', 'ControlPlane'),
  },
  labelMap: {
    detect: 'detect',
    implement: 'implement',
    review: 'review',
    integrate: 'integrate',
    deploy: 'deploy',
    test: 'test',
    report: 'report',
  },
} satisfies WorkflowDefinition;

const adversarialDev = {
  variant: 'adversarial-dev',
  entryNode: 'detect',
  nodes: {
    detect: task('detect', 'ControlPlane', 'classify'),
    classify: task('classify', 'SessionRuntime', 'decompose'),
    decompose: task('decompose', 'ImplementationCoordinator', 'implement'),
    implement: task('implement', 'ImplementationCoordinator', 'parallel-review'),
    'parallel-review': {
      kind: 'parallel',
      children: ['review-spec', 'review-quality', 'review-security'],
      policy: 'continue-all',
      next: 'adversarial-loop',
    },
    'review-spec': task('review', 'ValidationService'),
    'review-quality': task('review', 'ValidationService'),
    'review-security': task('review', 'ValidationService'),
    'adversarial-loop': {
      kind: 'loop',
      innerEntry: 'adversarial-challenge',
      exitOn: 'success',
      maxIterations: 3,
      iterationLabelPrefix: 'adversarial',
      next: 'holdout',
    },
    'adversarial-challenge': task('review', 'ValidationService'),
    holdout: task('holdout', 'ValidationService', 'integrate'),
    integrate: task('integrate', 'ControlPlane', 'deploy'),
    deploy: task('deploy', 'ValidationService', 'test'),
    test: task('test', 'ValidationService', 'report'),
    report: task('report', 'ControlPlane'),
  },
  labelMap: {
    detect: 'detect',
    classify: 'classify',
    decompose: 'decompose',
    implement: 'implement',
    'parallel-review': 'review',
    'review-spec': 'review:spec',
    'review-quality': 'review:quality',
    'review-security': 'review:security',
    'adversarial-loop': 'adversarial-loop',
    'adversarial-challenge': 'adversarial:challenge',
    holdout: 'holdout',
    integrate: 'integrate',
    deploy: 'deploy',
    test: 'test',
    report: 'report',
  },
} satisfies WorkflowDefinition;

export const BUILTIN_WORKFLOWS = deepFreeze({
  feature,
  'feature-simple': featureSimple,
  bug,
  'adversarial-dev': adversarialDev,
} satisfies Record<string, WorkflowDefinition>);

export function getBuiltinWorkflow(variant: string): WorkflowDefinition | undefined {
  return BUILTIN_WORKFLOWS[variant as keyof typeof BUILTIN_WORKFLOWS];
}
