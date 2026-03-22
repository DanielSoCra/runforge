import { describe, it, expect } from 'vitest';
import {
  mapWorkTypeToSessionType,
  getPipelineAgentDefs,
  getPipelineAgentDef,
  validatePipelineSessionTypes,
} from './session-types.js';
import type { PipelineWorkType, PipelineSessionType } from './session-types.js';

describe('mapWorkTypeToSessionType', () => {
  it('maps l2-brainstorm to l2-designer', () => {
    expect(mapWorkTypeToSessionType('l2-brainstorm')).toBe('l2-designer');
  });

  it('maps l3-generate to l3-generator', () => {
    expect(mapWorkTypeToSessionType('l3-generate')).toBe('l3-generator');
  });

  it('maps compliance-review to compliance-reviewer', () => {
    expect(mapWorkTypeToSessionType('compliance-review')).toBe('compliance-reviewer');
  });

  it('maps implementation to spec-implementer', () => {
    expect(mapWorkTypeToSessionType('implementation')).toBe('spec-implementer');
  });

  it('throws on unknown work type', () => {
    expect(() => mapWorkTypeToSessionType('unknown' as PipelineWorkType)).toThrow('Unknown pipeline work type');
  });
});

describe('getPipelineAgentDefs', () => {
  it('returns all four session types', () => {
    const defs = getPipelineAgentDefs();
    const keys = Object.keys(defs);
    expect(keys).toHaveLength(4);
    expect(keys).toContain('l2-designer');
    expect(keys).toContain('l3-generator');
    expect(keys).toContain('compliance-reviewer');
    expect(keys).toContain('spec-implementer');
  });

  it('returns frozen registry', () => {
    const defs = getPipelineAgentDefs();
    expect(() => {
      (defs as Record<string, unknown>)['new-type'] = {};
    }).toThrow();
  });

  it('each definition has required AgentDefinition fields', () => {
    const defs = getPipelineAgentDefs();
    for (const def of Object.values(defs)) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(Array.isArray(def.allowedTools)).toBe(true);
      expect(def.maxTurns).toBeGreaterThan(0);
      expect(def.timeoutMs).toBeGreaterThan(0);
      expect(def.budgetCap).toBeGreaterThan(0);
    }
  });

  it('compliance-reviewer has read-only tools (no Write/Edit/Bash)', () => {
    const def = getPipelineAgentDef('compliance-reviewer');
    expect(def.allowedTools).not.toContain('Write');
    expect(def.allowedTools).not.toContain('Edit');
    expect(def.allowedTools).not.toContain('Bash');
  });

  it('spec-implementer has write tools', () => {
    const def = getPipelineAgentDef('spec-implementer');
    expect(def.allowedTools).toContain('Write');
    expect(def.allowedTools).toContain('Edit');
    expect(def.allowedTools).toContain('Bash');
  });
});

describe('getPipelineAgentDef', () => {
  it('returns definition for valid session type', () => {
    const def = getPipelineAgentDef('l2-designer');
    expect(def.name).toBe('l2-designer');
  });

  it('throws for invalid session type', () => {
    expect(() => getPipelineAgentDef('nonexistent' as PipelineSessionType)).toThrow('No pipeline agent definition');
  });
});

describe('validatePipelineSessionTypes', () => {
  it('does not throw when all types are registered', () => {
    expect(() => validatePipelineSessionTypes()).not.toThrow();
  });
});
