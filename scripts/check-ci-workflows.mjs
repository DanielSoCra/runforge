#!/usr/bin/env node
// Guard: the CI runner is self-hosted **macOS**, where GitHub Actions container
// features are unsupported — they fail at the "Initialize containers" step with
// "Container operations are only supported on Linux runners". This scans
// .github/workflows/*.{yml,yaml} and fails if any workflow declares a member of
// that Linux-only failure class, pointing at the `docker run` pattern used in
// ci.yml instead. (RC-1 from the CI health digest.)
//
// The failure class is broader than just `services:` — all three of these abort
// at "Initialize containers" on the macOS runner:
//   - a job-level `services:` block (service containers)
//   - a job-level `container:` (run the job inside a container)
//   - a step `uses: docker://…` (Docker-action step)
//
// No YAML dependency on purpose — line-based scan with just enough structural
// awareness to avoid false positives: `services:`/`container:` are matched ONLY
// at the job-key indent level (so a step input literally named `container:`
// under `with:` is not flagged), and block-scalar content (`run: |` …) is
// skipped (so YAML echoed inside a shell step is not flagged). This mirrors the
// line-based convention in packages/daemon/src/infra/traceability-paths.test.ts.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A job-level `services:` mapping key with no inline value — `services: []` /
// `services: {}` declares no containers, so the inline form is deliberately
// ignored. (`body` is already left-trimmed, so no leading-indent group.)
const SERVICES_KEY = /^services:\s*(#.*)?$/;

// A `container:` key, block form (`container:` then `image:` below) OR inline
// (`container: node:22`). BOTH run the job inside a Linux container, so — unlike
// `services:` — the inline form IS flagged. `^container:` (not `\w*container:`)
// rejects different keys such as `devcontainer:`.
const CONTAINER_KEY = /^container:\s*(\S.*)?$/;

// A step that runs a Docker-action: `uses: docker://<image>` (optionally quoted).
// Two forms: the `- uses:` list-item form, and a bare `uses:` continuation key of
// a step whose first key was something else (e.g. `- name:` then `uses:`). Both
// are only meaningful AT STEP LEVEL — a `uses:` nested under `with:`/`env:` is an
// action input / env var, not a Docker action, and must NOT be flagged.
const DOCKER_USES_DASH = /^-\s+uses:\s*['"]?docker:\/\//;
const DOCKER_USES_CONT = /^uses:\s*['"]?docker:\/\//;

// A line that opens a YAML block scalar (`key: |`, `key: >-`, …). Its more-
// indented continuation lines are literal text, not mapping keys, and must be
// skipped so echoed/generated YAML inside a `run:` step is not mis-flagged.
const BLOCK_SCALAR = /:\s*[|>][0-9]*[+-]?\s*(#.*)?$/;

/**
 * @param {string} content  raw workflow YAML
 * @param {string} file     filename for reporting
 * @returns {{ file: string, line: number, text: string, kind: 'services'|'container'|'docker-action' }[]}
 */
export function findLinuxOnlyContainerHits(content, file) {
  const hits = [];
  const lines = content.split('\n');

  let inJobs = false; // inside the top-level `jobs:` mapping
  let jobIdIndent = -1; // indent of job-id keys (direct children of `jobs:`)
  let jobKeyIndent = -1; // indent of job-level keys (direct children of a job-id)
  let scalarIndent = -1; // >= 0 ⇒ inside a block scalar; skip more-indented lines
  let inSteps = false; // inside a job's `steps:` sequence
  let dashIndent = -1; // indent of the current step's `- ` list marker

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;

    // Inside a block scalar: skip its (more-indented) literal content.
    if (scalarIndent >= 0) {
      if (indent > scalarIndent) continue;
      scalarIndent = -1;
    }

    const body = raw.slice(indent); // left-trimmed line content
    if (body.startsWith('#')) continue; // whole-line comment

    if (indent === 0) {
      // A top-level key resets job context; `jobs:` opens the jobs mapping.
      inJobs = /^jobs:\s*(#.*)?$/.test(body);
      jobIdIndent = -1;
      jobKeyIndent = -1;
      inSteps = false;
      dashIndent = -1;
    } else if (inJobs) {
      // Derive the structural levels from the file's own indentation style:
      // first key under `jobs:` is a job-id; first key under a job-id is the
      // job-key level (where `services:`/`container:` live).
      if (jobIdIndent === -1) jobIdIndent = indent;
      else if (indent > jobIdIndent && jobKeyIndent === -1) jobKeyIndent = indent;
      else if (indent <= jobIdIndent) {
        jobIdIndent = indent; // sibling job-id
        inSteps = false;
        dashIndent = -1;
      }

      const atJobKeyLevel = jobKeyIndent === -1 ? indent > jobIdIndent : indent === jobKeyIndent;
      if (atJobKeyLevel) {
        // A job-level key ends any previous `steps:` block; `steps:` opens one.
        inSteps = /^steps:\s*(#.*)?$/.test(body);
        if (!inSteps) dashIndent = -1;
        if (SERVICES_KEY.test(body)) hits.push({ file, line: i + 1, text: body.trim(), kind: 'services' });
        else if (CONTAINER_KEY.test(body)) hits.push({ file, line: i + 1, text: body.trim(), kind: 'container' });
      } else if (inSteps) {
        // A `uses: docker://` is a Docker action ONLY at step-key level: the
        // `- uses:` list item itself, or a `uses:` continuation key aligned with
        // the step's other keys (dash indent + 2). A deeper `uses:` is nested
        // under `with:`/`env:` — an input/var, not a Docker action — so skip it.
        if (body.startsWith('- ')) dashIndent = indent;
        const stepUses =
          DOCKER_USES_DASH.test(body) ||
          (dashIndent !== -1 && indent === dashIndent + 2 && DOCKER_USES_CONT.test(body));
        if (stepUses) hits.push({ file, line: i + 1, text: body.trim(), kind: 'docker-action' });
      }
    }

    if (BLOCK_SCALAR.test(body)) scalarIndent = indent;
  }
  return hits;
}

// Top-level `concurrency:` block in a workflow that triggers on push to main.
// GitHub allows at most ONE pending run per concurrency group; a newer run
// entering the group replace-cancels the queued one (pending-slot replacement).
// `cancel-in-progress: false` only protects the RUNNING run. The 2026-07-03
// 13:45 merge train cancelled queued runs for two trunk commits because main
// shared a single per-ref group. Workflows must therefore use a per-sha group
// CONDITIONALLY on main (`github.ref == 'refs/heads/main' && github.sha`) with
// a `|| github.ref` fallback for branches/PRs so they keep supersede-cancellation.
//
// Scope: top-level `concurrency:` of push-to-main workflows only. Job-level
// concurrency is ignored (out of scope).
const CONCURRENCY_KEY = /^concurrency:\s*(#.*)?$/;
const ON_KEY = /^on:\s*/;
const PUSH_KEY = /^push:\s*(#.*)?$/;
const BRANCHES_KEY = /^branches:\s*/;
const GROUP_KEY = /^group:\s*(\S.*)?$/;
const MAIN_SHA_DISCRIMINATOR = /github\.ref\s*==\s*['"]refs\/heads\/main['"]\s*&&\s*github\.sha/;
const REF_FALLBACK = /\|\|\s*github\.ref/;

/**
 * @param {string} content  raw workflow YAML
 * @param {string} file     filename for reporting
 * @returns {{ file: string, line: number, text: string, kind: 'main-concurrency' }[]}
 */
export function findMainConcurrencyViolations(content, file) {
  const hits = [];
  const lines = content.split('\n');

  let scalarIndent = -1;
  let onIndent = -1; // indent of top-level `on:` key
  let pushIndent = -1; // indent of `push:` under `on:`
  let branchesIndent = -1; // indent of `branches:` under `push:`
  let hasPushToMain = false;
  let pushHasBranchesFilter = false; // true once we see `branches:` under this `push:`
  let concurrencyIndent = -1; // indent of top-level `concurrency:` key
  let groupLine = -1;
  let groupText = '';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;

    // Inside a block scalar: skip its literal content.
    if (scalarIndent >= 0) {
      if (indent > scalarIndent) continue;
      scalarIndent = -1;
    }

    const body = raw.slice(indent);
    if (body.startsWith('#')) continue;

    // If we leave a `push:` block without ever seeing a `branches:` filter, the
    // push triggers on every branch — including main.
    if (onIndent !== -1 && pushIndent !== -1 && indent <= pushIndent) {
      if (!pushHasBranchesFilter) hasPushToMain = true;
      pushIndent = -1;
      branchesIndent = -1;
      pushHasBranchesFilter = false;
    }

    if (indent === 0) {
      // Top-level keys only.
      if (ON_KEY.test(body)) {
        onIndent = indent;
        pushIndent = -1;
        branchesIndent = -1;
        hasPushToMain = false;
        pushHasBranchesFilter = false;
        // Shorthand `on:` values have no nested `branches:` filter possible.
        const afterOn = body.slice(2).replace(/#.*$/, '').trim();
        if (/\bpush\b/.test(afterOn)) hasPushToMain = true;
      } else {
        onIndent = -1;
        pushIndent = -1;
        branchesIndent = -1;
        pushHasBranchesFilter = false;
        // hasPushToMain is intentionally preserved: it belongs to the preceding
        // `on:` block and is needed when the top-level `concurrency:` key follows.
      }

      if (CONCURRENCY_KEY.test(body)) {
        concurrencyIndent = indent;
        groupLine = -1;
        groupText = '';
      } else {
        concurrencyIndent = -1;
      }
    } else if (onIndent !== -1 && indent > onIndent) {
      // Inside top-level `on:` mapping.
      if (pushIndent === -1 && PUSH_KEY.test(body)) {
        pushIndent = indent;
        branchesIndent = -1;
        pushHasBranchesFilter = false;
      } else if (pushIndent !== -1) {
        if (branchesIndent === -1 && indent > pushIndent && BRANCHES_KEY.test(body)) {
          branchesIndent = indent;
          pushHasBranchesFilter = true;
          // Inline branch list like `[main]` or `[main, develop]`.
          if (/\bmain\b/.test(body)) hasPushToMain = true;
        } else if (branchesIndent !== -1 && indent > branchesIndent) {
          // Multi-line dash-form branch list (`- main`).
          if (/^-\s*main\b/.test(body)) hasPushToMain = true;
        } else if (branchesIndent !== -1 && indent <= branchesIndent) {
          // Sibling key to `branches:` under the same `push:`.
          branchesIndent = -1;
        }
      }
    } else if (concurrencyIndent !== -1 && indent > concurrencyIndent && GROUP_KEY.test(body)) {
      // First `group:` key under the top-level concurrency block.
      if (groupLine === -1) {
        groupLine = i + 1;
        groupText = body.trim();
      }
    }

    if (BLOCK_SCALAR.test(body)) scalarIndent = indent;
  }

  // Workflow ended while still inside a `push:` block that had no branches filter.
  if (onIndent !== -1 && pushIndent !== -1 && !pushHasBranchesFilter) {
    hasPushToMain = true;
  }

  if (hasPushToMain && groupLine !== -1) {
    const normalized = groupText.replace(/\s+/g, ' ');
    const hasMainSha = MAIN_SHA_DISCRIMINATOR.test(normalized);
    const hasRefFallback = REF_FALLBACK.test(normalized);
    if (!hasMainSha || !hasRefFallback) {
      hits.push({ file, line: groupLine, text: groupText, kind: 'main-concurrency' });
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
  const containerOffenders = [];
  const concurrencyOffenders = [];
  for (const f of files) {
    const content = readFileSync(resolve(dir, f), 'utf-8');
    const filePath = `.github/workflows/${f}`;
    containerOffenders.push(...findLinuxOnlyContainerHits(content, filePath));
    concurrencyOffenders.push(...findMainConcurrencyViolations(content, filePath));
  }
  let failed = false;
  if (containerOffenders.length > 0) {
    console.error(
      'check-ci-workflows: found Linux-only container usage in workflow(s).\n' +
        'The CI runner is self-hosted macOS, where Actions container features\n' +
        '(`services:`, job `container:`, and `uses: docker://…` steps) fail at\n' +
        '"Initialize containers" (Container operations are only supported on Linux\n' +
        'runners). Start dependencies with `docker run` on a random host port instead\n' +
        '(see the "Start Postgres" step in .github/workflows/ci.yml).\n',
    );
    for (const o of containerOffenders) {
      console.error(`  ${o.file}:${o.line}  [${o.kind}]  ${o.text}`);
    }
    failed = true;
  }
  if (concurrencyOffenders.length > 0) {
    console.error(
      'check-ci-workflows: found main-branch concurrency group violation(s).\n' +
        'On 2026-07-03 13:45 a 3-commit merge train cancelled queued runs for two\n' +
        'trunk commits because main shared a single per-ref concurrency group.\n' +
        'Workflows that trigger on push to main must use a per-sha group on main:\n' +
        "  group: ci-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}\n" +
        'See .github/workflows/ci.yml for the current reference shape.\n',
    );
    for (const o of concurrencyOffenders) {
      console.error(`  ${o.file}:${o.line}  [${o.kind}]  ${o.text}`);
    }
    failed = true;
  }
  if (failed) return 1;
  console.log(`check-ci-workflows: ${files.length} workflow file(s) clean — no Linux-only container or main-concurrency issues.`);
  return 0;
}

// Run the CLI only when invoked directly (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
