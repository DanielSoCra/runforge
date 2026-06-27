#!/usr/bin/env node
// Guard: the CI runner is self-hosted **macOS**, where GitHub Actions service
// containers (`services:` job key) are unsupported — they fail at the
// "Initialize containers" step with "Container operations are only supported on
// Linux runners". This scans .github/workflows/*.{yml,yaml} and fails if any
// declares a job-level `services:` block, pointing at the `docker run` pattern
// used in ci.yml instead. (RC-1 from the CI health digest.)
//
// No YAML dependency on purpose — line-based scan, matching the convention in
// packages/daemon/src/infra/traceability-paths.test.ts.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A job-level `services:` mapping key: leading indentation, the bare key
// `services:` with no inline value, optional trailing comment, end of line.
// Deliberately does NOT match `services: [..]` (inline value), `myservices:`
// (different key), or `# services:` (commented out).
const SERVICES_KEY = /^(\s+)services:\s*(#.*)?$/;

/**
 * @param {string} content  raw workflow YAML
 * @param {string} file     filename for reporting
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function findServicesBlocks(content, file) {
  const hits = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('#')) continue; // skip whole-line comments
    if (SERVICES_KEY.test(line)) {
      hits.push({ file, line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const dir = resolve(root, '.github/workflows');
  if (!existsSync(dir)) {
    console.log('check-ci-workflows: no .github/workflows directory — nothing to check.');
    return 0;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const offenders = [];
  for (const f of files) {
    const content = readFileSync(resolve(dir, f), 'utf-8');
    offenders.push(...findServicesBlocks(content, `.github/workflows/${f}`));
  }
  if (offenders.length > 0) {
    console.error(
      'check-ci-workflows: found Linux-only `services:` container block(s).\n' +
        'The CI runner is self-hosted macOS, where Actions service containers fail\n' +
        'at "Initialize containers" (Container operations are only supported on Linux\n' +
        'runners). Start dependencies with `docker run` on a random host port instead\n' +
        '(see the "Start Postgres" step in .github/workflows/ci.yml).\n',
    );
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.text}`);
    }
    return 1;
  }
  console.log(`check-ci-workflows: ${files.length} workflow file(s) clean — no \`services:\` blocks.`);
  return 0;
}

// Run the CLI only when invoked directly (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
