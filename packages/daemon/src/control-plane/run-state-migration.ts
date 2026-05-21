import type { Phase, PhaseEvent, RunState, WorkflowNodeRunState } from '../types.js';
import type { WorkflowDefinition, WorkflowNode } from './workflow-types.js';

export function migrateRunStateToWorkflow(run: RunState, workflow: WorkflowDefinition): RunState {
  const now = new Date().toISOString();
  const existingNodeStates = run.nodeStates ?? {};
  const nodeStates: Record<string, WorkflowNodeRunState> = {};
  const currentNodeId = run.currentNodeId ?? findNodeIdForPhase(workflow, run.phase) ?? workflow.entryNode;

  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    const existing = existingNodeStates[nodeId];
    if (existing) {
      nodeStates[nodeId] = existing;
      continue;
    }

    const phase = node.kind === 'task' ? node.phase : workflow.labelMap[nodeId];
    const completed = phase ? run.phaseCompletions[phase as Phase] === true : false;
    const isCurrent = nodeId === currentNodeId && run.phase !== 'paused' && run.phase !== 'stuck';
    nodeStates[nodeId] = {
      nodeId,
      status: completed ? 'succeeded' : isCurrent ? 'running' : 'pending',
      ...(completed ? { completedAt: now } : {}),
      ...(isCurrent ? { startedAt: now } : {}),
    };
  }

  run.nodeStates = nodeStates;
  run.currentNodeId = currentNodeId;
  run.activeNodeIds = run.activeNodeIds ?? (run.phase === 'paused' || run.phase === 'stuck' ? [] : [currentNodeId]);
  return run;
}

export function findNodeIdForPhase(workflow: WorkflowDefinition, phase: Phase | string): string | undefined {
  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    if (nodeMatchesPhase(workflow, nodeId, node, phase)) return nodeId;
  }
  return undefined;
}

export function markWorkflowNodeRunning(run: RunState, workflow: WorkflowDefinition, phase: Phase): void {
  const nodeId = findNodeIdForPhase(workflow, phase);
  if (!nodeId) return;
  const now = new Date().toISOString();
  const existing = run.nodeStates?.[nodeId] ?? { nodeId, status: 'pending' as const };
  run.nodeStates = {
    ...(run.nodeStates ?? {}),
    [nodeId]: {
      ...existing,
      nodeId,
      status: 'running',
      startedAt: existing.startedAt ?? now,
      completedAt: undefined,
    },
  };
  run.currentNodeId = nodeId;
  run.activeNodeIds = [nodeId];
}

export function markWorkflowNodeCompleted(
  run: RunState,
  workflow: WorkflowDefinition,
  phase: Phase,
  event: PhaseEvent,
): void {
  const nodeId = findNodeIdForPhase(workflow, phase);
  if (!nodeId) return;
  const existing = run.nodeStates?.[nodeId] ?? { nodeId, status: 'pending' as const };
  const succeeded = event === 'success' || event === 'success:simple' || event === 'unchanged';
  run.nodeStates = {
    ...(run.nodeStates ?? {}),
    [nodeId]: {
      ...existing,
      nodeId,
      status: succeeded ? 'succeeded' : 'failed',
      completedAt: new Date().toISOString(),
      lastEvent: event,
    },
  };
  run.currentNodeId = nodeId;
  run.activeNodeIds = [];
}

function nodeMatchesPhase(
  workflow: WorkflowDefinition,
  nodeId: string,
  node: WorkflowNode,
  phase: Phase | string,
): boolean {
  if (node.kind === 'task' && node.phase === phase) return true;
  return workflow.labelMap[nodeId] === phase;
}
