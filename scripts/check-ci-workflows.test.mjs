import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinuxOnlyContainerHits, findMainConcurrencyViolations } from './check-ci-workflows.mjs';

// --- services: (job-level service containers) ---

test('flags a job-level services: block', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    runs-on: self-hosted',
    '    services:',
    '      postgres:',
    '        image: postgres:18-alpine',
  ].join('\n');
  const hits = findLinuxOnlyContainerHits(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 4);
  assert.equal(hits[0].kind, 'services');
});

test('ignores a commented-out services: key', () => {
  const yaml = ['jobs:', '  ci:', '    # services:', '    #   postgres:'].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('ignores an inline services: value (not a container block)', () => {
  // `services: []` / `services: {}` declares no containers — not a Linux-only block.
  const yaml = ['jobs:', '  ci:', '    services: []'].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('does not match a different key ending in services', () => {
  const yaml = ['jobs:', '  ci:', '    extra_services:', '      foo: bar'].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('does not match a top-level (unindented) services key', () => {
  // services is only valid as a job key; an unindented occurrence is not a block.
  assert.equal(findLinuxOnlyContainerHits('services:\n', 'x.yml').length, 0);
});

test('flags multiple services: blocks across jobs', () => {
  const yaml = [
    'jobs:',
    '  a:',
    '    services:',
    '      pg: { image: postgres }',
    '  b:',
    '    services:',
    '      redis: { image: redis }',
  ].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 2);
});

// --- container: (job-level / step-level container) ---

test('flags a job-level container: block (image on the next line)', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    runs-on: self-hosted',
    '    container:',
    '      image: node:22',
  ].join('\n');
  const hits = findLinuxOnlyContainerHits(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 4);
  assert.equal(hits[0].kind, 'container');
});

test('flags an inline container: image value', () => {
  // Unlike `services: []`, an inline `container: node:22` IS a Linux-only container.
  const yaml = ['jobs:', '  ci:', '    container: node:22'].join('\n');
  const hits = findLinuxOnlyContainerHits(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'container');
});

test('ignores a commented-out container: key', () => {
  const yaml = ['jobs:', '  ci:', '    # container: node:22'].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('does not match a different key ending in container', () => {
  const yaml = ['jobs:', '  ci:', '    devcontainer: node:22'].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

// --- uses: docker://… (Docker-action steps) ---

test('flags a step using a docker:// action', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    steps:',
    '      - uses: docker://alpine:3.20',
  ].join('\n');
  const hits = findLinuxOnlyContainerHits(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'docker-action');
});

test('flags a quoted docker:// action reference', () => {
  const yaml = ['jobs:', '  ci:', '    steps:', "      - uses: 'docker://alpine:3.20'"].join('\n');
  const hits = findLinuxOnlyContainerHits(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'docker-action');
});

test('does not match a normal marketplace action uses:', () => {
  const yaml = ['jobs:', '  ci:', '    steps:', '      - uses: actions/checkout@v4'].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('flags a docker:// action in the continuation form (name first, then uses)', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    steps:',
    '      - name: containerized step',
    '        uses: docker://alpine:3.20',
  ].join('\n');
  const hits = findLinuxOnlyContainerHits(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'docker-action');
  assert.equal(hits[0].line, 5);
});

test('does NOT flag a docker:// value under a step with: input named uses', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    steps:',
    '      - uses: some/action@v1',
    '        with:',
    '          uses: docker://alpine',
  ].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('does NOT flag a docker:// value under a step env var named uses', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    steps:',
    '      - name: x',
    '        env:',
    '          uses: docker://alpine',
  ].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('does NOT flag a flow with: mapping carrying a uses: docker value', () => {
  const yaml = ['jobs:', '  ci:', '    steps:', '      - uses: a/b@v1', '        with: { uses: docker://x }'].join(
    '\n',
  );
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

// --- the real ci.yml pattern stays clean ---

test('the real ci.yml (docker run pattern) is clean', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    runs-on: self-hosted',
    '    steps:',
    '      - name: Start Postgres',
    '        run: |',
    '          docker run -d --name pg -p 127.0.0.1::5432 postgres:18-alpine',
  ].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('a run: step that merely mentions docker:// in a string is not a uses: action', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    steps:',
    '      - run: echo "pull docker://alpine yourself"',
  ].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

// --- false positives the structural scan must NOT flag (codex review) ---

test('does NOT flag a step input named container under with:', () => {
  // `with.container` is an action input, not a job container — it sits below the
  // job-key level, so it must not be reported.
  const yaml = [
    'jobs:',
    '  ci:',
    '    steps:',
    '      - uses: some/action@v1',
    '        with:',
    '          container: my-app',
  ].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('does NOT flag container:/uses: docker:// echoed inside a run: block scalar', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    steps:',
    '      - run: |',
    '          echo "container:"',
    '          echo "uses: docker://alpine"',
    '          cat <<EOF',
    '          services:',
    '          EOF',
  ].join('\n');
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('does NOT flag a flow-mapping with-block mentioning container', () => {
  const yaml = ['jobs:', '  ci:', '    steps:', '      - uses: a/b@v1', '        with: { container: app }'].join(
    '\n',
  );
  assert.equal(findLinuxOnlyContainerHits(yaml, 'ci.yml').length, 0);
});

test('still flags a real job container: even when a later step has a with.container input', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    container: node:22',
    '    steps:',
    '      - uses: a/b@v1',
    '        with:',
    '          container: not-this-one',
  ].join('\n');
  const hits = findLinuxOnlyContainerHits(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'container');
  assert.equal(hits[0].line, 3);
});

// --- main push concurrency (top-level concurrency group) ---

test('accepts push-to-main concurrency with a conditional main sha discriminator and ref fallback', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'concurrency:',
    "  group: ci-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}",
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  ].join('\n');
  assert.equal(findMainConcurrencyViolations(yaml, 'ci.yml').length, 0);
});

test('flags push-to-main concurrency that shares one ref group on main', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'concurrency:',
    '  group: ci-${{ github.ref }}',
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  ].join('\n');
  const hits = findMainConcurrencyViolations(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 8);
});

test('flags unconditional github.sha concurrency because it breaks branch supersede cancellation', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'concurrency:',
    '  group: ci-${{ github.sha }}',
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  ].join('\n');
  const hits = findMainConcurrencyViolations(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 8);
});

test('does NOT accept a main sha discriminator that appears only in a comment', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'concurrency:',
    "  # group: ci-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}",
    '  group: ci-${{ github.ref }}',
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  ].join('\n');
  const hits = findMainConcurrencyViolations(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 9);
});

test('does NOT accept a main sha discriminator that appears only inside a run block scalar', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'concurrency:',
    '  group: ci-${{ github.ref }}',
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
    '',
    'jobs:',
    '  ci:',
    '    runs-on: self-hosted',
    '    steps:',
    '      - run: |',
    "          echo \"ci-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}\"",
  ].join('\n');
  const hits = findMainConcurrencyViolations(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 8);
});

test('ignores a workflow without a push-to-main trigger', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  pull_request:',
    '    branches: [main]',
    '',
    'concurrency:',
    '  group: ci-${{ github.ref }}',
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  ].join('\n');
  assert.equal(findMainConcurrencyViolations(yaml, 'ci.yml').length, 0);
});

test('ignores a push-to-main workflow without a concurrency block', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'jobs:',
    '  ci:',
    '    runs-on: self-hosted',
  ].join('\n');
  assert.equal(findMainConcurrencyViolations(yaml, 'ci.yml').length, 0);
});

test('flags the current ci.yml ref-only concurrency shape', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '    branches: [main]',
    '',
    'concurrency:',
    '  group: ci-${{ github.ref }}',
    '  # Cancel superseded runs on feature branches / PRs (saves runner time), but',
    '  # NEVER on main: every trunk commit must complete its own CI so a rapid merge',
    "  # train can't cancel an in-flight main run and leave that commit unverified.",
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  ].join('\n');
  const hits = findMainConcurrencyViolations(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 10);
});
