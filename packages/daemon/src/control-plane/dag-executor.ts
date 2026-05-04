import type { PhaseEvent, RunState, WorkflowNodeRunState } from '../types.js';
import { hashError } from './error-hash.js';
import { migrateRunStateToWorkflow } from './run-state-migration.js';
import type { TaskNode, WorkflowDefinition, WorkflowNode } from './workflow-types.js';

export type WorkflowDispatchResult =
  | PhaseEvent
  | { event: PhaseEvent; error?: unknown };

export interface WorkflowExecutionContext {
  dispatchTask(
    node: TaskNode,
    run: RunState,
    signal: AbortSignal,
    nodeId: string,
  ): Promise<WorkflowDispatchResult>;
  onNodeStart?: (nodeId: string, label: string, run: RunState) => void | Promise<void>;
}

interface NodeExecutionResult {
  event: PhaseEvent;
  succeeded: boolean;
  error?: unknown;
}

export async function* executeWorkflow(
  workflow: WorkflowDefinition,
  run: RunState,
  context: WorkflowExecutionContext,
): AsyncGenerator<RunState> {
  migrateRunStateToWorkflow(run, workflow);
  let currentNodeId: string | undefined = run.currentNodeId ?? workflow.entryNode;

  while (currentNodeId) {
    const node: WorkflowNode | undefined = workflow.nodes[currentNodeId];
    if (!node) break;

    const result = await executeNode(currentNodeId, node, workflow, run, context);
    run.currentNodeId = currentNodeId;
    run.activeNodeIds = [];
    yield run;

    currentNodeId = result.succeeded ? successNext(node) : failureNext(node);
    if (currentNodeId) {
      run.currentNodeId = currentNodeId;
    }
  }
}

async function executeNode(
  nodeId: string,
  node: WorkflowNode,
  workflow: WorkflowDefinition,
  run: RunState,
  context: WorkflowExecutionContext,
  signal?: AbortSignal,
): Promise<NodeExecutionResult> {
  switch (node.kind) {
    case 'task':
      return executeTask(nodeId, node, workflow, run, context, signal ?? new AbortController().signal);
    case 'parallel':
      return executeParallel(nodeId, node, workflow, run, context);
    case 'loop':
      return executeLoop(nodeId, node, workflow, run, context);
  }
}

async function executeTask(
  nodeId: string,
  node: TaskNode,
  workflow: WorkflowDefinition,
  run: RunState,
  context: WorkflowExecutionContext,
  signal: AbortSignal,
): Promise<NodeExecutionResult> {
  await markNodeRunning(nodeId, workflow, run, context);
  if (signal.aborted) {
    markNodeFinished(run, nodeId, 'cancelled', 'failure');
    return { event: 'failure', succeeded: false, error: 'aborted' };
  }

  const maxRetries = node.retryable === false ? 0 : node.maxRetries ?? 0;
  let attempt = 0;
  let lastResult: NodeExecutionResult = { event: 'failure', succeeded: false };

  do {
    let result: NodeExecutionResult;
    try {
      const rawResult = await context.dispatchTask(node, run, signal, nodeId);
      result = normalizeDispatchResult(rawResult);
    } catch (error) {
      result = { event: 'failure', succeeded: false, error };
    }
    attempt++;
    lastResult = result;
    const state = ensureNodeState(run, nodeId);
    state.attempts = attempt;

    if (result.succeeded) {
      markNodeFinished(run, nodeId, 'succeeded', result.event);
      return result;
    }

    if (result.error) {
      state.errorHash = hashError(result.error instanceof Error ? result.error.message : String(result.error));
    }
  } while (attempt <= maxRetries && !signal.aborted);

  markNodeFinished(run, nodeId, signal.aborted ? 'cancelled' : 'failed', lastResult.event);
  return lastResult;
}

async function executeParallel(
  nodeId: string,
  node: Extract<WorkflowNode, { kind: 'parallel' }>,
  workflow: WorkflowDefinition,
  run: RunState,
  context: WorkflowExecutionContext,
): Promise<NodeExecutionResult> {
  await markNodeRunning(nodeId, workflow, run, context);
  run.activeNodeIds = [...node.children];
  const controller = new AbortController();

  const results = await Promise.all(
    node.children.map(async (childId) => {
      const child = workflow.nodes[childId];
      if (!child) return { event: 'failure' as PhaseEvent, succeeded: false, error: `missing child ${childId}` };
      const result = await executeNode(childId, child, workflow, run, context, controller.signal);
      if (!result.succeeded && node.policy === 'fail-fast') {
        controller.abort();
      }
      return result;
    }),
  );

  const succeeded = results.every((result) => result.succeeded);
  markNodeFinished(run, nodeId, succeeded ? 'succeeded' : 'failed', succeeded ? 'success' : 'failure');
  return { event: succeeded ? 'success' : 'failure', succeeded };
}

async function executeLoop(
  nodeId: string,
  node: Extract<WorkflowNode, { kind: 'loop' }>,
  workflow: WorkflowDefinition,
  run: RunState,
  context: WorkflowExecutionContext,
): Promise<NodeExecutionResult> {
  await markNodeRunning(nodeId, workflow, run, context);
  let lastResult: NodeExecutionResult = { event: 'failure', succeeded: false };

  for (let iteration = 1; iteration <= node.maxIterations; iteration++) {
    const loopState = ensureNodeState(run, nodeId);
    loopState.iterationCount = iteration;
    resetInnerNodeState(run, node.innerEntry);
    lastResult = await runInnerWorkflow(node.innerEntry, workflow, run, context);

    if (node.exitOn === 'success' && lastResult.succeeded) {
      markNodeFinished(run, nodeId, 'succeeded', 'success');
      return { event: 'success', succeeded: true };
    }
  }

  const maxIterationSucceeded = node.exitOn === 'max-iterations' && lastResult.succeeded;
  markNodeFinished(run, nodeId, maxIterationSucceeded ? 'succeeded' : 'failed', maxIterationSucceeded ? 'success' : 'failure');
  return { event: maxIterationSucceeded ? 'success' : 'failure', succeeded: maxIterationSucceeded };
}

async function runInnerWorkflow(
  entryNodeId: string,
  workflow: WorkflowDefinition,
  run: RunState,
  context: WorkflowExecutionContext,
): Promise<NodeExecutionResult> {
  let currentNodeId: string | undefined = entryNodeId;
  let lastResult: NodeExecutionResult = { event: 'success', succeeded: true };

  while (currentNodeId) {
    const node: WorkflowNode | undefined = workflow.nodes[currentNodeId];
    if (!node) return { event: 'failure', succeeded: false, error: `missing inner node ${currentNodeId}` };
    lastResult = await executeNode(currentNodeId, node, workflow, run, context);
    currentNodeId = lastResult.succeeded ? successNext(node) : failureNext(node);
  }

  return lastResult;
}

async function markNodeRunning(
  nodeId: string,
  workflow: WorkflowDefinition,
  run: RunState,
  context: WorkflowExecutionContext,
): Promise<void> {
  const state = ensureNodeState(run, nodeId);
  state.status = 'running';
  state.startedAt = state.startedAt ?? new Date().toISOString();
  state.completedAt = undefined;
  run.currentNodeId = nodeId;
  run.activeNodeIds = [nodeId];
  await context.onNodeStart?.(nodeId, workflow.labelMap[nodeId] ?? nodeId, run);
}

function markNodeFinished(
  run: RunState,
  nodeId: string,
  status: WorkflowNodeRunState['status'],
  event: PhaseEvent,
): void {
  const state = ensureNodeState(run, nodeId);
  state.status = status;
  state.completedAt = new Date().toISOString();
  state.lastEvent = event;
}

function ensureNodeState(run: RunState, nodeId: string): WorkflowNodeRunState {
  run.nodeStates = run.nodeStates ?? {};
  run.nodeStates[nodeId] = run.nodeStates[nodeId] ?? { nodeId, status: 'pending' };
  return run.nodeStates[nodeId]!;
}

function resetInnerNodeState(run: RunState, nodeId: string): void {
  if (!run.nodeStates?.[nodeId]) return;
  run.nodeStates[nodeId] = { nodeId, status: 'pending' };
}

function normalizeDispatchResult(rawResult: WorkflowDispatchResult): NodeExecutionResult {
  const event = typeof rawResult === 'string' ? rawResult : rawResult.event;
  return {
    event,
    succeeded: event === 'success' || event === 'success:simple' || event === 'unchanged',
    error: typeof rawResult === 'string' ? undefined : rawResult.error,
  };
}

function successNext(node: WorkflowNode): string | undefined {
  switch (node.kind) {
    case 'task':
      return node.next;
    case 'parallel':
      return node.next;
    case 'loop':
      return node.next;
  }
}

function failureNext(node: WorkflowNode): string | undefined {
  switch (node.kind) {
    case 'task':
      return node.failNext;
    case 'parallel':
      return node.failNext;
    case 'loop':
      return node.failNext;
  }
}
