// src/implementation/decompose.ts
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { WorkRequest, TaskGraph } from '../types.js';
import { validateTaskGraph } from './task-graph.js';
import { createSingleUnitGraph } from './task-graph.js';
import { ok, err, type Result } from '../lib/result.js';

export async function decompose(
  request: WorkRequest,
  featureBranch: string,
  runtime: SessionRuntime,
  specContent: string,
): Promise<Result<TaskGraph>> {
  // Spawn coordinator session to produce a task graph
  const result = await runtime.spawnSession(
    'coordinator',
    {
      variables: {
        workRequest: `Title: ${request.title}\n\n${request.body}`,
        specs: specContent,
        specRefs: request.specRefs.join(', '),
      },
    },
    request.issueNumber,
  );

  if (!result.ok) return result;

  // Parse structured output as TaskGraph
  const graph = parseTaskGraph(result.value.structuredData, request.issueNumber, featureBranch);
  if (!graph.ok) {
    // Retry once
    const retry = await runtime.spawnSession(
      'coordinator',
      { variables: { workRequest: `Title: ${request.title}\n\n${request.body}`, specs: specContent, specRefs: request.specRefs.join(', ') } },
      request.issueNumber,
    );
    if (!retry.ok) return retry;
    return parseTaskGraph(retry.value.structuredData, request.issueNumber, featureBranch);
  }

  return graph;
}

function parseTaskGraph(data: unknown, issueNumber: number, featureBranch: string): Result<TaskGraph> {
  if (!data || typeof data !== 'object') {
    return err(new Error('Structured output is not an object'));
  }

  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.units)) {
    return err(new Error('Structured output missing units array'));
  }

  const graph: TaskGraph = {
    issueNumber,
    featureBranch,
    units: (obj.units as unknown[]).map((u, i) => {
      const unit = u as Record<string, unknown>;
      return {
        id: String(unit.id ?? `unit-${i}`),
        title: String(unit.title ?? `Unit ${i}`),
        specIds: Array.isArray(unit.specIds) ? unit.specIds.map(String) : [],
        specContent: String(unit.specContent ?? ''),
        expectedArtifacts: Array.isArray(unit.expectedArtifacts) ? unit.expectedArtifacts.map(String) : [],
        dependencies: Array.isArray(unit.dependencies) ? unit.dependencies.map(String) : [],
        batchNumber: Number(unit.batchNumber ?? 0),
        verificationCommand: String(unit.verificationCommand ?? ''),
        context: String(unit.context ?? ''),
        estimatedChangeSize: unit.estimatedChangeSize ? Number(unit.estimatedChangeSize) : undefined,
      };
    }),
  };

  const validated = validateTaskGraph(graph);
  if (!validated.ok) {
    const messages = validated.error.map((e) => `${e.field}: ${e.message}`).join('; ');
    return err(new Error(`TaskGraph validation failed: ${messages}`));
  }

  return ok(validated.value);
}
