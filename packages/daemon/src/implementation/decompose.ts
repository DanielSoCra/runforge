// src/implementation/decompose.ts
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { WorkRequest, TaskGraph } from '../types.js';
import type { RunWriter } from '../data/run-writer.js';
import { validateTaskGraph } from './task-graph.js';
import { createSingleUnitGraph } from './task-graph.js';
import { taskGraphJsonSchema } from './task-graph-schema.js';
import { ok, err, type Result } from '../lib/result.js';
import { formatUserIssueContent } from '../lib/prompt-boundary.js';
import { extractStructuredOutput } from '../lib/structured-output.js';

export async function decompose(
  request: WorkRequest,
  featureBranch: string,
  runtime: SessionRuntime,
  specContent: string,
  runWriter?: RunWriter,
  runId?: string,
  activePlugins?: Array<{ id: string; activatedAt: string }>,
): Promise<Result<TaskGraph>> {
  const workRequest = formatUserIssueContent({
    issueNumber: request.issueNumber,
    title: request.title,
    body: request.body,
  });

  // Spawn coordinator session to produce a task graph
  const result = await runtime.spawnSession(
    'coordinator',
    {
      variables: {
        workRequest,
        specs: specContent,
        specRefs: request.specRefs.join(', '),
      },
      activePlugins,
    },
    request.issueNumber,
    { jsonSchema: taskGraphJsonSchema },
    runWriter,
    runId,
  );

  if (!result.ok) return result;

  // Parse structured output as TaskGraph
  const graph = parseTaskGraph(
    extractStructuredOutput(result.value.structuredData),
    request.issueNumber,
    featureBranch,
  );
  if (!graph.ok) {
    // Retry once
    const retry = await runtime.spawnSession(
      'coordinator',
      {
        variables: {
          workRequest,
          specs: specContent,
          specRefs: request.specRefs.join(', '),
        },
        activePlugins,
      },
      request.issueNumber,
      { jsonSchema: taskGraphJsonSchema },
      runWriter,
      runId,
    );
    if (!retry.ok) return retry;
    return parseTaskGraph(
      extractStructuredOutput(retry.value.structuredData),
      request.issueNumber,
      featureBranch,
    );
  }

  return graph;
}

function parseTaskGraph(
  data: unknown,
  issueNumber: number,
  featureBranch: string,
): Result<TaskGraph> {
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
        expectedArtifacts: Array.isArray(unit.expectedArtifacts)
          ? unit.expectedArtifacts.map(String)
          : [],
        dependencies: Array.isArray(unit.dependencies)
          ? unit.dependencies.map(String)
          : [],
        batchNumber: Number(unit.batchNumber ?? 0),
        verificationCommand: String(unit.verificationCommand ?? ''),
        context: String(unit.context ?? ''),
        estimatedChangeSize: unit.estimatedChangeSize
          ? Number(unit.estimatedChangeSize)
          : undefined,
      };
    }),
  };

  const validated = validateTaskGraph(graph);
  if (!validated.ok) {
    const messages = validated.error
      .map((e) => `${e.field}: ${e.message}`)
      .join('; ');
    return err(new Error(`TaskGraph validation failed: ${messages}`));
  }

  return ok(validated.value);
}
