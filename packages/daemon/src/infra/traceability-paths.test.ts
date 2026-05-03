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
