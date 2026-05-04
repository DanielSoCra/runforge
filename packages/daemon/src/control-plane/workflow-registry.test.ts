import { describe, expect, it } from 'vitest';
import { BUILTIN_WORKFLOWS } from './builtin-workflows.js';
import { createWorkflowRegistry } from './workflow-registry.js';

describe('workflow registry', () => {
  it('registers built-in workflows', () => {
    const registry = createWorkflowRegistry();

    expect(registry.get('feature')).toBe(BUILTIN_WORKFLOWS.feature);
    expect(registry.get('feature-simple')).toBe(BUILTIN_WORKFLOWS['feature-simple']);
    expect(registry.get('bug')).toBe(BUILTIN_WORKFLOWS.bug);
    expect(registry.get('adversarial-dev')).toBe(BUILTIN_WORKFLOWS['adversarial-dev']);
  });

  it('falls back from adversarial-dev until required capabilities exist', () => {
    const registry = createWorkflowRegistry();

    const selected = registry.resolve('adversarial-dev', {});

    expect(selected.workflow).toBe(BUILTIN_WORKFLOWS.feature);
    expect(selected.selectedVariant).toBe('feature');
    expect(selected.requestedVariant).toBe('adversarial-dev');
    expect(selected.fallbackReason).toContain('adversarial-dev requires adversarial reviewer and model tiering');
  });

  it('keeps adversarial-dev when required capabilities exist', () => {
    const registry = createWorkflowRegistry();

    const selected = registry.resolve('adversarial-dev', {
      adversarialReviewer: true,
      modelTiering: true,
    });

    expect(selected.workflow).toBe(BUILTIN_WORKFLOWS['adversarial-dev']);
    expect(selected.selectedVariant).toBe('adversarial-dev');
    expect(selected.fallbackReason).toBeUndefined();
  });
});
