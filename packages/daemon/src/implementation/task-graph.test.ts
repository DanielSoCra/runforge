// src/implementation/task-graph.test.ts
import { describe, it, expect } from 'vitest';
import { validateTaskGraph, getUnitsByBatch, createSingleUnitGraph } from './task-graph.js';
import type { TaskGraph, Unit } from '../types.js';

const makeUnit = (id: string, batch: number, deps: string[] = []): Unit => ({
  id, title: id, specIds: [], specContent: '', expectedArtifacts: [],
  dependencies: deps, batchNumber: batch, verificationCommand: '', context: '',
});

describe('validateTaskGraph', () => {
  it('validates a correct graph', () => {
    const graph: TaskGraph = {
      issueNumber: 1, featureBranch: 'feature/1',
      units: [makeUnit('a', 0), makeUnit('b', 0), makeUnit('c', 1, ['a', 'b'])],
    };
    const result = validateTaskGraph(graph);
    expect(result.ok).toBe(true);
  });

  it('rejects empty units', () => {
    const graph: TaskGraph = { issueNumber: 1, featureBranch: 'f', units: [] };
    expect(validateTaskGraph(graph).ok).toBe(false);
  });

  it('rejects duplicate IDs', () => {
    const graph: TaskGraph = {
      issueNumber: 1, featureBranch: 'f',
      units: [makeUnit('a', 0), makeUnit('a', 0)],
    };
    const result = validateTaskGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]?.message).toContain('Duplicate');
  });

  it('rejects non-sequential batch numbers', () => {
    const graph: TaskGraph = {
      issueNumber: 1, featureBranch: 'f',
      units: [makeUnit('a', 0), makeUnit('b', 2)],
    };
    const result = validateTaskGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]?.message).toContain('sequential');
  });

  it('rejects invalid dependency references', () => {
    const graph: TaskGraph = {
      issueNumber: 1, featureBranch: 'f',
      units: [makeUnit('a', 0, ['nonexistent'])],
    };
    const result = validateTaskGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]?.message).toContain('not found');
  });

  it('rejects same-batch dependencies', () => {
    const graph: TaskGraph = {
      issueNumber: 1, featureBranch: 'f',
      units: [makeUnit('a', 0), makeUnit('b', 0, ['a'])],
    };
    const result = validateTaskGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]?.message).toContain('earlier batches');
  });

  it('rejects forward dependencies (later batch depends on same/later)', () => {
    const graph: TaskGraph = {
      issueNumber: 1, featureBranch: 'f',
      units: [makeUnit('a', 0, ['b']), makeUnit('b', 1)],
    };
    const result = validateTaskGraph(graph);
    expect(result.ok).toBe(false);
  });
});

describe('getUnitsByBatch', () => {
  it('groups units by batch number in order', () => {
    const graph: TaskGraph = {
      issueNumber: 1, featureBranch: 'f',
      units: [makeUnit('c', 1), makeUnit('a', 0), makeUnit('b', 0)],
    };
    const batches = getUnitsByBatch(graph);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.map((u) => u.id).sort()).toEqual(['a', 'b']);
    expect(batches[1]?.map((u) => u.id)).toEqual(['c']);
  });
});

describe('createSingleUnitGraph', () => {
  it('creates a valid single-unit graph', () => {
    const graph = createSingleUnitGraph(42, 'feature/42', 'Test', 'context');
    expect(graph.units).toHaveLength(1);
    expect(validateTaskGraph(graph).ok).toBe(true);
  });
});
