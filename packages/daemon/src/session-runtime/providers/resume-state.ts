import type { ProviderDefinition } from '../../types.js';

export type SessionResumeState = {
  runId: string;
  role: string;
  providerName: string;
  modelBinding: string;
  continuationId: string;
  workspaceIdentity: string;
  validity:
    | 'valid'
    | 'invalidated-workspace-changed'
    | 'invalidated-poisoned'
    | 'invalidated-lost';
};

export type ContinuationDecision =
  | { kind: 'resume'; continuationId: string }
  | {
      kind: 'fresh';
      reason:
        | 'no-record'
        | 'workspace-changed'
        | 'provider-changed'
        | 'poisoned'
        | 'record-lost';
    };

export function deriveWorkspaceIdentity(
  path: string,
  baseCommit: string,
): string {
  return `${path}:${baseCommit}`;
}

export function resolveContinuation(
  state: SessionResumeState | undefined,
  provider: ProviderDefinition,
  modelBinding: string,
  workspaceIdentity: string,
): ContinuationDecision {
  if (state === undefined) {
    return { kind: 'fresh', reason: 'no-record' };
  }

  if (state.validity === 'invalidated-poisoned') {
    return { kind: 'fresh', reason: 'poisoned' };
  }

  if (state.validity === 'invalidated-lost') {
    return { kind: 'fresh', reason: 'record-lost' };
  }

  if (state.validity !== 'valid') {
    return { kind: 'fresh', reason: 'workspace-changed' };
  }

  if (state.providerName !== provider.name || state.modelBinding !== modelBinding) {
    return { kind: 'fresh', reason: 'provider-changed' };
  }

  if (state.workspaceIdentity !== workspaceIdentity) {
    return { kind: 'fresh', reason: 'workspace-changed' };
  }

  return { kind: 'resume', continuationId: state.continuationId };
}

export function invalidateContinuation(
  state: SessionResumeState,
  reason: 'workspace-changed' | 'poisoned' | 'record-lost',
): SessionResumeState {
  const validityMap = {
    'workspace-changed': 'invalidated-workspace-changed',
    poisoned: 'invalidated-poisoned',
    'record-lost': 'invalidated-lost',
  } as const;
  return {
    ...state,
    validity: validityMap[reason],
  };
}
