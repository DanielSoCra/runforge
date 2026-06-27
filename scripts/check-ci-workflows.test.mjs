import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findServicesBlocks } from './check-ci-workflows.mjs';

test('flags a job-level services: block', () => {
  const yaml = [
    'jobs:',
    '  ci:',
    '    runs-on: self-hosted',
    '    services:',
    '      postgres:',
    '        image: postgres:18-alpine',
  ].join('\n');
  const hits = findServicesBlocks(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 4);
});

test('ignores a commented-out services: key', () => {
  const yaml = ['jobs:', '  ci:', '    # services:', '    #   postgres:'].join('\n');
  assert.equal(findServicesBlocks(yaml, 'ci.yml').length, 0);
});

test('ignores an inline services: value (not a container block)', () => {
  const yaml = ['jobs:', '  ci:', '    services: []'].join('\n');
  assert.equal(findServicesBlocks(yaml, 'ci.yml').length, 0);
});

test('does not match a different key ending in services', () => {
  const yaml = ['jobs:', '  ci:', '    extra_services:', '      foo: bar'].join('\n');
  assert.equal(findServicesBlocks(yaml, 'ci.yml').length, 0);
});

test('does not match a top-level (unindented) services key', () => {
  // services is only valid as a job key; an unindented occurrence is not a block.
  assert.equal(findServicesBlocks('services:\n', 'x.yml').length, 0);
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
  assert.equal(findServicesBlocks(yaml, 'ci.yml').length, 2);
});

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
  assert.equal(findServicesBlocks(yaml, 'ci.yml').length, 0);
});
