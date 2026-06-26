// src/implementation/task-graph-schema.test.ts
// gap #1 acceptance gate: anti-drift contract between task-graph-schema.ts,
// the Unit interface (types.ts), and the coordinator.md documented wire shape.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Unit } from '../types.js';
import { UnitSchema, TaskGraphInputSchema, taskGraphJsonSchema } from './task-graph-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Extract the JSON example from coordinator.md (the documented wire contract anchor)
function loadCoordinatorExample(): { units: unknown[] } {
  const mdPath = join(__dirname, '../../../../prompts/coordinator.md');
  const content = readFileSync(mdPath, 'utf-8');
  const match = content.match(/```json\n([\s\S]+?)\n```/);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    throw new Error('coordinator.md: no ```json block found');
  }
  return JSON.parse(match[1]) as { units: unknown[] };
}

// Compile-time drift guard: if UnitSchema.shape keys diverge from the Unit
// interface, TypeScript will fail this assignment. This catches missing or
// renamed fields at tsc/typecheck time even before the test runs.
// (only enforced when task-graph-schema.ts exists — before that, the import fails)
const _unitKeyDriftGuard: Record<keyof Unit, true> = {
  id: true,
  title: true,
  specIds: true,
  specContent: true,
  expectedArtifacts: true,
  dependencies: true,
  batchNumber: true,
  verificationCommand: true,
  context: true,
  estimatedChangeSize: true,
};

// Runtime key set: must match Unit interface exactly
const UNIT_INTERFACE_KEYS = Object.keys(_unitKeyDriftGuard).sort();

describe('task-graph-schema', () => {
  describe('UnitSchema', () => {
    it('parses the coordinator.md documented example unit', () => {
      const example = loadCoordinatorExample();
      const firstUnit = example.units[0];
      const result = UnitSchema.safeParse(firstUnit);
      expect(result.success).toBe(true);
    });

    it('anti-drift: UnitSchema key set matches Unit interface AND coordinator.md example keys (no unknown keys, no missing keys)', () => {
      const schemaKeys = Object.keys(UnitSchema.shape).sort();

      // Schema keys must match Unit interface
      expect(schemaKeys).toEqual(UNIT_INTERFACE_KEYS);

      // Coordinator.md example must not contain unknown keys (all keys must be in schema)
      const example = loadCoordinatorExample();
      for (const unit of example.units) {
        const exampleKeys = Object.keys(unit as Record<string, unknown>).sort();
        for (const key of exampleKeys) {
          expect(UNIT_INTERFACE_KEYS).toContain(key);
        }
      }
    });

    it('estimatedChangeSize is optional — a unit omitting it still parses', () => {
      const unitWithoutSize = {
        id: 'u1',
        title: 'Some unit',
        specIds: ['SPEC-1'],
        specContent: 'content',
        expectedArtifacts: ['src/foo.ts'],
        dependencies: [],
        batchNumber: 0,
        verificationCommand: 'pnpm test',
        context: 'do the thing',
        // estimatedChangeSize intentionally omitted
      };
      const result = UnitSchema.safeParse(unitWithoutSize);
      expect(result.success).toBe(true);
    });

    it('rejects a unit missing a required field (id)', () => {
      const badUnit = {
        // id is missing
        title: 'Some unit',
        specIds: ['SPEC-1'],
        specContent: 'content',
        expectedArtifacts: [],
        dependencies: [],
        batchNumber: 0,
        verificationCommand: 'pnpm test',
        context: 'context',
      };
      const result = UnitSchema.safeParse(badUnit);
      expect(result.success).toBe(false);
    });

    it('rejects a unit with an extra/unknown field (additionalProperties:false in emitted JSON schema)', () => {
      // Zod v4 additionalProperties:false is enforced via toJSONSchema, but at parse time
      // Zod does NOT strip extras by default. The JSON schema emitted will have
      // additionalProperties:false which is enforced by the CLI --json-schema at runtime.
      // This test asserts the SCHEMA property, not parse behavior.
      const schema = JSON.parse(taskGraphJsonSchema) as {
        properties?: { units?: { items?: { additionalProperties?: boolean } } };
      };
      expect(schema.properties?.['units']?.items?.['additionalProperties']).toBe(false);
    });
  });

  describe('taskGraphJsonSchema', () => {
    it('is valid JSON', () => {
      expect(() => JSON.parse(taskGraphJsonSchema)).not.toThrow();
    });

    it('has additionalProperties:false at the top level', () => {
      const schema = JSON.parse(taskGraphJsonSchema) as Record<string, unknown>;
      expect(schema['additionalProperties']).toBe(false);
    });

    it('required array equals exactly ["units"] at the top level', () => {
      const schema = JSON.parse(taskGraphJsonSchema) as { required?: string[] };
      expect(schema.required).toEqual(['units']);
    });

    it('units property is an array type', () => {
      const schema = JSON.parse(taskGraphJsonSchema) as {
        properties?: { units?: { type?: string } };
      };
      expect(schema.properties?.['units']?.type).toBe('array');
    });

    it('unit items have additionalProperties:false (strict schema for coordinator output)', () => {
      const schema = JSON.parse(taskGraphJsonSchema) as {
        properties?: { units?: { items?: { additionalProperties?: boolean } } };
      };
      expect(schema.properties?.['units']?.items?.['additionalProperties']).toBe(false);
    });

    it('unit items required array excludes estimatedChangeSize (it is optional)', () => {
      const schema = JSON.parse(taskGraphJsonSchema) as {
        properties?: { units?: { items?: { required?: string[] } } };
      };
      const itemRequired = schema.properties?.['units']?.items?.required ?? [];
      expect(itemRequired).not.toContain('estimatedChangeSize');
      // But all other Unit fields must be in required
      const otherKeys = UNIT_INTERFACE_KEYS.filter((k) => k !== 'estimatedChangeSize');
      for (const key of otherKeys) {
        expect(itemRequired).toContain(key);
      }
    });

    it('rejects a graph missing the units key (top-level extra field validation)', () => {
      const badGraph = { notUnits: [] };
      const result = TaskGraphInputSchema.safeParse(badGraph);
      expect(result.success).toBe(false);
    });

    it('TaskGraphInputSchema parses a valid graph with units array', () => {
      const validGraph = {
        units: [
          {
            id: 'u1',
            title: 'Unit 1',
            specIds: ['S1'],
            specContent: 'spec',
            expectedArtifacts: ['src/x.ts'],
            dependencies: [],
            batchNumber: 0,
            verificationCommand: 'pnpm test',
            context: 'context',
          },
        ],
      };
      const result = TaskGraphInputSchema.safeParse(validGraph);
      expect(result.success).toBe(true);
    });
  });
});
