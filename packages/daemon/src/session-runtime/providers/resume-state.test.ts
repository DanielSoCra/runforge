// src/session-runtime/providers/resume-state.test.ts
//
// FUNC-AC-RUNTIME-ADAPTERS v2 ACCEPTANCE GATE (IMMOVABLE).
//
// Pins the resumption fail-safe (ARCH-AC-SESSION-PROVIDERS v2 — SessionResumeState,
// resolve/invalidate session continuation; STACK v2 resolveContinuation example):
//   - Continuation ONLY when same provider + same model binding + same workspace
//     identity AND validity 'valid'.
//   - Any mismatch/doubt -> fresh start WITH a recorded reason. Never resumes a
//     conversation against ground that moved or that was marked bad.
//   - Workspace identity is derived from worktree path + base commit (not path
//     alone) so a silent rebase forces a fresh start.
//   - A rejected/lost continuation invalidates with reason and degrades to fresh,
//     never an error.
//
// Pure logic — no spawn, no model. Must FAIL until resume-state.ts exists.
import { describe, expect, it } from 'vitest';
import type { ProviderDefinition } from '../../types.js';
import {
  deriveWorkspaceIdentity,
  resolveContinuation,
  invalidateContinuation,
  type SessionResumeState,
  type ContinuationDecision,
} from './resume-state.js';

const provider: ProviderDefinition = {
  name: 'codex-impl',
  adapterClass: 'process-based',
  providerKind: 'codex-cli',
  supportedModelTiers: ['higher-capability'],
  cliTool: 'codex',
  model: 'gpt-5.5',
};

const otherProvider: ProviderDefinition = {
  ...provider,
  name: 'claude-default',
  providerKind: 'claude-cli',
};

const WS = deriveWorkspaceIdentity('/work/run-1', 'base-sha-aaa');

function validState(over: Partial<SessionResumeState> = {}): SessionResumeState {
  return {
    runId: 'run-1',
    role: 'worker',
    providerName: 'codex-impl',
    modelBinding: 'gpt-5.5',
    continuationId: 'cont-abc',
    workspaceIdentity: WS,
    validity: 'valid',
    ...over,
  };
}

describe('deriveWorkspaceIdentity', () => {
  it('depends on the base commit, not the path alone (silent rebase => different identity)', () => {
    const a = deriveWorkspaceIdentity('/work/run-1', 'base-sha-aaa');
    const b = deriveWorkspaceIdentity('/work/run-1', 'base-sha-bbb');
    expect(a).not.toBe(b);
    const same = deriveWorkspaceIdentity('/work/run-1', 'base-sha-aaa');
    expect(same).toBe(a);
  });
});

describe('resolveContinuation — resume only by evidence, fail-safe by default', () => {
  it('resumes when provider, model binding, workspace identity match and state is valid', () => {
    const decision: ContinuationDecision = resolveContinuation(
      validState(),
      provider,
      'gpt-5.5',
      WS,
    );
    expect(decision.kind).toBe('resume');
    if (decision.kind === 'resume') {
      expect(decision.continuationId).toBe('cont-abc');
    }
  });

  it('forces fresh-start with a reason when no record exists', () => {
    const decision = resolveContinuation(undefined, provider, 'gpt-5.5', WS);
    expect(decision.kind).toBe('fresh');
    if (decision.kind === 'fresh') expect(decision.reason).toBe('no-record');
  });

  it('forces fresh-start when the workspace identity changed (moved/rebased ground)', () => {
    const moved = deriveWorkspaceIdentity('/work/run-1', 'base-sha-bbb');
    const decision = resolveContinuation(validState(), provider, 'gpt-5.5', moved);
    expect(decision.kind).toBe('fresh');
    if (decision.kind === 'fresh') expect(decision.reason).toBe('workspace-changed');
  });

  it('forces fresh-start when the resolved provider differs (continuations are provider-bound)', () => {
    const decision = resolveContinuation(validState(), otherProvider, 'gpt-5.5', WS);
    expect(decision.kind).toBe('fresh');
    if (decision.kind === 'fresh') expect(decision.reason).toBe('provider-changed');
  });

  it('forces fresh-start when the model binding differs', () => {
    const decision = resolveContinuation(validState(), provider, 'gpt-5.5-mini', WS);
    expect(decision.kind).toBe('fresh');
    if (decision.kind === 'fresh') expect(decision.reason).toBe('provider-changed');
  });

  it('never resumes a poisoned conversation; reports the recorded reason', () => {
    const decision = resolveContinuation(
      validState({ validity: 'invalidated-poisoned' }),
      provider,
      'gpt-5.5',
      WS,
    );
    expect(decision.kind).toBe('fresh');
    if (decision.kind === 'fresh') expect(decision.reason).toBe('poisoned');
  });

  it('a lost/rejected continuation degrades to fresh, with reason — never an error', () => {
    const decision = resolveContinuation(
      validState({ validity: 'invalidated-lost' }),
      provider,
      'gpt-5.5',
      WS,
    );
    expect(decision.kind).toBe('fresh');
    if (decision.kind === 'fresh') expect(decision.reason).toBe('record-lost');
  });
});

describe('invalidateContinuation — idempotent, records the reason', () => {
  it('marks a valid state poisoned and is idempotent', () => {
    const s = validState();
    const once = invalidateContinuation(s, 'poisoned');
    expect(once.validity).toBe('invalidated-poisoned');
    const twice = invalidateContinuation(once, 'poisoned');
    expect(twice.validity).toBe('invalidated-poisoned');
  });

  it('marks a workspace-changed invalidation', () => {
    expect(invalidateContinuation(validState(), 'workspace-changed').validity).toBe(
      'invalidated-workspace-changed',
    );
  });
});
