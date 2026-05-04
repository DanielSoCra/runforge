// src/implementation/task-graph.ts
import type { TaskGraph, Unit } from '../types.js';
import { ok, err, type Result } from '../lib/result.js';

export interface ValidationError {
  field: string;
  message: string;
}

const SAFE_UNIT_ID = /^[A-Za-z0-9_-]+$/;

export function isValidUnitId(unitId: string): boolean {
  return SAFE_UNIT_ID.test(unitId);
}

export function validateTaskGraph(graph: TaskGraph): Result<TaskGraph, ValidationError[]> {
  const errors: ValidationError[] = [];

  if (graph.units.length === 0) {
    errors.push({ field: 'units', message: 'Task graph must have at least one unit' });
    return err(errors);
  }

  // Check unique IDs
  const ids = new Set<string>();
  for (const unit of graph.units) {
    if (!isValidUnitId(unit.id)) {
      errors.push({
        field: `units[${unit.id}].id`,
        message: `Unit ID must contain only letters, numbers, hyphen, or underscore: ${unit.id}`,
      });
    }
    if (ids.has(unit.id)) {
      errors.push({ field: `units[${unit.id}].id`, message: `Duplicate unit ID: ${unit.id}` });
    }
    ids.add(unit.id);
  }

  // Check batch numbers are sequential starting from 0 or 1
  const batches = [...new Set(graph.units.map((u) => u.batchNumber))].sort((a, b) => a - b);
  const minBatch = batches[0] ?? 0;
  for (let i = 0; i < batches.length; i++) {
    if (batches[i] !== minBatch + i) {
      errors.push({ field: 'batchNumber', message: `Batch numbers must be sequential. Gap after batch ${batches[i - 1]}` });
      break;
    }
  }

  // Check dependency references are valid
  for (const unit of graph.units) {
    for (const dep of unit.dependencies) {
      if (!ids.has(dep)) {
        errors.push({ field: `units[${unit.id}].dependencies`, message: `Dependency ${dep} not found` });
      }
    }
  }

  // Check no unit depends on a unit in the same or later batch
  for (const unit of graph.units) {
    for (const dep of unit.dependencies) {
      const depUnit = graph.units.find((u) => u.id === dep);
      if (depUnit && depUnit.batchNumber >= unit.batchNumber) {
        errors.push({
          field: `units[${unit.id}].dependencies`,
          message: `Unit ${unit.id} (batch ${unit.batchNumber}) depends on ${dep} (batch ${depUnit.batchNumber}) — dependencies must be in earlier batches`,
        });
      }
    }
  }

  if (errors.length > 0) return err(errors);
  return ok(graph);
}

export function getUnitsByBatch(graph: TaskGraph): Unit[][] {
  const batchMap = new Map<number, Unit[]>();
  for (const unit of graph.units) {
    const batch = batchMap.get(unit.batchNumber) ?? [];
    batch.push(unit);
    batchMap.set(unit.batchNumber, batch);
  }
  return [...batchMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, units]) => units);
}

/** Default verification command for simple-complexity worker units.
 *  This is passed into the worker prompt as `{{verification}}` — the worker
 *  agent runs it as part of its TDD protocol. The daemon does not execute it
 *  directly. Defaults to the standard repo-root checks every package supports.
 */
export const DEFAULT_VERIFICATION_COMMAND = 'pnpm -r typecheck && pnpm -r test';

export function createSingleUnitGraph(
  issueNumber: number,
  featureBranch: string,
  title: string,
  context: string,
  specContent: string = '',
  verificationCommand: string = DEFAULT_VERIFICATION_COMMAND,
): TaskGraph {
  return {
    issueNumber,
    featureBranch,
    units: [{
      id: `issue-${issueNumber}`,
      title,
      specIds: [],
      specContent,
      expectedArtifacts: [],
      dependencies: [],
      batchNumber: 0,
      verificationCommand,
      context,
    }],
  };
}
