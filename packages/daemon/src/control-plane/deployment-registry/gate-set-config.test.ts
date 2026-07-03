// packages/daemon/src/control-plane/deployment-registry/gate-set-config.test.ts
//
// Acceptance contract for the OPTIONAL `gateSets` deployment-config schema
// (XCUT P2#1). The schema validation is REAL (declarative zod over the gate-key
// vocabulary), so these cases PASS at handoff — they pin the schema shape so the
// implementer cannot weaken the gate-key validation or the optionality. (The
// genuinely-RED parts of this slice are the pure verdict and the integrate
// wiring, in their own suites.)
import { describe, it, expect } from 'vitest';
import { parseProfile } from './schema.js';

/** A structurally valid raw profile WITHOUT gateSets (the inert baseline). */
function baseProfile(): Record<string, unknown> {
  return {
    repositories: [{ owner: 'acme', name: 'auto-claude' }],
    riskPathMap: [{ paths: ['infra/**'], minLevel: 'orange' }],
    defaultMinLevel: 'green',
    laneSet: {
      declaredPhases: ['velocity'],
      mostCautiousLane: 'standard',
      lanes: [
        {
          name: 'trivial',
          qualify: { complexity: ['simple'], changeKind: ['docs'] },
          allowedPaths: ['docs/**'],
          roleRouting: { implement: 'cheap-implementer' },
          gateSet: 'gate1-deterministic-only',
          mergePolicy: 'auto',
        },
        {
          name: 'standard',
          qualify: { complexity: ['standard', 'complex'] },
          allowedPaths: ['**'],
          roleRouting: { implement: 'cheap-implementer' },
          gateSet: 'full-ladder',
          mergePolicy: 'hold',
        },
      ],
    },
    lifecycleMode: 'velocity',
    complianceReviewers: [],
    honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
    budget: 5000,
    landing: { landsOn: 'main', productionReleasePath: { kind: 'trigger-automated', trigger: 'tag-and-deploy' } },
    capabilityBindings: [],
  };
}

describe('deployment config — gateSets definitions schema', () => {
  it('a profile with a valid gateSets map parses (ok: true) and carries the definitions', () => {
    const raw = {
      ...baseProfile(),
      gateSets: {
        'gate1-deterministic-only': { required: ['deterministic'] },
        'full-ladder': {
          required: ['deterministic', 'spec-compliance', 'quality', 'security', 'holdout'],
        },
      },
    };
    const r = parseProfile('dep-a', raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile.gateSets?.['gate1-deterministic-only']?.required).toEqual([
        'deterministic',
      ]);
      expect(r.profile.gateSets?.['full-ladder']?.required).toContain('holdout');
    }
  });

  it('a profile WITHOUT gateSets is valid (the field is optional ⇒ feature inert)', () => {
    const r = parseProfile('dep-a', baseProfile());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.gateSets).toBeUndefined();
  });

  it('rejects an unknown gate key in a required list (fail-closed, names the offender)', () => {
    const raw = {
      ...baseProfile(),
      gateSets: {
        'full-ladder': { required: ['deterministic', 'lint'] }, // 'lint' is not a gate key
      },
    };
    const r = parseProfile('dep-a', raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offenders.join('\n')).toContain('gateSets');
    }
  });

  it('rejects an empty required list (a gate-set demanding nothing is a config error)', () => {
    const raw = {
      ...baseProfile(),
      gateSets: { 'empty-set': { required: [] } },
    };
    const r = parseProfile('dep-a', raw);
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown key inside a gate-set definition (.strict envelope)', () => {
    const raw = {
      ...baseProfile(),
      gateSets: {
        'full-ladder': { required: ['deterministic'], optional: ['quality'] },
      },
    };
    const r = parseProfile('dep-a', raw);
    expect(r.ok).toBe(false);
  });

  it('the parsed gateSets definitions are deep-frozen with the profile', () => {
    const raw = {
      ...baseProfile(),
      // Both lane-referenced sets must be defined (a dangling ref is now rejected).
      gateSets: {
        'gate1-deterministic-only': { required: ['deterministic'] },
        'full-ladder': { required: ['deterministic', 'quality'] },
      },
    };
    const r = parseProfile('dep-a', raw);
    expect(r.ok).toBe(true);
    if (r.ok && r.profile.gateSets !== undefined) {
      expect(Object.isFrozen(r.profile.gateSets)).toBe(true);
      expect(Object.isFrozen(r.profile.gateSets['gate1-deterministic-only'])).toBe(true);
    }
  });

  it('rejects a DANGLING lane→gate-set reference at parse time (codex): a lane names a gate set absent from gateSets', () => {
    // The baseProfile's `standard` lane references `full-ladder`; declare gateSets
    // WITHOUT it. A dangling reference must fail pack activation (named offender),
    // not silently register and park every affected change at integrate.
    const raw = {
      ...baseProfile(),
      gateSets: { 'gate1-deterministic-only': { required: ['deterministic'] } },
    };
    const r = parseProfile('dep-a', raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offenders.join('\n')).toContain('full-ladder');
      expect(r.offenders.join('\n')).toContain('standard');
    }
  });

  it('accepts when EVERY lane gate-set reference is defined (no dangling)', () => {
    const raw = {
      ...baseProfile(),
      gateSets: {
        'gate1-deterministic-only': { required: ['deterministic'] },
        'full-ladder': { required: ['deterministic', 'quality'] },
      },
    };
    expect(parseProfile('dep-a', raw).ok).toBe(true);
  });
});
