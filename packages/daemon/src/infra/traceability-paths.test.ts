import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * Extract all code_paths and test_paths entries from traceability.yml.
 * Uses line-by-line parsing — no yaml dependency needed.
 */
function extractPaths(content: string): { specId: string; path: string }[] {
  const results: { specId: string; path: string }[] = [];
  let currentSpec = '';
  let inPathBlock = false;

  for (const line of content.split('\n')) {
    // Top-level spec ID (no leading whitespace, ends with colon)
    const specMatch = line.match(/^([A-Z][A-Z0-9_-]+):\s*$/);
    if (specMatch) {
      currentSpec = specMatch[1]!;
      inPathBlock = false;
      continue;
    }

    // code_paths or test_paths key — skip inline empty arrays like `[]`
    if (/^\s+(code_paths|test_paths):\s*$/.test(line)) {
      inPathBlock = true;
      continue;
    }
    if (/^\s+(code_paths|test_paths):\s*\[]/.test(line)) {
      inPathBlock = false;
      continue;
    }

    // List item under a path block
    if (inPathBlock && /^\s+-\s+/.test(line)) {
      const path = line.replace(/^\s+-\s+/, '').trim();
      if (path && currentSpec) {
        results.push({ specId: currentSpec, path });
      }
      continue;
    }

    // Any other key ends the path block
    if (/^\s+\w+:/.test(line)) {
      inPathBlock = false;
    }
  }

  return results;
}

type TraceabilityEntry = {
  id: string;
  parent?: string;
  children: string[];
  status?: string;
};

function extractEntries(content: string): Map<string, TraceabilityEntry> {
  const entries = new Map<string, TraceabilityEntry>();
  let currentSpec = '';

  for (const line of content.split('\n')) {
    const specMatch = line.match(/^([A-Z][A-Z0-9_-]+):\s*$/);
    if (specMatch) {
      currentSpec = specMatch[1]!;
      entries.set(currentSpec, { id: currentSpec, children: [] });
      continue;
    }

    if (!currentSpec) continue;
    const current = entries.get(currentSpec)!;

    const parentMatch = line.match(/^\s+parent:\s*([A-Z][A-Z0-9_-]+)/);
    if (parentMatch) {
      current.parent = parentMatch[1]!;
      continue;
    }

    const childrenMatch = line.match(/^\s+children:\s*\[(.*)\]/);
    if (childrenMatch) {
      current.children = childrenMatch[1]!
        .split(',')
        .map((child) => child.trim())
        .filter(Boolean);
      continue;
    }

    const statusMatch = line.match(/^\s+status:\s*(\w+)/);
    if (statusMatch) {
      current.status = statusMatch[1]!;
    }
  }

  return entries;
}

describe('traceability.yml path validation', () => {
  it('all code_paths and test_paths reference files that exist on disk', () => {
    const raw = readFileSync(resolve(ROOT, '.specify/traceability.yml'), 'utf-8');
    const entries = extractPaths(raw);

    const missing: string[] = [];
    for (const { specId, path } of entries) {
      // Skip glob patterns — only validate literal file paths
      if (path.includes('*')) continue;
      if (!existsSync(resolve(ROOT, path))) {
        missing.push(`${specId}: ${path}`);
      }
    }

    expect(missing, `Traceability references non-existent files:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });
});

describe('Runforge traceability tree', () => {
  it('all active Runforge L1 specs are listed under L0-AC-VISION', () => {
    const raw = readFileSync(resolve(ROOT, '.specify/traceability.yml'), 'utf-8');
    const entries = extractEntries(raw);
    const root = entries.get('L0-AC-VISION');

    expect(root, 'expected L0-AC-VISION entry in traceability').toBeDefined();

    const activeFunctionalSpecs = [...entries.values()]
      .filter((entry) => entry.id.startsWith('FUNC-AC-') && entry.status !== 'deprecated')
      .map((entry) => entry.id)
      .sort();
    const missing = activeFunctionalSpecs.filter((id) => !root!.children.includes(id));

    expect(missing, `Active Runforge L1 specs missing from L0-AC-VISION:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });
});

describe('concierge spec tree', () => {
  it('L0-CONCIERGE-VISION exists with five L1 children', () => {
    const raw = readFileSync(resolve(ROOT, '.specify/traceability.yml'), 'utf-8');
    expect(raw).toContain('L0-CONCIERGE-VISION:');
    expect(raw).toMatch(/L0-CONCIERGE-VISION:[\s\S]*?children:\s*\[FUNC-CONCIERGE-CORE.*FUNC-CONCIERGE-AWARENESS\]/);
  });

  it('all new concierge specs have entries', () => {
    const raw = readFileSync(resolve(ROOT, '.specify/traceability.yml'), 'utf-8');
    for (const id of [
      'FUNC-CONCIERGE-CORE', 'FUNC-CONCIERGE-MEMORY', 'FUNC-CONCIERGE-BOARD',
      'FUNC-CONCIERGE-CHANNEL', 'FUNC-CONCIERGE-AWARENESS',
      'ARCH-CONCIERGE-RUNTIME', 'ARCH-EVENT-BUS', 'ARCH-TOOL-REGISTRY',
      'ARCH-CONFIRMATION-LIFECYCLE',
      'STACK-CONCIERGE-NODE', 'STACK-CONCIERGE-BOARD',
    ]) {
      expect(raw, `expected ${id} in traceability`).toContain(`${id}:`);
    }
  });
});

describe('traceability parent↔child reciprocity', () => {
  // A `children` edge means ownership and must be reciprocal with the child's
  // `parent`. A node realized by an L2/L3 it does not own (a shared realization)
  // must reference it via `related`, not `children`. An L1 deliberately has no
  // `parent` (it is linked via L0's `children` array) — so a listed child with
  // no `parent` of its own is allowed; only a *differing* parent is a violation.
  it('every parent link is reciprocated, and every child link matches the child\'s parent', () => {
    const raw = readFileSync(resolve(ROOT, '.specify/traceability.yml'), 'utf-8');
    const entries = extractEntries(raw);
    const mismatches: string[] = [];

    for (const entry of entries.values()) {
      // parent → child: a node that declares a parent must be listed by it
      if (entry.parent !== undefined) {
        const parent = entries.get(entry.parent);
        if (parent && !parent.children.includes(entry.id)) {
          mismatches.push(
            `${entry.id} declares parent ${entry.parent}, but ${entry.parent}.children omits it`,
          );
        }
      }
      // child → parent: a child this node lists, if it declares a parent of its
      // own, must name this node (else it is a shared realization → use `related`)
      for (const childId of entry.children) {
        const child = entries.get(childId);
        if (child?.parent !== undefined && child.parent !== entry.id) {
          mismatches.push(
            `${entry.id} lists child ${childId}, but ${childId}.parent is ${child.parent} ` +
              `(use 'related' for non-canonical realization links)`,
          );
        }
      }
    }

    expect(
      mismatches,
      `Traceability parent↔child reciprocity violations:\n${mismatches.join('\n')}`,
    ).toEqual([]);
  });
});
