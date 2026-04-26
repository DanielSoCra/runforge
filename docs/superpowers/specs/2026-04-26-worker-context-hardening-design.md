# Worker Context Hardening — Design

**Status:** Draft
**Date:** 2026-04-26
**Owner:** the Operator + Claude (Codex-specified follow-up to fix/silent-prompt-vars)
**Closes:** none yet (follow-up advisory from Codex review of 53e24da)

## Problem

The fix/silent-prompt-vars branch (merged 53e24da) closed the silent variable drop class for L2/L3/compliance prompts but explicitly left worker out of scope. Codex's deep review confirmed: the worker code path still feeds simple-complexity sessions empty `specContent` and empty `verificationCommand`, so worker agents implement bugs without seeing specs or how to verify their work. This is the dominant cause of the daemon's "failed implementation restarts" behavior on stuck issues.

### Concrete code-level bugs

1. **`createSingleUnitGraph()`** (`packages/daemon/src/implementation/task-graph.ts:75-96`) hardcodes `specContent: ''` and `verificationCommand: ''` regardless of what the caller knows.
2. **`ImplementationCoordinator.implement()`** (`packages/daemon/src/implementation/coordinator.ts:50-56`) accepts `options.specContent` but never threads it into the simple-complexity branch (`createSingleUnitGraph(...)`). The decompose path (line 62) passes it correctly.
3. **`worker` and `bug-worker` prompts are not in `PROMPT_CONTRACTS`** — so the registry/startup-validation safety net we just built doesn't apply to them. Future drift in either template would not fail CI or boot.

## Goal

After this branch:
1. `createSingleUnitGraph()` accepts `specContent` and `verificationCommand` parameters.
2. `coordinator.implement()` passes `options.specContent` + a sensible default `verificationCommand` into the simple-complexity branch.
3. `worker` and `bug-worker` are registered in `PROMPT_CONTRACTS` with the variables their callers actually pass; `pitfalls` has a default `''`.
4. Worker agents on simple-complexity issues receive non-empty spec content and a runnable verification command.
5. Daemon startup validation now confirms 5 prompts (was 3).
6. `fix.ts` no longer passes the redundant `findings` variable to worker — `findingsText` is already embedded in `taskContext` (Codex review catch — would be silent drop under the new contract).
7. Existing `runtime.test.ts` tests that spawn `worker` with empty/partial variables are updated to pass valid contract vars (otherwise the new contract throws in test mode).

## Non-Goals

- Not changing the prompt content of `worker.md` or `bug-worker.md` — they already reference all 4 variables they receive.
- Not changing the decompose path — it already passes `specContent` correctly.
- Not adding wrapper blocks (`<work-request>`, `<spec-context>`) to worker prompts in this branch — that's a separate prompt-injection concern, follow-up.
- Not onboarding other prompts (classifier, reviewer-*, coordinator, etc.) into the registry — a longer follow-up.

## Approach

### Layer 1: Prompt contract registration

Add two entries to `PROMPT_CONTRACTS` in `packages/daemon/src/knowledge/prompt-contracts.ts`:

```ts
'worker': {
  variables: ['task', 'specs', 'verification', 'pitfalls'],
  defaults: { pitfalls: '' },
},
'bug-worker': {
  variables: ['bugReport', 'diagnosis', 'specs', 'pitfalls'],
  defaults: { pitfalls: '' },
},
```

Tests in `prompt-contracts.test.ts`:
- Both contracts present with the expected vars
- Disk-equality assertion picks them up (the test loops over registry entries)
- `validatePromptContracts` now returns `checked: 5`

### Layer 2: `createSingleUnitGraph` parameters

Extend the signature to accept the missing context:

```ts
export function createSingleUnitGraph(
  issueNumber: number,
  featureBranch: string,
  title: string,
  context: string,
  specContent: string = '',
  verificationCommand: string = 'pnpm -r typecheck && pnpm -r test',
): TaskGraph
```

Defaults preserve backward compatibility for any existing test caller. The verification command default is `pnpm -r typecheck && pnpm -r test` — a valid repo-root shell command that every package supports. Note: the daemon does NOT execute this directly; it is passed into the worker prompt as instruction text (`{{verification}}`), and the worker agent runs it as part of its TDD protocol. This default replaces the prior empty string so simple-complexity workers have a runnable verification step instead of guessing.

Tests in `task-graph.test.ts`:
- Pass-through of specContent and verificationCommand into the unit
- Defaults applied when omitted

### Layer 3: `coordinator.implement()` wiring

In the simple-complexity branch (lines 50-56), thread the available options:

```ts
graph = createSingleUnitGraph(
  request.issueNumber,
  featureBranch,
  request.title,
  `Title: ${request.title}\n\n${request.body}`,
  options?.specContent ?? '',
  // verification command: leave to default unless caller specifies (future option)
);
```

Tests in `coordinator.test.ts` (or wherever simple-complexity is exercised):
- `implement(request, branch, ..., { complexity: 'simple', specContent: 'L1 spec body' })` produces a graph whose unit has `specContent === 'L1 spec body'`.
- `implement(request, branch, ..., { complexity: 'simple' })` (no specContent) produces a graph whose unit has `specContent === ''` (preserves current behavior).

## Components Affected

| File | Change | Spec governance |
|---|---|---|
| `packages/daemon/src/knowledge/prompt-contracts.ts` | Add `worker` + `bug-worker` entries | STACK-AC-KNOWLEDGE |
| `packages/daemon/src/knowledge/prompt-contracts.test.ts` | Update registry-shape tests + adjust `checked` count | STACK-AC-KNOWLEDGE |
| `packages/daemon/src/implementation/task-graph.ts` | Add params to `createSingleUnitGraph` | STACK-AC-IMPLEMENTATION-COORDINATOR |
| `packages/daemon/src/implementation/task-graph.test.ts` | New tests for new params | STACK-AC-IMPLEMENTATION-COORDINATOR |
| `packages/daemon/src/implementation/coordinator.ts` | Pass `options.specContent` into simple-complexity graph | STACK-AC-IMPLEMENTATION-COORDINATOR |
| `packages/daemon/src/implementation/coordinator.test.ts` | New tests for simple-complexity spec passthrough | STACK-AC-IMPLEMENTATION-COORDINATOR |

No new files. No new specs.

## Acceptance Criteria

1. `worker` and `bug-worker` appear in `PROMPT_CONTRACTS` with correct variables.
2. `prompt-contracts.test.ts` `validatePromptContracts` test asserts `checked === 5`.
3. `prompt-contracts.test.ts` registry-shape test asserts both new entries.
4. `createSingleUnitGraph()` accepts and stores `specContent` and `verificationCommand`.
5. `coordinator.implement()` simple-complexity branch passes `options.specContent` through.
6. Default verification command is `pnpm -r typecheck && pnpm -r test`.
7. Full daemon test suite green; full `pnpm -r typecheck` green.
8. Daemon boot log shows `[daemon] Prompt contracts validated (5 prompts)` after restart.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Registering `worker` strict-mode in test could break existing test calls that omit some vars. | All existing callers in `batch.ts` pass `task, specs, verification, pitfalls` (or the bug variant set). The contract has `pitfalls` default. The runtime test calls (`{ task: 'do it' }`) are unregistered-prompt callers OR pass full vars; check before commit. |
| Default verification command might fail in environments where pnpm isn't present. | The daemon already requires pnpm (cloud-init installs it; `infra/pnpm-version-consistency.test.ts` enforces version). If pnpm is unavailable, the worker session's verification step would fail — but that's a sane signal, not a silent corruption. |
| Other simple-complexity test setups could break if they relied on empty `specContent`. | Existing default keeps behavior identical when the option is omitted. Only new behavior: when caller passes `options.specContent`, it's threaded through. |

## Codex Sparring

Codex GPT-5.5 specified this scope explicitly in his advisory after reviewing fix/silent-prompt-vars. The 4 items listed (register contract, default pitfalls, pass spec into createSingleUnitGraph, default verification command) map 1:1 to Layers 1-3 above. Per-commit Codex review will continue (same pattern as silent-prompt-vars).
