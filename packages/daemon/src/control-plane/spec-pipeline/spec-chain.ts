// spec-chain.ts — Spec chain value object and validation
// Governed by: STACK-AC-SPEC-PIPELINE

import { z } from 'zod';
import type { Phase } from '../../types.js';

export type SpecLayer = 'l1' | 'l2' | 'l3';

export interface SpecReference {
  layer: SpecLayer;
  specId: string;
  filePath: string;
  branch: string;
}

export type SpecChain = SpecReference[];

const specReferenceSchema = z.object({
  layer: z.enum(['l1', 'l2', 'l3']),
  specId: z.string().min(1),
  filePath: z.string().min(1),
  branch: z.string().min(1),
});

const specChainSchema = z.array(specReferenceSchema);

/**
 * Validates a spec chain has the required layers for a target phase.
 * Returns true if valid, false if the chain is missing required layers.
 *
 * Phase requirements (from L3 spec):
 *   l2-design:     requires L1
 *   l3-generate:   requires L1 + L2
 *   l3-compliance: requires L1 + L2 + L3
 *   implement:     requires L1 + L2 + L3
 *   Other phases:  no layer requirements
 */
export function validateChainForPhase(chain: SpecChain, phase: Phase): boolean {
  const parsed = specChainSchema.safeParse(chain);
  if (!parsed.success) return false;

  const layers = new Set(chain.map(s => s.layer));

  switch (phase) {
    case 'l2-design':
      return layers.has('l1');
    case 'l3-generate':
      return layers.has('l1') && layers.has('l2');
    case 'l3-compliance':
    case 'implement':
      return layers.has('l1') && layers.has('l2') && layers.has('l3');
    default:
      return true;
  }
}

/**
 * Extracts the first SpecReference matching a given layer.
 */
export function getSpecByLayer(chain: SpecChain, layer: SpecLayer): SpecReference | undefined {
  return chain.find(s => s.layer === layer);
}

/**
 * Appends a spec reference to the chain, returning a new array.
 * Does not mutate the input chain.
 */
export function appendSpec(chain: SpecChain, ref: SpecReference): SpecChain {
  return [...chain, ref];
}
