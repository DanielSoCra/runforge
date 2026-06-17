// packages/daemon/src/control-plane/lane-engine/verifier-field.test.ts
//
// Gates the additive `verifier?` field on LaneDefinitionSchema (Plan-2 prereq).
// Lives apart from the immovable schema.test.ts so the existing suite is not
// touched. The field is OPTIONAL (existing packs stay valid) but, when present,
// is the verifier-gate's own .strict() declaration — an unknown key inside it
// must fail pack activation (fail-closed, no silent self-asserted usability).
import { describe, it, expect } from 'vitest';
import { parseLaneSet } from './schema.js';

const base = {
  declaredPhases: ['velocity'],
  mostCautiousLane: 'standard',
  lanes: [
    {
      name: 'standard',
      qualify: { complexity: ['standard', 'complex'] },
      allowedPaths: ['**'],
      roleRouting: {},
      gateSet: 'g',
      mergePolicy: 'hold',
    },
  ],
} as const;

describe('LaneDefinitionSchema verifier field (additive Plan-2 prereq)', () => {
  it('accepts a lane WITH a valid verifier declaration', () => {
    const raw = structuredClone(base) as Record<string, unknown>;
    (raw.lanes as Record<string, unknown>[])[0]!.verifier = {
      kind: 'test-suite',
      invoke: { ref: 'pnpm test' },
    };
    const r = parseLaneSet(raw);
    expect(r.ok).toBe(true);
  });

  it('still accepts a lane WITHOUT a verifier (the field is optional)', () => {
    const r = parseLaneSet(structuredClone(base));
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown key inside the verifier declaration (fail-closed .strict)', () => {
    const raw = structuredClone(base) as Record<string, unknown>;
    (raw.lanes as Record<string, unknown>[])[0]!.verifier = {
      kind: 'test-suite',
      invoke: { ref: 'pnpm test' },
      trusted: true, // self-asserted usability flag — must be rejected, not stripped
    };
    const r = parseLaneSet(raw);
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid verifier kind', () => {
    const raw = structuredClone(base) as Record<string, unknown>;
    (raw.lanes as Record<string, unknown>[])[0]!.verifier = {
      kind: 'vibes-based',
      invoke: { ref: 'pnpm test' },
    };
    const r = parseLaneSet(raw);
    expect(r.ok).toBe(false);
  });
});
