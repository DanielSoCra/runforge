import { z } from 'zod';
import type { WorkflowNodeRunState } from '../types.js';

export type NodeId = string;
export type WorkflowNodeState = WorkflowNodeRunState;

export const ServiceOwnerSchema = z.enum([
  'ControlPlane',
  'ImplementationCoordinator',
  'ValidationService',
  'BugDiagnosisService',
  'SessionRuntime',
]);

export type ServiceOwner = z.infer<typeof ServiceOwnerSchema>;

export const TaskNodeSchema = z.object({
  kind: z.literal('task'),
  phase: z.string().min(1),
  owner: ServiceOwnerSchema,
  retryable: z.boolean().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  next: z.string().min(1).optional(),
  failNext: z.string().min(1).optional(),
});

export const ParallelNodeSchema = z.object({
  kind: z.literal('parallel'),
  children: z.array(z.string().min(1)).min(1),
  policy: z.enum(['fail-fast', 'continue-all']),
  next: z.string().min(1).optional(),
  failNext: z.string().min(1).optional(),
});

export const LoopNodeSchema = z.object({
  kind: z.literal('loop'),
  innerEntry: z.string().min(1),
  exitOn: z.enum(['success', 'max-iterations']),
  maxIterations: z.number().int().positive(),
  iterationLabelPrefix: z.string().min(1),
  next: z.string().min(1).optional(),
  failNext: z.string().min(1).optional(),
});

export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  TaskNodeSchema,
  ParallelNodeSchema,
  LoopNodeSchema,
]);

export const WorkflowDefinitionSchema = z.object({
  variant: z.string().min(1),
  entryNode: z.string().min(1),
  nodes: z.record(z.string().min(1), WorkflowNodeSchema),
  labelMap: z.record(z.string().min(1), z.string().min(1)),
});

export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type ParallelNode = z.infer<typeof ParallelNodeSchema>;
export type LoopNode = z.infer<typeof LoopNodeSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export interface WorkflowValidationResult {
  valid: boolean;
  violations: string[];
}

export function validateWorkflowDefinition(input: unknown): WorkflowValidationResult {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      violations: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }

  const definition = parsed.data;
  const violations: string[] = [];
  const nodeIds = new Set(Object.keys(definition.nodes));

  if (!nodeIds.has(definition.entryNode)) {
    violations.push(`entryNode ${definition.entryNode} does not exist`);
  }

  for (const nodeId of nodeIds) {
    if (!definition.labelMap[nodeId]) {
      violations.push(`labelMap missing node ${nodeId}`);
    }
  }

  for (const labelId of Object.keys(definition.labelMap)) {
    if (!nodeIds.has(labelId)) {
      violations.push(`labelMap references unknown node ${labelId}`);
    }
  }

  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    for (const ref of referencedNodes(node)) {
      if (!nodeIds.has(ref.id)) {
        violations.push(`node ${nodeId} references unknown ${ref.field} node ${ref.id}`);
      }
    }
  }

  const reachable = reachableNodes(definition);
  for (const nodeId of nodeIds) {
    if (!reachable.has(nodeId)) {
      violations.push(`node ${nodeId} is not reachable from entryNode ${definition.entryNode}`);
    }
  }

  if (hasCycle(definition)) {
    violations.push('workflow graph contains a cycle');
  }

  return { valid: violations.length === 0, violations };
}

export function nextNodeIds(node: WorkflowNode): NodeId[] {
  return referencedNodes(node).map((ref) => ref.id);
}

function referencedNodes(node: WorkflowNode): Array<{ field: string; id: NodeId }> {
  switch (node.kind) {
    case 'task':
      return [
        ...(node.next ? [{ field: 'next', id: node.next }] : []),
        ...(node.failNext ? [{ field: 'failNext', id: node.failNext }] : []),
      ];
    case 'parallel':
      return [
        ...node.children.map((id) => ({ field: 'children', id })),
        ...(node.next ? [{ field: 'next', id: node.next }] : []),
        ...(node.failNext ? [{ field: 'failNext', id: node.failNext }] : []),
      ];
    case 'loop':
      return [
        { field: 'innerEntry', id: node.innerEntry },
        ...(node.next ? [{ field: 'next', id: node.next }] : []),
        ...(node.failNext ? [{ field: 'failNext', id: node.failNext }] : []),
      ];
  }
}

function reachableNodes(definition: WorkflowDefinition): Set<NodeId> {
  const reachable = new Set<NodeId>();
  const stack = [definition.entryNode];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (reachable.has(nodeId)) continue;
    const node = definition.nodes[nodeId];
    if (!node) continue;
    reachable.add(nodeId);
    stack.push(...nextNodeIds(node));
  }
  return reachable;
}

function hasCycle(definition: WorkflowDefinition): boolean {
  const nodeIds = Object.keys(definition.nodes);
  const inDegree = new Map<NodeId, number>(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map<NodeId, NodeId[]>(nodeIds.map((id) => [id, []]));

  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    for (const nextId of nextNodeIds(node)) {
      if (!definition.nodes[nextId]) continue;
      adjacency.get(nodeId)!.push(nextId);
      inDegree.set(nextId, (inDegree.get(nextId) ?? 0) + 1);
    }
  }

  const queue = nodeIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  let visited = 0;

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    visited++;
    for (const nextId of adjacency.get(nodeId) ?? []) {
      const nextDegree = (inDegree.get(nextId) ?? 0) - 1;
      inDegree.set(nextId, nextDegree);
      if (nextDegree === 0) queue.push(nextId);
    }
  }

  return visited !== nodeIds.length;
}
