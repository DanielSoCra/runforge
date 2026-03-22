// context.ts — Context assembly per phase type for spec-driven pipeline
// Governed by: STACK-AC-SPEC-PIPELINE

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpecChain } from './spec-chain.js';
import { getSpecByLayer } from './spec-chain.js';

/**
 * Context for L2 design sessions.
 */
export interface L2SessionContext {
  l1Content: string;
  existingL2Specs: string[];
  feedback?: string;
}

/**
 * Context for L3 generation sessions.
 */
export interface L3SessionContext {
  l1Content: string;
  l2Content: string;
  existingL3Specs: string[];
  feedback?: string;
}

/**
 * Context for implementation sessions.
 */
export interface ImplementSessionContext {
  l1Content: string;
  l2Content: string;
  l3Content: string;
}

/**
 * Context for compliance review sessions.
 */
export interface ComplianceSessionContext {
  l1Content: string;
  l2Content: string;
  l3Content: string;
}

/**
 * Reads a spec file from the chain, resolving the path against the worktree root.
 * L3 gotcha: spec chain file paths are relative to repo root — resolve against worktreeRoot.
 */
async function readSpecFile(filePath: string, worktreeRoot: string): Promise<string> {
  const resolved = join(worktreeRoot, filePath);
  return readFile(resolved, 'utf-8');
}

/**
 * Builds context for L2 design sessions.
 * Reads L1 spec from chain, loads existing L2 specs from the architecture directory.
 */
export async function buildL2Context(
  chain: SpecChain,
  worktreeRoot: string,
  feedback?: string,
): Promise<L2SessionContext> {
  const l1Ref = getSpecByLayer(chain, 'l1');
  if (!l1Ref) throw new Error('Spec chain missing L1 reference for L2 design context');
  const l1Content = await readSpecFile(l1Ref.filePath, worktreeRoot);

  // Load existing L2 specs for pattern consistency
  const l2Dir = join(worktreeRoot, '.specify/architecture');
  const existingL2Specs: string[] = [];
  try {
    const l2Files = (await readdir(l2Dir)).filter(f => f.endsWith('.md'));
    for (const f of l2Files) {
      try {
        existingL2Specs.push(await readFile(join(l2Dir, f), 'utf-8'));
      } catch { /* skip unreadable */ }
    }
  } catch { /* directory may not exist */ }

  return { l1Content, existingL2Specs, feedback };
}

/**
 * Builds context for L3 generation sessions.
 * Reads L1 + L2 specs from chain, loads existing L3 specs from the stack directory.
 */
export async function buildL3Context(
  chain: SpecChain,
  worktreeRoot: string,
  feedback?: string,
): Promise<L3SessionContext> {
  const l1Ref = getSpecByLayer(chain, 'l1');
  const l2Ref = getSpecByLayer(chain, 'l2');
  if (!l1Ref) throw new Error('Spec chain missing L1 reference for L3 context');
  if (!l2Ref) throw new Error('Spec chain missing L2 reference for L3 context');

  const [l1Content, l2Content] = await Promise.all([
    readSpecFile(l1Ref.filePath, worktreeRoot),
    readSpecFile(l2Ref.filePath, worktreeRoot),
  ]);

  const l3Dir = join(worktreeRoot, '.specify/stack');
  const existingL3Specs: string[] = [];
  try {
    const l3Files = (await readdir(l3Dir)).filter(f => f.endsWith('.md'));
    for (const f of l3Files) {
      try {
        existingL3Specs.push(await readFile(join(l3Dir, f), 'utf-8'));
      } catch { /* skip unreadable */ }
    }
  } catch { /* directory may not exist */ }

  return { l1Content, l2Content, existingL3Specs, feedback };
}

/**
 * Builds context for implementation sessions.
 * Reads full spec chain (L1 + L2 + L3).
 */
export async function buildImplementContext(
  chain: SpecChain,
  worktreeRoot: string,
): Promise<ImplementSessionContext> {
  const l1Ref = getSpecByLayer(chain, 'l1');
  const l2Ref = getSpecByLayer(chain, 'l2');
  const l3Ref = getSpecByLayer(chain, 'l3');
  if (!l1Ref || !l2Ref || !l3Ref) {
    throw new Error('Spec chain incomplete for implementation context — requires L1 + L2 + L3');
  }

  const [l1Content, l2Content, l3Content] = await Promise.all([
    readSpecFile(l1Ref.filePath, worktreeRoot),
    readSpecFile(l2Ref.filePath, worktreeRoot),
    readSpecFile(l3Ref.filePath, worktreeRoot),
  ]);

  return { l1Content, l2Content, l3Content };
}

/**
 * Builds context for compliance review sessions.
 * Reads full spec chain (L1 + L2 + L3).
 */
export async function buildComplianceContext(
  chain: SpecChain,
  worktreeRoot: string,
): Promise<ComplianceSessionContext> {
  const l1Ref = getSpecByLayer(chain, 'l1');
  const l2Ref = getSpecByLayer(chain, 'l2');
  const l3Ref = getSpecByLayer(chain, 'l3');
  if (!l1Ref || !l2Ref || !l3Ref) {
    throw new Error('Spec chain incomplete for compliance context — requires L1 + L2 + L3');
  }

  const [l1Content, l2Content, l3Content] = await Promise.all([
    readSpecFile(l1Ref.filePath, worktreeRoot),
    readSpecFile(l2Ref.filePath, worktreeRoot),
    readSpecFile(l3Ref.filePath, worktreeRoot),
  ]);

  return { l1Content, l2Content, l3Content };
}
