#!/usr/bin/env node
// Guard: packages/daemon/src/infra/traceability-paths.test.ts fails the build
// if .specify/traceability.yml lists a literal (non-glob) code_paths/test_paths
// entry pointing at a file that doesn't exist on disk yet — the usual trigger is
// an ahead-of-code L3 spec authored before its implementation lands. Running the
// same check here, in the pre-push hook, catches it before a CI round-trip
// instead of after. (Fixes the CI-failure class hit twice on
// spec/l3/753-spend-observability in the 2026-07-01 CI health digest.)
//
// Path-extraction logic mirrors traceability-paths.test.ts exactly — no YAML
// dependency, line-based scan.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} content
 * @returns {{ specId: string; path: string }[]}
 */
export function extractPaths(content) {
  const results = [];
  let currentSpec = '';
  let inPathBlock = false;

  for (const line of content.split('\n')) {
    const specMatch = line.match(/^([A-Z][A-Z0-9_-]+):\s*$/);
    if (specMatch) {
      currentSpec = specMatch[1];
      inPathBlock = false;
      continue;
    }

    if (/^\s+(code_paths|test_paths):\s*$/.test(line)) {
      inPathBlock = true;
      continue;
    }
    if (/^\s+(code_paths|test_paths):\s*\[]/.test(line)) {
      inPathBlock = false;
      continue;
    }

    if (inPathBlock && /^\s+-\s+/.test(line)) {
      const path = line.replace(/^\s+-\s+/, '').trim();
      if (path && currentSpec) {
        results.push({ specId: currentSpec, path });
      }
      continue;
    }

    if (/^\s+\w+:/.test(line)) {
      inPathBlock = false;
    }
  }

  return results;
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const traceabilityPath = resolve(root, '.specify/traceability.yml');
  if (!existsSync(traceabilityPath)) {
    console.log('check-traceability-paths: no .specify/traceability.yml — nothing to check.');
    return 0;
  }

  const raw = readFileSync(traceabilityPath, 'utf-8');
  const entries = extractPaths(raw);

  const missing = [];
  for (const { specId, path } of entries) {
    if (path.includes('*')) continue; // glob patterns are validated at runtime, not on disk
    if (!existsSync(resolve(root, path))) {
      missing.push(`${specId}: ${path}`);
    }
  }

  if (missing.length > 0) {
    console.error(
      'check-traceability-paths: .specify/traceability.yml references non-existent files:\n' +
        missing.map((m) => `  ${m}`).join('\n') +
        '\n\nIf this is an ahead-of-code L3 spec (status: draft), use a glob pattern\n' +
        '(e.g. `packages/{pkg}/src/{feature}/**`) instead of literal paths until the\n' +
        'implementation lands — see .specify/templates/l3-stack-specific.md.\n',
    );
    return 1;
  }

  console.log(`check-traceability-paths: ${entries.length} path entries clean.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
